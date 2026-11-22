"""模型權重下載（x-phasyn-extension）.

只在使用者明確要求時下載（``POST /api/components/{id}/weights/download``，本文 ``accept_licenses: true``）：

- 下載什麼由 provider 的權重計畫決定（runtime ``--weights``）：固定 repo commit 的檔案，以及每個檔案的大小與雜湊；
- 只寫進這個元件的模型根目錄（``load.model_path``），而且它必須位於這台 Node 的設定檔宣告的模型目錄之下
  （``model_dirs``，或設定檔內元件的 ``load.model_path``）：``load.model_path`` 可以經由 API 修改，設定檔不行，
  所以 API 改不出一個新的下載目的地；不在其中 → 不檢查檔案、不下載。每個檔案先寫成同目錄的隱藏暫存檔，邊收邊算
  雜湊，大小與雜湊都對才改名成正式檔名；中斷時暫存檔保留，下一次下載以 HTTP Range 接著下載（最後仍整檔驗證）；
- 已存在且大小相同的檔案略過（只比對大小，不重算雜湊）；大小不同的檔案只有 ``replace_mismatched`` 時才取代；
- 計畫列出的「內容相同的檔案」（例如 MiniMax-H3 的 FL2VA 與 Ref2VA 共用的部分）已在磁碟上時，重算它的雜湊，相同
  才以 hard link 共用，不下載；
- 開始前檢查剩餘空間；一個 Node 同時只有一個下載工作；失敗不自動重試；取消只停止這個工作；
- 來源是 ``HF_ENDPOINT``（預設 https://huggingface.co）；token 只從 Node 的環境變數 ``HF_TOKEN`` 讀取，不經過 API，
  只送給來源本身（轉址到其他主機時 httpx 會拿掉 Authorization）。回覆與錯誤訊息裡的來源不含 ``HF_ENDPOINT``
  可能帶的帳號密碼。

元件載入時仍然只讀本機檔案、從不下載。
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import logging
import os
import shutil
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from phasyn_components.errors import (
    ComponentError,
    exception_message,
    to_component_error,
)
from phasyn_components.ids import new_id
from phasyn_components.timeutil import utc_now
from phasyn_components.weights import (
    Digest,
    WeightFile,
    WeightPlan,
    WeightSet,
    expected_digest,
    file_matches,
    new_digest,
)

from . import __version__


if TYPE_CHECKING:
    from .service import NodeService
    from .supervisor import ComponentInstance

log = logging.getLogger("phasyn_node.weights")

DEFAULT_ENDPOINT = "https://huggingface.co"
CHUNK_BYTES = 4 * 1024 * 1024
# 下載後至少留這麼多空間（模型目錄所在的磁碟通常也放輸出與紀錄）
RESERVE_BYTES = 1024**3
PLAN_TTL_S = 30.0
CONFLICT_LIST_MAX = 20
DOWNLOAD_TIMEOUT = httpx.Timeout(connect=20.0, read=120.0, write=60.0, pool=20.0)
DOWNLOADABLE_STATES = frozenset({"stopped", "error"})
ROOT_NOT_ALLOWED_REASON = (
    "模型目錄（load.model_path）不在這台 Node 允許下載權重的目錄內：請在 Node 設定檔的 model_dirs 列出它，"
    "或改用設定檔內元件使用的模型目錄"
)


def public_endpoint(endpoint: str) -> str:
    """The source URL without credentials (``https://user:secret@mirror`` → ``https://mirror``)."""
    parts = urlsplit(endpoint)
    if "@" not in parts.netloc:
        return endpoint
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def part_path(path: Path) -> Path:
    """下載中的暫存檔：同目錄的隱藏檔（不會被 ``*.safetensors`` 之類的樣式選到）."""
    return path.with_name(f".{path.name}.phasyn-part")


def _size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


def free_bytes(root: Path | None) -> int | None:
    """root（還不存在時用最近的上層目錄）所在磁碟的剩餘空間；讀不到 → None."""
    if root is None:
        return None
    probe = root
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


@dataclass(frozen=True)
class Target:
    """計畫裡的一個檔案在這台 Node 上的位置（rel 相對於模型根目錄）."""

    rel: str
    file: WeightFile
    set_id: str
    repo: str
    revision: str
    links: tuple[str, ...]


def plan_targets(
    plan: WeightPlan, set_ids: Iterable[str] | None = None
) -> list[Target]:
    """計畫（或其中幾組）的檔案，依計畫順序；兩組放到同一個位置的同一個檔案只算一次（例如 repo 的 LICENSE）."""
    wanted = None if set_ids is None else set(set_ids)
    targets: dict[str, Target] = {}
    for weight_set in plan.sets:
        if wanted is not None and weight_set.set_id not in wanted:
            continue
        for item in weight_set.files:
            rel = f"{weight_set.dest}/{item.path}" if weight_set.dest else item.path
            known = targets.get(rel)
            if known is not None:
                if known.file.identity != item.identity:
                    raise ComponentError(
                        "RUNTIME_ERROR",
                        f"權重計畫把兩個不同的檔案放到同一個位置：{rel}",
                    )
                continue
            targets[rel] = Target(
                rel,
                item,
                weight_set.set_id,
                weight_set.repo,
                weight_set.revision,
                tuple(weight_set.links.get(item.path, ())),
            )
    return list(targets.values())


def file_status(root: Path, target: Target) -> dict[str, Any]:
    """present（大小相同）/mismatch（大小不同）/partial（有暫存檔）/missing；缺的檔案若有內容相同的檔案在磁碟上， link_from 是它（相對於根目錄）."""
    size = _size(root / target.rel)
    partial: int | None = None
    if size is not None:
        status = "present" if size == target.file.size else "mismatch"
    else:
        partial = _size(part_path(root / target.rel)) or None
        status = "partial" if partial else "missing"
    link_from = None
    if status in ("missing", "partial"):
        link_from = next(
            (cand for cand in target.links if _size(root / cand) == target.file.size),
            None,
        )
    return {
        "path": target.rel,
        "size": target.file.size,
        "status": status,
        "partial_bytes": partial,
        "link_from": link_from,
    }


def set_status(
    weight_set: WeightSet, statuses: Mapping[str, dict[str, Any]]
) -> dict[str, Any]:
    """Summarize the download status of a group of files."""
    files: list[dict[str, Any]] = []
    counts = dict.fromkeys(("present", "missing", "mismatch", "linkable"), 0)
    sizes = dict.fromkeys(counts, 0)
    partial_bytes = 0
    for item in weight_set.files:
        rel = f"{weight_set.dest}/{item.path}" if weight_set.dest else item.path
        status = statuses[rel]
        files.append({**status, "path": item.path})
        kind = "missing" if status["status"] == "partial" else status["status"]
        counts[kind] += 1
        sizes[kind] += item.size
        partial_bytes += status["partial_bytes"] or 0
        if status["link_from"]:
            counts["linkable"] += 1
            sizes["linkable"] += item.size
    return {
        "set_id": weight_set.set_id,
        "label": weight_set.label,
        "repo": weight_set.repo,
        "revision": weight_set.revision,
        "license": weight_set.license.to_dict(),
        "dest": weight_set.dest,
        "files_total": len(weight_set.files),
        "bytes_total": weight_set.total_bytes,
        **{f"files_{key}": counts[key] for key in counts},
        **{f"bytes_{key}": sizes[key] for key in sizes},
        "bytes_partial": partial_bytes,
        "files": files,
    }


@dataclass
class _Work:
    """下載工作裡的一個檔案。planned：開始時算進 bytes_total 的位元組數（預計共用的檔案是 0）."""

    target: Target
    replace: bool
    planned: int


@dataclass
class DownloadJob:
    """Track a model weight download and its verified byte counts."""

    job_id: str
    component_id: str
    sets: list[str]
    files_total: int
    bytes_total: int
    started_at: str
    state: str = "running"
    finished_at: str | None = None
    files_done: int = 0
    files_linked: int = 0
    bytes_done: int = 0
    current: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    task: asyncio.Task[None] | None = field(default=None, repr=False)

    def to_dict(self) -> dict[str, Any]:
        """Return the wire representation of these settings."""
        return {
            "job_id": self.job_id,
            "component_id": self.component_id,
            "state": self.state,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "sets": list(self.sets),
            "files_total": self.files_total,
            "files_done": self.files_done,
            "files_linked": self.files_linked,
            "bytes_total": self.bytes_total,
            "bytes_done": self.bytes_done,
            "current": dict(self.current) if self.current else None,
            "error": self.error,
        }


def _write(fh: IO[bytes], digest: Any, chunk: bytes) -> None:
    fh.write(chunk)
    digest.update(chunk)


def _hash_into(path: Path, digest: Any) -> None:
    with path.open("rb") as fh:
        while block := fh.read(CHUNK_BYTES):
            digest.update(block)


def _commit(part: Path, path: Path) -> None:
    fd = os.open(part, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    part.replace(path)
    with contextlib.suppress(OSError):
        dir_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def _link(source: Path, path: Path) -> bool:
    """以 hard link 把 source 放到 path（先連到暫存名稱再改名，不會留下一半的狀態）；不同磁碟或不支援 → False."""
    tmp = path.with_name(f".{path.name}.phasyn-link")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        os.link(source, tmp)
        tmp.replace(path)
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()
        return False
    return True


def _open_part(part: Path, *, append: bool) -> IO[bytes]:
    part.parent.mkdir(parents=True, exist_ok=True)
    return part.open("ab" if append else "wb")


def _disk_error(exc: OSError, rel: str) -> ComponentError:
    if exc.errno == errno.ENOSPC:
        return ComponentError(
            "DISK_FULL",
            f"寫入 {rel} 時磁碟已滿；暫存檔保留，清出空間後可以接著下載",
            details={"path": rel},
        )
    return ComponentError(
        "RUNTIME_ERROR",
        f"寫入 {rel} 失敗：{exception_message(exc)}",
        details={"path": rel},
    )


@dataclass
class _PartialFile:
    offset: int
    digest: Digest


class WeightsManager:
    """一個 Node 的權重下載：計畫快取、目前的下載工作與每個元件最後一次的工作（Node 重啟後不保留）."""

    def __init__(
        self,
        service: NodeService,
        *,
        roots: Iterable[Path] = (),
        transport: httpx.AsyncBaseTransport | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        """Prepare the weight-plan cache and download job registry."""
        source = os.environ if env is None else env
        self.service = service
        self.transport = transport
        self.roots = tuple(Path(os.path.realpath(root)) for root in roots)
        self.endpoint = (source.get("HF_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")
        self.source = public_endpoint(self.endpoint)
        self.source_host = urlsplit(self.source).netloc
        self._token = (
            source.get("HF_TOKEN") or source.get("HUGGING_FACE_HUB_TOKEN") or None
        )
        self._jobs: dict[str, DownloadJob] = {}
        self._plans: dict[str, tuple[float, int, WeightPlan]] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ plan / view
    async def _plan(
        self, inst: ComponentInstance, *, fresh: bool = False
    ) -> WeightPlan:
        settings, revision = inst.settings.snapshot()
        cached = self._plans.get(inst.component_id)
        if (
            not fresh
            and cached is not None
            and cached[1] == revision
            and time.monotonic() - cached[0] <= PLAN_TTL_S
        ):
            return cached[2]
        doc = await self.service.commands.weights(
            inst.runtime_entry(), inst.provider_id, settings
        )
        try:
            plan = WeightPlan.from_dict(doc)
        except (ComponentError, KeyError, TypeError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"provider {inst.provider_id} 的權重清單格式錯誤：{exception_message(exc)}",
            ) from exc
        self._plans[inst.component_id] = (time.monotonic(), revision, plan)
        return plan

    def _running(self) -> DownloadJob | None:
        return next(
            (job for job in self._jobs.values() if job.state == "running"), None
        )

    def _allowed(self, root: Path) -> bool:
        """Whether ``root`` (symlinks resolved) is one of the configured model directories or lies below one."""
        resolved = Path(os.path.realpath(root))
        return any(resolved == base or base in resolved.parents for base in self.roots)

    async def view(self, inst: ComponentInstance) -> dict[str, Any]:
        """計畫與每個檔案目前的狀態、剩餘空間、來源設定，以及這個元件最近一次的下載工作（下載中時每次都會讀）."""
        job = self._jobs.get(inst.component_id)
        plan = await self._plan(inst)
        root = Path(plan.root) if plan.root else None
        if root is not None and not self._allowed(root):
            # No file of a directory outside the configured model directories is looked at.
            return {
                "component_id": inst.component_id,
                "root": None,
                "root_exists": False,
                "sets": [],
                "notes": [ROOT_NOT_ALLOWED_REASON, *plan.notes][:100],
                "free_bytes": None,
                "source": {"endpoint": self.source, "token": self._token is not None},
                "job": job.to_dict() if job else None,
            }

        def inspect() -> tuple[list[dict[str, Any]], bool, int | None]:
            if root is None:
                return [], False, None
            statuses = {
                target.rel: file_status(root, target) for target in plan_targets(plan)
            }
            return (
                [set_status(item, statuses) for item in plan.sets],
                root.is_dir(),
                free_bytes(root),
            )

        sets, root_exists, free = await asyncio.to_thread(inspect)
        return {
            "component_id": inst.component_id,
            "root": plan.root,
            "root_exists": root_exists,
            "sets": sets,
            "notes": list(plan.notes),
            "free_bytes": free,
            "source": {"endpoint": self.source, "token": self._token is not None},
            "job": job.to_dict() if job else None,
        }

    # ------------------------------------------------------------------ download
    @staticmethod
    async def _plan_space(
        root: Path, targets: list[Target], *, replace: bool
    ) -> tuple[list[_Work], int]:
        statuses = await asyncio.to_thread(
            lambda: [file_status(root, target) for target in targets]
        )
        conflicts = [
            status["path"] for status in statuses if status["status"] == "mismatch"
        ]
        if conflicts and not replace:
            raise ComponentError(
                "WEIGHTS_DESTINATION_CONFLICT",
                f"目的地有 {len(conflicts)} 個檔案與固定版本的大小不同，不會覆蓋；要取代請勾選「取代大小不同的檔案」",
                details={
                    "files": conflicts[:CONFLICT_LIST_MAX],
                    "count": len(conflicts),
                },
            )
        work: list[_Work] = []
        needed = 0
        for target, status in zip(targets, statuses, strict=True):
            if status["status"] == "present":
                continue
            if status["status"] == "mismatch":
                planned = target.file.size
            elif status["link_from"]:
                planned = 0
            else:
                planned = target.file.size - (status["partial_bytes"] or 0)
            needed += planned
            work.append(_Work(target, status["status"] == "mismatch", planned))
        free = await asyncio.to_thread(free_bytes, root)
        if free is not None and needed + RESERVE_BYTES > free:
            raise ComponentError(
                "DISK_FULL",
                f"模型目錄所在的磁碟剩 {free} bytes，這次下載需要 {needed} bytes（另外保留 {RESERVE_BYTES} bytes）",
                details={
                    "needed_bytes": needed,
                    "free_bytes": free,
                    "reserve_bytes": RESERVE_BYTES,
                },
            )

        return work, needed

    async def start(
        self, inst: ComponentInstance, body: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Start the requested weight download after checking its plan."""
        if body.get("accept_licenses") is not True:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "下載前必須同意這些權重的授權條款（accept_licenses: true）",
            )
        async with self._lock:
            if self.service.shutting_down:
                raise ComponentError(
                    "NODE_SHUTTING_DOWN", "Node 正在關閉，不開始新的下載"
                )
            running = self._running()
            if running is not None:
                raise ComponentError(
                    "STATE_CONFLICT",
                    f"這個 Node 正在下載元件 {running.component_id} 的權重；完成或取消後再開始",
                    details={
                        "job_id": running.job_id,
                        "component_id": running.component_id,
                    },
                )
            if inst.state not in DOWNLOADABLE_STATES:
                raise ComponentError(
                    "STATE_CONFLICT",
                    f"元件停止時才能下載權重（目前狀態：{inst.state}）",
                    details={"state": inst.state},
                )
            plan = await self._plan(inst, fresh=True)
            if plan.root is None:
                reason = (
                    plan.notes[0]
                    if plan.notes
                    else "未設定 load.model_path（模型根目錄）"
                )
                raise ComponentError("COMPONENT_NOT_CONFIGURED", reason)
            known = [item.set_id for item in plan.sets]
            wanted = [str(item) for item in body.get("sets") or known]
            unknown = sorted(set(wanted) - set(known))
            if unknown:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"這個元件的權重計畫沒有這些權重組：{'、'.join(unknown)}",
                    details={"sets": unknown, "known": known},
                )
            if not wanted:
                raise ComponentError("INVALID_ARGUMENT", "這個元件沒有可以下載的權重")
            root = Path(plan.root)
            if not self._allowed(root):
                raise ComponentError(
                    "COMPONENT_NOT_CONFIGURED", ROOT_NOT_ALLOWED_REASON
                )
            replace = bool(body.get("replace_mismatched", False))
            targets = plan_targets(plan, wanted)
            work, needed = await self._plan_space(root, targets, replace=replace)
            job = DownloadJob(
                job_id=new_id(),
                component_id=inst.component_id,
                sets=wanted,
                files_total=len(work),
                bytes_total=needed,
                started_at=utc_now(),
            )
            self._jobs[inst.component_id] = job
            job.task = self.service.spawn_task(
                self._run(job, inst, root, work), name=f"weights-{inst.component_id}"
            )
            log.info(
                "開始下載元件 %s 的權重：%d 個檔案、%d bytes",
                inst.component_id,
                len(work),
                needed,
            )
            return job.to_dict()

    async def cancel(self, inst: ComponentInstance) -> dict[str, Any]:
        """Signal the current weight download to stop."""
        job = self._jobs.get(inst.component_id)
        if job is None:
            raise ComponentError("NOT_FOUND", "這個元件沒有下載工作")
        task = job.task
        if job.state == "running" and task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(task), timeout=10)
        return job.to_dict()

    async def close(self) -> None:
        """Stop outstanding downloads and close their resources."""
        job = self._running()
        if job is not None and job.task is not None:
            job.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(job.task), timeout=10)

    async def _run(
        self, job: DownloadJob, inst: ComponentInstance, root: Path, work: list[_Work]
    ) -> None:
        try:
            async with httpx.AsyncClient(
                transport=self.transport,
                trust_env=True,
                follow_redirects=True,
                timeout=DOWNLOAD_TIMEOUT,
                headers={"User-Agent": f"phasyn-studio/{__version__}"},
            ) as client:
                for item in work:
                    await self._fetch(client, job, root, item)
                    job.files_done += 1
            job.state = "succeeded"
        except asyncio.CancelledError:
            job.state = "cancelled"
            raise
        except ComponentError as exc:
            job.state = "failed"
            job.error = exc.to_dict()
        except Exception as exc:  # reported on the job, never retried
            job.state = "failed"
            log.exception("Unexpected weight download failure")
            job.error = to_component_error(exc).to_dict()
        finally:
            job.current = None
            job.finished_at = utc_now()
            self._plans.pop(inst.component_id, None)
            if job.state == "succeeded":
                # other components may read the same directories (an H3 text encoder also reads the other variant):
                # their next describe says what is still missing
                self.service.commands.forget_unavailable()
                for other in list(self.service.instances.values()):
                    other.forget_configuration_error()
            log.info("元件 %s 的權重下載結束：%s", inst.component_id, job.state)
            self.service.notify_change()

    async def _fetch(
        self, client: httpx.AsyncClient, job: DownloadJob, root: Path, item: _Work
    ) -> None:
        target = item.target
        path = root / target.rel
        job.current = {
            "path": target.rel,
            "phase": "download",
            "bytes_done": 0,
            "bytes_total": target.file.size,
        }
        if (
            not item.replace
            and await asyncio.to_thread(_size, path) == target.file.size
        ):
            job.bytes_total -= (
                item.planned
            )  # written meanwhile (for example by a link to the same file)
            return
        if not item.replace:
            for cand in target.links:
                source = root / cand
                if await asyncio.to_thread(_size, source) != target.file.size:
                    continue
                job.current["phase"] = "verify"
                if await asyncio.to_thread(
                    file_matches, source, target.file
                ) and await asyncio.to_thread(_link, source, path):
                    job.files_linked += 1
                    job.bytes_total -= item.planned
                    return
        job.current["phase"] = "download"
        await self._download(client, job, path, item)

    async def _receive_body(
        self,
        resp: httpx.Response,
        job: DownloadJob,
        target: Target,
        part: Path,
        progress: _PartialFile,
    ) -> None:
        current = job.current
        if current is None:
            raise RuntimeError("No active weight download")
        size = target.file.size
        if (
            progress.offset
            and resp.status_code == HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE
            and progress.offset == size
        ):
            return
        if resp.status_code not in (HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT):
            raise self._source_error(resp, target)
        if progress.offset and resp.status_code == HTTPStatus.OK:
            job.bytes_total += progress.offset
            progress.offset = 0
            progress.digest = new_digest(target.file)
            current["bytes_done"] = 0
        fh = await asyncio.to_thread(_open_part, part, append=progress.offset > 0)
        try:
            async for chunk in resp.aiter_bytes(CHUNK_BYTES):
                if progress.offset + len(chunk) > size:
                    raise ComponentError(
                        "FILE_HASH_MISMATCH",
                        f"{target.rel} 收到的內容比固定版本的 {size} bytes 長；已刪除暫存檔",
                        details={"path": target.rel},
                    )
                await asyncio.to_thread(_write, fh, progress.digest, chunk)
                progress.offset += len(chunk)
                job.bytes_done += len(chunk)
                current["bytes_done"] = progress.offset
        finally:
            await asyncio.to_thread(fh.close)

    def _url(self, target: Target) -> str:
        return f"{self.endpoint}/{target.repo}/resolve/{target.revision}/{quote(target.file.repo_path, safe='/')}"

    async def _download(
        self, client: httpx.AsyncClient, job: DownloadJob, path: Path, item: _Work
    ) -> None:
        target = item.target
        size = target.file.size
        part = part_path(path)
        offset = await asyncio.to_thread(_size, part) or 0
        if offset > size:
            await asyncio.to_thread(part.unlink)
            offset = 0
        digest = new_digest(target.file)
        if offset:
            await asyncio.to_thread(_hash_into, part, digest)
        job.bytes_total += (
            size - offset
        ) - item.planned  # the plan assumed a link or a different partial size
        if job.current is None:
            raise RuntimeError("No active weight download")
        job.current["bytes_done"] = offset
        headers: dict[str, str] = {}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        progress = _PartialFile(offset=offset, digest=digest)
        url = self._url(target)
        try:
            async with client.stream("GET", url, headers=headers) as resp:
                await self._receive_body(resp, job, target, part, progress)
        except httpx.HTTPError as exc:
            raise ComponentError(
                "WEIGHTS_SOURCE_UNAVAILABLE",
                f"從 {self.source_host} 下載 {target.rel} 時連線失敗：{exception_message(exc)}；暫存檔保留，下次下載會接著下載",
                details={
                    "path": target.rel,
                    "repo": target.repo,
                    "revision": target.revision,
                },
            ) from exc
        except OSError as exc:
            raise _disk_error(exc, target.rel) from exc
        except ComponentError as exc:
            if exc.code == "FILE_HASH_MISMATCH":
                with contextlib.suppress(OSError):
                    await asyncio.to_thread(part.unlink)
            raise
        return await self._commit_verified_weight(target, path, part, progress)

    async def _commit_verified_weight(
        self, target: Target, path: Path, part: Path, progress: _PartialFile
    ) -> None:
        size = target.file.size
        offset = progress.offset
        if offset != size:
            raise ComponentError(
                "FILE_TRUNCATED",
                f"{target.rel} 只收到 {offset}/{size} bytes；暫存檔保留，下次下載會接著下載",
                details={"path": target.rel, "received_bytes": offset, "size": size},
            )
        if progress.digest.hexdigest() != expected_digest(target.file):
            with contextlib.suppress(OSError):
                await asyncio.to_thread(part.unlink)
            raise ComponentError(
                "FILE_HASH_MISMATCH",
                f"{target.rel} 的雜湊與固定版本不同；已刪除暫存檔",
                details={
                    "path": target.rel,
                    "repo": target.repo,
                    "revision": target.revision,
                },
            )
        try:
            await asyncio.to_thread(_commit, part, path)
        except OSError as exc:
            raise _disk_error(exc, target.rel) from exc

    def _source_error(self, resp: httpx.Response, target: Target) -> ComponentError:
        status = resp.status_code
        host = self.source_host
        details = {
            "path": target.rel,
            "repo": target.repo,
            "revision": target.revision,
            "status": status,
        }
        if status in (401, 403):
            hint = (
                "token 沒有這個 repo 的權限"
                if self._token
                else "需要授權：在 Node 的環境變數設定 HF_TOKEN 後重啟 Node"
            )
            return ComponentError(
                "WEIGHTS_SOURCE_UNAVAILABLE",
                f"{host} 拒絕下載 {target.repo}（HTTP {status}）：{hint}",
                details=details,
            )
        if status == HTTPStatus.NOT_FOUND:
            return ComponentError(
                "WEIGHTS_SOURCE_UNAVAILABLE",
                f"{host} 找不到 {target.repo}@{target.revision[:12]} 的 {target.file.repo_path}（HTTP 404）",
                details=details,
            )
        return ComponentError(
            "WEIGHTS_SOURCE_UNAVAILABLE",
            f"{host} 回應 HTTP {status}，無法下載 {target.rel}",
            details=details,
        )


__all__ = [
    "DownloadJob",
    "Target",
    "WeightsManager",
    "file_status",
    "free_bytes",
    "part_path",
    "plan_targets",
    "public_endpoint",
    "set_status",
]
