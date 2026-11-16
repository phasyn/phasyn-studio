"""provider describe 與 runtime provider 清單（不載入模型；在 runtime 自己的直譯器執行）。

    <python> -m <module> --describe --provider P --settings-json @tmpfile
    <python> -m <module> --list

describe 以 (runtime_id, provider_id, digest(settings)) 快取：可用的結果保留到 Node 重啟；使用者不必重啟 Node 就能
修好的結果會重新看——describe 失敗只保留 ``FAILURE_TTL_S`` 秒（安裝套件後），provider 回報「不可用」（權重、
sidecar 或套件缺少）保留 ``UNAVAILABLE_TTL_S`` 秒，而且每次 start 都重新 describe（把檔案放好就能啟動）。
provider 清單以 TTL 快取。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.ids import is_local_id
from phasyn_components.pathscrub import mask_paths

from .config import RuntimeEntry
from .sysinfo import runtime_env

log = logging.getLogger("phasyn_node.describe")

DESCRIBE_TIMEOUT_S = 120.0
LIST_TIMEOUT_S = 180.0
FAILURE_TTL_S = 30.0
UNAVAILABLE_TTL_S = 120.0
PROVIDERS_TTL_S = 60.0
OUTPUT_LIMIT = 32 * 1024 * 1024


@dataclass(frozen=True)
class DescribeResult:
    description: dict[str, Any] | None
    error: dict[str, Any] | None
    at: float

    @property
    def ok(self) -> bool:
        return self.description is not None

    @property
    def available(self) -> bool:
        return self.description is not None and bool(self.description.get("available", False))

    def expired(self, now: float) -> bool:
        """失敗與「不可用」描述的是使用者不必重啟 Node 就能修好的狀況（安裝套件、把權重放好），超過 TTL 就重新
        describe；可用的結果保留到 Node 重啟。"""
        if self.error is not None:
            return now - self.at > FAILURE_TTL_S
        if not self.available:
            return now - self.at > UNAVAILABLE_TTL_S
        return False

    def unavailable_error(self) -> ComponentError:
        """describe 失敗或 provider 不可用 → 422（start 不會 spawn）。"""
        if self.error is not None:
            err = ComponentError.from_dict(self.error, status=422)
            return err
        desc = self.description or {}
        code = str(desc.get("unavailable_code") or "COMPONENT_NOT_CONFIGURED")
        message = str(desc.get("unavailable_reason") or "provider 目前不可用")
        return ComponentError(code, message, details={"provider_id": desc.get("provider_id")}, status=422)


@dataclass
class _ProcResult:
    returncode: int | None
    stdout: bytes
    stderr: bytes
    timed_out: bool


async def _run(argv: list[str], *, env: Mapping[str, str], timeout: float, cwd: Path) -> _ProcResult:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=dict(env),
        cwd=str(cwd),
        start_new_session=True,
        limit=OUTPUT_LIMIT,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return _ProcResult(proc.returncode, stdout, stderr, False)
    except TimeoutError:
        _kill_group(proc)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)
        return _ProcResult(proc.returncode, b"", b"", True)
    except BaseException:
        _kill_group(proc)  # 呼叫端被取消（例如 Node 關閉）：不留下自己的子程序
        raise


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)


def _last_json_line(stdout: bytes) -> dict[str, Any] | None:
    """stdout 最後一個可解析且含 ok 欄位的 JSON 行（provider import 若誤 print 也不影響）。"""
    for raw in reversed(stdout.splitlines()):
        text = raw.strip()
        if not text.startswith(b"{"):
            continue
        try:
            doc = json.loads(text)
        except ValueError:
            continue
        if isinstance(doc, dict) and "ok" in doc:
            return doc
    return None


def _stderr_tail(stderr: bytes, limit: int = 2000) -> str:
    text = stderr.decode("utf-8", "replace").strip()
    return mask_paths(text[-limit:])


def _python_name(runtime: RuntimeEntry) -> str:
    """The runtime's interpreter as shown outside the Node (no absolute path; the config has the full one)."""
    return Path(runtime.python).name or runtime.python


