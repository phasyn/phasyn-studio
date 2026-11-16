"""元件程序的 Node 端。

- 以參數陣列 spawn（沒有 shell），``start_new_session=True`` 讓每個程序自成 process group，
  終止時只對自己的 group 送訊號（``os.killpg``），永不 ``pkill python``。
- 控制通道：stdin/stdout JSON lines（``phasyn_components.ipc``）。stdin pipe 由 Node 持有：Node 消失時
  元件程序收到 EOF 自行結束。
- stderr 由背景執行緒持續排出到 ``logs/components/<id>/<process_instance_id>.stderr.log``，同時轉成
  log 事件；telemetry 走獨立 pipe FD（``pass_fds``），大量 log 不會堵住 cancel／hello。
- 中間預覽也走自己的 pipe FD（環境變數 ``PHASYN_PREVIEW_FD``）：背景執行緒讀取驗證後才交回 event loop，
  影像 bytes 不經控制通道。舊版 runtime 不認得這個變數 → 只是沒有預覽。
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import fcntl
import json
import logging
import os
import signal
import struct
import termios
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from phasyn_components.ipc import MAX_MESSAGE_BYTES, decode, encode
from phasyn_components.pathscrub import mask_paths
from phasyn_components.runtime_env import PREVIEW_FD_ENV

from .previews import NodePreview, PreviewProtocolError, PreviewRejected, drain, read_preview

log = logging.getLogger("phasyn_node.runtime")

STDERR_LINE_MAX = 64 * 1024
STDERR_TAIL_LINES = 40
TELEMETRY_LINE_MAX = 16 * 1024 * 1024
LARGE_MESSAGE_BYTES = 1024 * 1024
READER_DRAIN_TIMEOUT_S = 2.0
KILL_CONFIRM_TIMEOUT_S = 5.0

StderrSink = Callable[["RuntimeProcess", str, int, bool], None]
TelemetrySink = Callable[["RuntimeProcess", dict[str, Any]], None]
PreviewSink = Callable[["RuntimeProcess", NodePreview], None]  # 在 event loop 上呼叫
MessageHook = Callable[["RuntimeProcess", dict[str, Any]], None]
ExitHook = Callable[["RuntimeProcess"], None]


class RuntimeGone(Exception):
    """元件程序已結束或控制通道已斷。"""


class Aborted(Exception):
    """等待中被使用者的操作中止（例如 loading 時 stop）。"""


def _consume_exception(fut: asyncio.Future[Any]) -> None:
    if not fut.cancelled():
        fut.exception()


def describe_returncode(code: int | None) -> str:
    if code is None:
        return "尚未確認退出"
    if code < 0:
        try:
            name = signal.Signals(-code).name
        except ValueError:
            name = f"signal {-code}"
        return f"被訊號 {name} 終止"
    return f"exit code {code}"


class RuntimeProcess:
    """一個元件程序。所有方法都在 Node 的 event loop 上呼叫；排出 stderr／telemetry 的是背景執行緒。"""

    def __init__(
        self,
        proc: asyncio.subprocess.Process,
        *,
        component_id: str,
        process_instance_id: str,
        stderr_path: Path,
        stderr_sink: StderrSink,
        telemetry_sink: TelemetrySink,
        on_message: MessageHook,
        on_exit: ExitHook,
        preview_sink: PreviewSink | None = None,
        stderr_ref: str | None = None,
    ) -> None:
        self.proc = proc
        self.stderr_ref = stderr_ref or stderr_path.name  # how the log file is named outside the Node
        self.pid = int(proc.pid)
        self.component_id = component_id
        self.process_instance_id = process_instance_id
        self.stderr_path = stderr_path
        self._stderr_sink = stderr_sink
        self._telemetry_sink = telemetry_sink
        self._preview_sink = preview_sink
        self.previews_received = 0
        self.previews_rejected = 0
        self._on_message = on_message
        self._on_exit = on_exit
        self._loop = asyncio.get_running_loop()
        self.hello: asyncio.Future[dict[str, Any]] = self._new_future()
        self.early_error: dict[str, Any] | None = None
        self.exited = asyncio.Event()
        self.returncode: int | None = None
        self.expected_exit = False
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        self.telemetry_records = 0
        self.telemetry_dropped = 0
        self._waiters: dict[str, list[asyncio.Future[dict[str, Any]]]] = {}
        self._write_lock = asyncio.Lock()
        self._stderr_lock = threading.Lock()
        self._stderr_fd: int | None = None
        self._stderr_busy = False
        self._reader_task: asyncio.Task[None] | None = None
        self._monitor_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------ spawn
    @classmethod
    async def spawn(
        cls,
        *,
        argv: Sequence[str],
        env: Mapping[str, str],
        cwd: Path,
        component_id: str,
        process_instance_id: str,
        stderr_path: Path,
        stderr_sink: StderrSink,
        telemetry_sink: TelemetrySink,
        on_message: MessageHook,
        on_exit: ExitHook,
        preview_sink: PreviewSink | None = None,
        stderr_ref: str | None = None,
    ) -> RuntimeProcess:
        tel_r, tel_w = os.pipe()
        err_r, err_w = os.pipe()
        prev_r, prev_w = os.pipe() if preview_sink is not None else (None, None)
        child_env = dict(env)
        pass_fds = [tel_w]
        if prev_w is not None:
            child_env[PREVIEW_FD_ENV] = str(prev_w)
            pass_fds.append(prev_w)
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                "--telemetry-fd",
                str(tel_w),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=err_w,
                env=child_env,
                cwd=str(cwd),
                start_new_session=True,
                pass_fds=tuple(pass_fds),
                limit=MAX_MESSAGE_BYTES + 1,
            )
        except BaseException:
            for fd in (tel_r, tel_w, err_r, err_w, prev_r, prev_w):
                if fd is not None:
                    with contextlib.suppress(OSError):
                        os.close(fd)
            raise
        os.close(tel_w)
        os.close(err_w)
        if prev_w is not None:
            os.close(prev_w)
        runtime = cls(
            proc,
            component_id=component_id,
            process_instance_id=process_instance_id,
            stderr_path=stderr_path,
            stderr_sink=stderr_sink,
            telemetry_sink=telemetry_sink,
            on_message=on_message,
            on_exit=on_exit,
            preview_sink=preview_sink,
            stderr_ref=stderr_ref,
        )
        runtime._start_io(err_r, tel_r, prev_r)
        return runtime

    def _new_future(self) -> asyncio.Future[dict[str, Any]]:
        fut: asyncio.Future[dict[str, Any]] = self._loop.create_future()
        fut.add_done_callback(_consume_exception)
        return fut

    def _start_io(self, err_fd: int, tel_fd: int, preview_fd: int | None = None) -> None:
        self._stderr_fd = err_fd
        loops: list[tuple[str, Callable[[int], None], int]] = [
            ("stderr", self._stderr_loop, err_fd),
            ("telemetry", self._telemetry_loop, tel_fd),
        ]
        if preview_fd is not None:
            loops.append(("preview", self._preview_loop, preview_fd))
        for name, target, fd in loops:
            thread = threading.Thread(
                target=target, args=(fd,), name=f"{name}-{self.component_id}-{self.pid}", daemon=True
            )
            thread.start()
        self._reader_task = asyncio.create_task(self._read_loop(), name=f"control-{self.component_id}-{self.pid}")
        self._monitor_task = asyncio.create_task(self._monitor(), name=f"monitor-{self.component_id}-{self.pid}")

    # ------------------------------------------------------------------ state
    @property
    def alive(self) -> bool:
        return self.returncode is None and not self.exited.is_set()

    def exit_details(self) -> dict[str, Any]:
        code = self.returncode
        out: dict[str, Any] = {"exit_code": code, "pid": self.pid, "process_instance_id": self.process_instance_id}
        if code is not None and code < 0:
            out["signal"] = -code
        tail = [mask_paths(line) for line in list(self.stderr_tail)[-12:]]
        if tail:
            out["stderr_tail"] = tail
        out["stderr_log"] = self.stderr_ref
        return out

    # ------------------------------------------------------------------ control channel
    def expect(self, key: str) -> asyncio.Future[dict[str, Any]]:
        """先登記等待者再送出請求，避免回覆比登記早到。"""
        fut = self._new_future()
        if self.exited.is_set():
            fut.set_exception(RuntimeGone(f"元件程序已結束（{describe_returncode(self.returncode)}）"))
            return fut
        self._waiters.setdefault(key, []).append(fut)
        return fut

    def discard(self, key: str, fut: asyncio.Future[dict[str, Any]]) -> None:
        items = self._waiters.get(key)
        if items and fut in items:
            items.remove(fut)
            if not items:
                del self._waiters[key]
        if not fut.done():
            fut.cancel()

    def _resolve(self, key: str, message: dict[str, Any]) -> bool:
        futures = self._waiters.pop(key, [])
        for fut in futures:
            if not fut.done():
                fut.set_result(message)
        return bool(futures)

    async def send(self, message: dict[str, Any]) -> None:
        data = encode(message)
        stdin = self.proc.stdin
        if stdin is None or not self.alive:
            raise RuntimeGone(f"元件程序已結束（{describe_returncode(self.returncode)}）")
        async with self._write_lock:
            try:
                stdin.write(data)
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError, OSError) as exc:
                raise RuntimeGone(f"控制通道已斷：{type(exc).__name__}") from exc

    async def wait(
        self,
        fut: asyncio.Future[dict[str, Any]],
        *,
        timeout: float | None,
        abort: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """等回覆；程序結束 → RuntimeGone，逾時 → TimeoutError，abort → Aborted。逾時不撤銷等待者。"""
        if fut.done():
            return fut.result()
        watchers: list[asyncio.Future[Any]] = [asyncio.ensure_future(self.exited.wait())]
        if abort is not None:
            watchers.append(asyncio.ensure_future(abort.wait()))
        try:
            await asyncio.wait(
                {fut, *watchers},
                timeout=None if timeout is None else max(0.0, timeout),
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for w in watchers:
                w.cancel()
        if fut.done():
            return fut.result()
        if abort is not None and abort.is_set():
            raise Aborted()
        if self.exited.is_set():
            raise RuntimeGone(f"元件程序已結束（{describe_returncode(self.returncode)}）")
        raise TimeoutError()

    # ------------------------------------------------------------------ termination
    def signal_group(self, sig: int) -> bool:
        """只對自己 spawn 的 process group 送訊號；已被 waitpid 回收後不再送（避免 PID 重用）。"""
        if self.returncode is not None:
            return False
        try:
            os.killpg(self.pid, sig)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            log.warning("無權限對元件 %s 的 process group %s 送訊號 %s", self.component_id, self.pid, sig)
            return False

    async def wait_exit(self, timeout: float) -> bool:
        if self.exited.is_set():
            return True
        try:
            await asyncio.wait_for(self.exited.wait(), timeout=max(0.0, timeout))
            return True
        except TimeoutError:
            return False

    async def terminate(self, grace: float) -> bool:
        """SIGTERM 自有 group → grace 秒後 SIGKILL → waitpid 確認。回傳是否確認退出。"""
        self.expected_exit = True
        if self.exited.is_set():
            return True
        self.signal_group(signal.SIGTERM)
        if await self.wait_exit(grace):
            return True
        log.warning(
            "元件 %s（PID %s）在 %.0f 秒內未結束，改送 SIGKILL 給自有 process group", self.component_id, self.pid, grace
        )
        self.signal_group(signal.SIGKILL)
        return await self.wait_exit(KILL_CONFIRM_TIMEOUT_S)

    async def kill(self) -> bool:
        self.expected_exit = True
        if self.exited.is_set():
            return True
        self.signal_group(signal.SIGKILL)
        return await self.wait_exit(KILL_CONFIRM_TIMEOUT_S)

    def _stderr_unread(self) -> int:
        """stderr pipe 中尚未讀取的 bytes（排出執行緒持有 fd 時才查詢，避免查到被重用的 fd）。"""
        with self._stderr_lock:
            fd = self._stderr_fd
            if fd is None:
                return 0
            if self._stderr_busy:
                return 1
            try:
                buf = fcntl.ioctl(fd, termios.FIONREAD, b"\0\0\0\0")
            except OSError:
                return 0
            return int(struct.unpack("i", buf)[0])

    async def drain_stderr(self, timeout: float = 0.3) -> None:
        """結束一個 recording 之前，等 stderr 排出執行緒處理完已寫入的行（有上限，不阻塞呼叫結果）。"""
        deadline = self._loop.time() + timeout
        while self._stderr_unread() > 0 and self._loop.time() < deadline:
            await asyncio.sleep(0.01)

    # ------------------------------------------------------------------ loops
    async def _read_loop(self) -> None:
        stdout = self.proc.stdout
        if stdout is None:  # spawned with stdout=PIPE: a missing pipe is a programming error
            raise RuntimeError(f"component {self.component_id} has no control channel (stdout pipe)")
        while True:
            try:
                line = await stdout.readline()
            except ValueError as exc:
                log.warning("元件 %s 控制訊息超過上限而被丟棄：%s", self.component_id, exc)
                continue
            except (ConnectionResetError, OSError):
                break
            if not line:
                break
            if not line.strip():
                continue
            try:
                message = decode(line) if len(line) < LARGE_MESSAGE_BYTES else await asyncio.to_thread(decode, line)
            except ValueError as exc:
                log.warning("元件 %s 的控制通道收到無法解析的訊息：%s", self.component_id, exc)
                continue
            self._dispatch(message)

    def _dispatch(self, message: dict[str, Any]) -> None:
        kind = message["type"]
        if kind == "hello":
            if not self.hello.done():
                self.hello.set_result(message)
            return
        if kind == "error" and not self.hello.done():
            self.early_error = message
        try:
            self._on_message(self, message)
        except Exception:
            log.exception("處理元件 %s 的控制訊息 %s 時發生錯誤", self.component_id, kind)
        if kind in ("load_done", "bye", "pong"):
            self._resolve(kind, message)
        elif kind in ("run_done", "cancel_ack"):
            self._resolve(f"{kind}:{message.get('call_id')}", message)

    async def _monitor(self) -> None:
        code = await self.proc.wait()
        self.returncode = code
        if self._reader_task is not None:
            with contextlib.suppress(TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(self._reader_task), timeout=READER_DRAIN_TIMEOUT_S)
        if self.proc.stdin is not None:
            with contextlib.suppress(Exception):
                self.proc.stdin.close()
        self.exited.set()
        gone = RuntimeGone(f"元件程序已結束（{describe_returncode(code)}）")
        waiters, self._waiters = self._waiters, {}
        for futures in waiters.values():
            for fut in futures:
                if not fut.done():
                    fut.set_exception(gone)
        if not self.hello.done():
            self.hello.set_exception(gone)
        try:
            self._on_exit(self)
        except Exception:
            log.exception("處理元件 %s 程序結束時發生錯誤", self.component_id)

    def _emit_stderr(self, data: bytes, offset: int, truncated: bool) -> None:
        text = data.decode("utf-8", "replace").rstrip("\r")
        self.stderr_tail.append(text[:500])
        try:
            self._stderr_sink(self, text, offset, truncated)
        except Exception:
            log.debug("stderr 轉 log 事件失敗", exc_info=True)

    def _stderr_loop(self, fd: int) -> None:
        dst = None
        offset = 0
        try:
            self.stderr_path.parent.mkdir(parents=True, exist_ok=True)
            dst = open(self.stderr_path, "ab", buffering=0)  # noqa: SIM115 - 生命週期在本函式內
            offset = os.fstat(dst.fileno()).st_size
        except OSError as exc:
            log.warning("無法寫入元件 %s 的 stderr 檔 %s：%s", self.component_id, self.stderr_path, exc)
            dst = None
        pending = bytearray()
        line_start = offset
        skipping = False
        src = os.fdopen(fd, "rb", buffering=0)
        try:
            while True:
                try:
                    chunk = src.read(65536)
                except OSError:
                    break
                if not chunk:
                    break
                with self._stderr_lock:
                    self._stderr_busy = True
                try:
                    if dst is not None:
                        try:
                            dst.write(chunk)
                        except OSError as exc:
                            log.warning("元件 %s 的 stderr 檔寫入失敗（之後只轉 log 事件）：%s", self.component_id, exc)
                            with contextlib.suppress(OSError):
                                dst.close()
                            dst = None
                    start = 0
                    while True:
                        nl = chunk.find(b"\n", start)
                        if nl < 0:
                            if not skipping:
                                pending += chunk[start:]
                                if len(pending) > STDERR_LINE_MAX:
                                    self._emit_stderr(bytes(pending[:STDERR_LINE_MAX]), line_start, True)
                                    pending.clear()
                                    skipping = True
                            break
                        if skipping:
                            skipping = False
                        else:
                            pending += chunk[start:nl]
                            self._emit_stderr(bytes(pending), line_start, False)
                        pending.clear()
                        line_start = offset + nl + 1
                        start = nl + 1
                    offset += len(chunk)
                finally:
                    with self._stderr_lock:
                        self._stderr_busy = False
            if pending and not skipping:
                self._emit_stderr(bytes(pending), line_start, False)
        finally:
            with self._stderr_lock:
                self._stderr_fd = None
                with contextlib.suppress(OSError):
                    src.close()
            if dst is not None:
                with contextlib.suppress(OSError):
                    dst.close()

    def _telemetry_loop(self, fd: int) -> None:
        with os.fdopen(fd, "rb") as src:
            while True:
                try:
                    line = src.readline(TELEMETRY_LINE_MAX)
                except OSError:
                    break
                if not line:
                    break
                if not line.endswith(b"\n"):
                    self.telemetry_dropped += 1
                    if len(line) < TELEMETRY_LINE_MAX:
                        break  # EOF 前的半行
                    while True:  # 超長行：丟到下一個換行為止
                        rest = src.readline(TELEMETRY_LINE_MAX)
                        if not rest or rest.endswith(b"\n"):
                            break
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    self.telemetry_dropped += 1
                    continue
                if not isinstance(record, dict):
                    self.telemetry_dropped += 1
                    continue
                self.telemetry_records += 1
                try:
                    self._telemetry_sink(self, record)
                except Exception:
                    self.telemetry_dropped += 1
                    log.debug("telemetry 轉送失敗", exc_info=True)

    def _preview_loop(self, fd: int) -> None:
        """預覽 pipe：背景執行緒讀取並驗證，再交回 event loop；壞掉的分框之後只讀到 EOF 丟棄（不讓寫端卡住）。"""
        with os.fdopen(fd, "rb") as src:
            while True:
                try:
                    preview = read_preview(src)
                except PreviewRejected as exc:
                    self.previews_rejected += 1
                    log.warning("元件 %s 的中間預覽不合格（已丟棄）：%s", self.component_id, exc)
                    continue
                except PreviewProtocolError as exc:
                    self.previews_rejected += 1
                    log.warning("元件 %s 的預覽通道格式錯誤，之後的預覽都丟棄：%s", self.component_id, exc)
                    with contextlib.suppress(OSError):
                        drain(src)
                    return
                except OSError:
                    return
                if preview is None:
                    return
                self.previews_received += 1
                try:
                    self._loop.call_soon_threadsafe(self._deliver_preview, preview)
                except RuntimeError:  # event loop 已關閉（Node 正在結束）
                    with contextlib.suppress(OSError):
                        drain(src)
                    return

    def _deliver_preview(self, preview: NodePreview) -> None:
        if self._preview_sink is None:
            return
        try:
            self._preview_sink(self, preview)
        except Exception:
            log.exception("處理元件 %s 的中間預覽時發生錯誤", self.component_id)


__all__ = ["Aborted", "PreviewSink", "RuntimeGone", "RuntimeProcess", "describe_returncode"]