class RuntimeCommands:
    """describe／list 子程序；快取並合併同 key 的並行請求。"""

    def __init__(self, *, work_dir: Path, source_revision: str) -> None:
        self.work_dir = Path(work_dir)
        self.source_revision = source_revision
        self._describe_cache: dict[tuple[str, str, str], DescribeResult] = {}
        self._describe_inflight: dict[tuple[str, str, str], asyncio.Future[DescribeResult]] = {}
        self._providers: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._providers_inflight: dict[str, asyncio.Future[list[dict[str, Any]]]] = {}

    # ------------------------------------------------------------------ describe
    def cached(self, runtime_id: str, provider_id: str, settings: Mapping[str, Any]) -> DescribeResult | None:
        key = (runtime_id, provider_id, digest(settings))
        result = self._describe_cache.get(key)
        # 只有失敗（沒有描述可用）過期就不回傳；過期的「不可用」描述仍照舊回傳：它的連接埠與 schema 是停止中的 Node 最後
        # 一次推送目錄所需要的，重新 describe 的是 ``describe()``
        if result is not None and result.error is not None and result.expired(time.monotonic()):
            return None
        return result

    async def describe(
        self,
        runtime: RuntimeEntry,
        provider_id: str,
        settings: Mapping[str, Any],
        *,
        refresh_failures: bool = False,
    ) -> DescribeResult:
        """``refresh_failures``（start 用）：連還沒過期的失敗或「不可用」結果也重新 describe；可用的結果直接沿用。"""
        key = (runtime.runtime_id, provider_id, digest(settings))
        cached = self._describe_cache.get(key)
        if cached is not None:
            stale = cached.expired(time.monotonic()) or (refresh_failures and not cached.available)
            if not stale:
                return cached
        inflight = self._describe_inflight.get(key)
        if inflight is not None:
            return await asyncio.shield(inflight)
        fut: asyncio.Future[DescribeResult] = asyncio.get_running_loop().create_future()
        self._describe_inflight[key] = fut
        try:
            result = await self._describe_uncached(runtime, provider_id, settings)
            self._describe_cache[key] = result
            fut.set_result(result)
            return result
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()
            raise
        finally:
            self._describe_inflight.pop(key, None)

    async def _provider_command(
        self, runtime: RuntimeEntry, provider_id: str, settings: Mapping[str, Any], flag: str
    ) -> _ProcResult | dict[str, Any]:
        """``<python> -m <module> <flag> --provider P --settings-json @tmp``; an Error dict when it cannot start."""
        device = ((settings.get("load") or {}).get("device")) if isinstance(settings.get("load"), Mapping) else None
        env = runtime_env(runtime, device=device, source_rev=self.source_revision)
        self.work_dir.mkdir(parents=True, exist_ok=True)

        def write_tmp() -> str:
            fd, name = tempfile.mkstemp(prefix=f"{flag.lstrip('-')}-", suffix=".json", dir=str(self.work_dir))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(dict(settings), fh, ensure_ascii=False, allow_nan=False)
            return name

        tmp = await asyncio.to_thread(write_tmp)
        argv = [runtime.python, "-m", runtime.module, flag, "--provider", provider_id, "--settings-json", f"@{tmp}"]
        try:
            return await _run(argv, env=env, timeout=DESCRIBE_TIMEOUT_S, cwd=self.work_dir)
        except (FileNotFoundError, PermissionError, NotADirectoryError) as exc:
            return self._error(
                "RUNTIME_UNAVAILABLE",
                f"runtime {runtime.runtime_id} 的 python 無法執行：{_python_name(runtime)}（{type(exc).__name__}）",
                runtime=runtime,
            )
        except (OSError, ValueError) as exc:  # ValueError: an argument or variable the OS cannot take (a NUL byte)
            return self._error(
                "RUNTIME_UNAVAILABLE",
                f"runtime {runtime.runtime_id} 無法啟動：{exception_message(exc)}",
                runtime=runtime,
            )
        finally:
            with contextlib.suppress(OSError):
                os.unlink(tmp)

    async def _describe_uncached(
        self, runtime: RuntimeEntry, provider_id: str, settings: Mapping[str, Any]
    ) -> DescribeResult:
        result = await self._provider_command(runtime, provider_id, settings, "--describe")
        if isinstance(result, dict):
            return DescribeResult(None, result, time.monotonic())
        if result.timed_out:
            return self._failure(
                "RUNTIME_UNAVAILABLE",
                f"provider {provider_id} 的 describe 超過 {DESCRIBE_TIMEOUT_S:.0f} 秒未回應；已終止該子程序",
                runtime=runtime,
            )
        doc = _last_json_line(result.stdout)
        if doc is None:
            return self._failure(
                "PROVIDER_NOT_INSTALLED" if result.returncode == 1 else "RUNTIME_UNAVAILABLE",
                f"runtime {runtime.runtime_id} 無法 describe provider {provider_id}（exit code {result.returncode}）",
                runtime=runtime,
                stderr=_stderr_tail(result.stderr),
            )
        if not doc.get("ok"):
            err = doc.get("error") if isinstance(doc.get("error"), Mapping) else {}
            normalized = ComponentError.from_dict(
                err or {"code": "RUNTIME_UNAVAILABLE", "message": "describe 失敗"}
            ).to_dict()
            return DescribeResult(None, normalized, time.monotonic())
        description = doc.get("description")
        if not isinstance(description, dict):
            return self._failure("RUNTIME_UNAVAILABLE", "describe 回傳格式錯誤（缺少 description）", runtime=runtime)
        return DescribeResult(description, None, time.monotonic())

    def _failure(self, code: str, message: str, *, runtime: RuntimeEntry, stderr: str | None = None) -> DescribeResult:
        return DescribeResult(None, self._error(code, message, runtime=runtime, stderr=stderr), time.monotonic())

    def _error(self, code: str, message: str, *, runtime: RuntimeEntry, stderr: str | None = None) -> dict[str, Any]:
        details: dict[str, Any] = {
            "runtime_id": runtime.runtime_id,
            "python": _python_name(runtime),
            "module": runtime.module,
        }
        if stderr:
            details["stderr_tail"] = stderr
        log.warning("%s", message)
        return ComponentError(code, message, details=details).to_dict()

    def forget_unavailable(self) -> None:
        """Drop every failed or "unavailable" describe result (after weights were downloaded): the next describe
        looks again instead of waiting for ``UNAVAILABLE_TTL_S``."""
        for key, result in list(self._describe_cache.items()):
            if not result.available:
                del self._describe_cache[key]

    # ------------------------------------------------------------------ weights
    async def weights(self, runtime: RuntimeEntry, provider_id: str, settings: Mapping[str, Any]) -> dict[str, Any]:
        """The provider's weight plan (``--weights``); raises ComponentError.
        Not cached here: the plan's notes report files that exist right now (the caller keeps a short cache)."""
        result = await self._provider_command(runtime, provider_id, settings, "--weights")
        if isinstance(result, dict):
            raise ComponentError.from_dict(result, status=422)
        if result.timed_out:
            raise ComponentError(
                "RUNTIME_UNAVAILABLE",
                f"provider {provider_id} 的權重清單超過 {DESCRIBE_TIMEOUT_S:.0f} 秒未回應；已終止該子程序",
                details={"runtime_id": runtime.runtime_id},
            )
        doc = _last_json_line(result.stdout)
        if doc is None:
            stderr = _stderr_tail(result.stderr)
            if result.returncode == 2 and "--weights" in stderr:
                raise ComponentError(
                    "RUNTIME_UNAVAILABLE",
                    f"runtime {runtime.runtime_id} 的 phasyn-components 還不支援列出權重（--weights）：請更新這個 runtime 環境",
                    details={"runtime_id": runtime.runtime_id, "stderr_tail": stderr},
                )
            raise ComponentError(
                "PROVIDER_NOT_INSTALLED" if result.returncode == 1 else "RUNTIME_UNAVAILABLE",
                f"runtime {runtime.runtime_id} 無法列出 provider {provider_id} 的權重（exit code {result.returncode}）",
                details={"runtime_id": runtime.runtime_id, "stderr_tail": stderr},
            )
        if not doc.get("ok"):
            err = doc.get("error") if isinstance(doc.get("error"), Mapping) else {}
            raise ComponentError.from_dict(
                err or {"code": "RUNTIME_UNAVAILABLE", "message": "列出權重失敗"}, status=422
            )
        plan = doc.get("plan")
        if not isinstance(plan, dict):
            raise ComponentError("RUNTIME_UNAVAILABLE", "權重清單格式錯誤（缺少 plan）")
        return plan

    # ------------------------------------------------------------------ providers
    async def list_providers(self, runtime: RuntimeEntry, *, configured: list[str]) -> list[dict[str, Any]]:
        now = time.monotonic()
        hit = self._providers.get(runtime.runtime_id)
        if hit is not None and now - hit[0] <= PROVIDERS_TTL_S:
            return hit[1]
        inflight = self._providers_inflight.get(runtime.runtime_id)
        if inflight is not None:
            return await asyncio.shield(inflight)
        fut: asyncio.Future[list[dict[str, Any]]] = asyncio.get_running_loop().create_future()
        self._providers_inflight[runtime.runtime_id] = fut
        try:
            items = await self._list_uncached(runtime, configured=configured)
            self._providers[runtime.runtime_id] = (time.monotonic(), items)
            fut.set_result(items)
            return items
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()
            raise
        finally:
            self._providers_inflight.pop(runtime.runtime_id, None)

    async def _list_uncached(self, runtime: RuntimeEntry, *, configured: list[str]) -> list[dict[str, Any]]:
        env = runtime_env(runtime, device=None, source_rev=self.source_revision)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        reason: str
        try:
            result = await _run(
                [runtime.python, "-m", runtime.module, "--list"], env=env, timeout=LIST_TIMEOUT_S, cwd=self.work_dir
            )
        except OSError as exc:
            reason = f"runtime {runtime.runtime_id} 的 python 無法執行：{_python_name(runtime)}（{type(exc).__name__}）"
        else:
            doc = _last_json_line(result.stdout)
            if result.timed_out:
                reason = f"runtime {runtime.runtime_id} 列出 provider 超過 {LIST_TIMEOUT_S:.0f} 秒；已終止該子程序"
            elif doc is not None and doc.get("ok") and isinstance(doc.get("items"), list):
                return [self._provider_item(runtime, item) for item in doc["items"] if isinstance(item, Mapping)]
            else:
                tail = _stderr_tail(result.stderr, 500)
                reason = f"runtime {runtime.runtime_id} 無法列出 provider（exit code {result.returncode}）" + (
                    f"：{tail}" if tail else ""
                )
        log.warning("%s", reason)
        ids = sorted({p for p in configured if is_local_id(p)}) or ["unknown"]
        return [
            {
                "runtime_id": runtime.runtime_id,
                "provider_id": pid,
                "kind": "unknown",
                "label": f"{pid}（runtime {runtime.runtime_id} 無法使用）",
                "available": False,
                "reason": reason[:16000],
                "synthetic": False,
                "default_settings": None,
            }
            for pid in ids
        ]

    @staticmethod
    def _provider_item(runtime: RuntimeEntry, item: Mapping[str, Any]) -> dict[str, Any]:
        provider_id = str(item.get("provider_id") or "unknown")
        if not is_local_id(provider_id):
            provider_id = "unknown"
        defaults = item.get("default_settings")
        if defaults is not None and not contracts.is_valid("InstanceSettings", defaults):
            log.warning("provider %s 的 default_settings 不符合 InstanceSettings 契約；清單中以 null 表示", provider_id)
            defaults = None
        reason = item.get("reason")
        return {
            "runtime_id": runtime.runtime_id,
            "provider_id": provider_id,
            "kind": str(item.get("kind") or "unknown")[:160],
            "label": str(item.get("label") or provider_id)[:16000],
            "available": bool(item.get("available", False)),
            "reason": None if reason is None else str(reason)[:16000],
            "synthetic": bool(item.get("synthetic", False)),
            "default_settings": defaults,
        }


__all__ = ["DescribeResult", "RuntimeCommands"]
