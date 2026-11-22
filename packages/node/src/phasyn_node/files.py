"""檔案：串流上傳、FileRef 物化（同 Node 本機路徑/跨 Node 直接下載）、位址目錄.

- 同 Node：只檢查 metadata（size/SHA 與 FileRef 一致）後交出路徑，不重新雜湊、沒有網路。
- 跨 Node：依 RegistrationAck 學到的位址 ``GET <origin>/api/files/<file_id>``，以 ``file_buffer_bytes``
  串流寫進 ``files/remote/<node>/<file>/``，寫入同時算 SHA；size/SHA 不符 → FILE_TRUNCATED/
  FILE_HASH_MISMATCH（422），絕不 fallback。已驗證的遠端副本直接重用（network=0）。
- 主控只轉 FileRef；``node_id == controller_id`` 的 FileRef（主控上傳的原片）向主控的 /api/files 讀。
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any

import httpx
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.files import FileStore, FileWriter
from phasyn_components.ids import is_uuid
from phasyn_components.recorder import Recorder
from phasyn_components.timeutil import mono_ns
from phasyn_components.typed import check_fileref


DOWNLOAD_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=60.0, pool=None)


class Directory:
    """node_id → HTTP origin。只是位址解析，不是身份或授權。thread-safe."""

    def __init__(
        self, *, node_id: str, advertise_url: str, controller_url: str
    ) -> None:
        """Initialize the node endpoint cache."""
        self.node_id = node_id
        self._lock = threading.Lock()
        self._nodes: dict[str, str] = {node_id: advertise_url}
        self._states: dict[str, str] = {}
        self.controller_id: str | None = None
        self.controller_endpoint = controller_url

    def update(self, ack: Mapping[str, Any]) -> None:
        """Replace the directory entries with the controller's acknowledgement."""
        with self._lock:
            for entry in ack.get("nodes") or []:
                nid = str(entry.get("node_id") or "")
                endpoint = entry.get("endpoint")
                if is_uuid(nid) and isinstance(endpoint, str) and endpoint:
                    if nid != self.node_id:
                        self._nodes[nid] = endpoint
                    self._states[nid] = str(entry.get("state") or "online")
            cid = ack.get("controller_id")
            if is_uuid(cid):
                self.controller_id = str(cid)
            endpoint = ack.get("controller_endpoint")
            if isinstance(endpoint, str) and endpoint:
                self.controller_endpoint = endpoint

    def endpoint_for(self, node_id: str) -> str | None:
        """Resolve a node ID to its advertised endpoint."""
        with self._lock:
            if self.controller_id is not None and node_id == self.controller_id:
                return self.controller_endpoint
            return self._nodes.get(node_id)

    def state_of(self, node_id: str) -> str | None:
        """Return the last known state of a node."""
        with self._lock:
            return self._states.get(node_id)


@dataclass(frozen=True)
class Materialized:
    """Verified local input and the evidence for its transfer."""

    path: Path
    source: str  # local | remote_cache | download
    size_bytes: int


@dataclass(frozen=True, kw_only=True)
class _TransferTimes:
    """Counts and timings accumulated during a single transfer."""

    received: int
    write_ns: int
    started: int


def _check_source_response(response: httpx.Response, file_id: str, url: str) -> None:
    if response.status_code == HTTPStatus.NOT_FOUND:
        raise ComponentError(
            "FILE_NOT_FOUND",
            f"來源 Node 沒有已發布檔案 {file_id}",
            details={"url": url},
        )
    if response.status_code != HTTPStatus.OK:
        raise ComponentError(
            "NODE_UNREACHABLE",
            f"來源 Node 回應 HTTP {response.status_code}（{url}）",
            details={"url": url, "status": response.status_code},
        )


def _check_size(received: int, expected: int) -> None:
    if received > expected:
        raise ComponentError(
            "FILE_TRUNCATED",
            f"來源回傳的資料超過 FileRef 宣告的 {expected} bytes；不公開這個副本",
            details={
                "expected_size": expected,
                "received_bytes": received,
            },
        )


class FileResolver:
    """Resolve a typed file reference to a verified local file."""

    def __init__(
        self,
        *,
        store: FileStore,
        directory: Directory,
        client: httpx.AsyncClient,
        buffer_bytes: int,
        concurrency: int,
    ) -> None:
        """Configure local storage and remote file resolution."""
        self.store = store
        self.directory = directory
        self.node_id = directory.node_id
        self.client = client
        self.buffer_bytes = int(buffer_bytes)
        self._semaphore = asyncio.Semaphore(max(1, int(concurrency)))
        self._locks: dict[tuple[str, str], tuple[asyncio.Lock, int]] = {}

    def in_flight(self) -> set[tuple[str, str]]:
        """Remote files being materialized right now (their copies must not be cleaned meanwhile)."""
        return {(node.lower(), fid.lower()) for node, fid in self._locks}

    @contextlib.asynccontextmanager
    async def _file_lock(self, key: tuple[str, str]) -> AsyncIterator[None]:
        lock, refs = self._locks.get(key, (asyncio.Lock(), 0))
        self._locks[key] = (lock, refs + 1)
        try:
            async with lock:
                yield
        finally:
            lock, refs = self._locks[key]
            if refs <= 1:
                del self._locks[key]
            else:
                self._locks[key] = (lock, refs - 1)

    async def materialize(
        self, ref: Mapping[str, Any], *, recorder: Recorder | None = None
    ) -> Materialized:
        """把 FileRef 物化成本機完整檔。同一檔案的並行請求只下載一次."""
        check_fileref(dict(ref), where="FileRef")
        size = int(ref["size_bytes"])
        file_id = str(ref["file_id"])
        if ref["node_id"] == self.node_id:
            path = await asyncio.to_thread(self.store.local_path_for, ref)
            if path is None:
                raise ComponentError(
                    "FILE_NOT_FOUND",
                    f"本機找不到已發布檔案 {file_id}",
                    details={"file_id": file_id},
                )
            self._record_local(
                recorder,
                ref,
                reason="同 Node 本機檔：路徑直接交給元件程序讀取；Node 未搬運 bytes，network=0",
            )
            return Materialized(path, "local", size)
        key = (str(ref["node_id"]), file_id)
        async with self._file_lock(key):
            cached = await asyncio.to_thread(self.store.remote_copy, ref)
            if cached is not None:
                self._record_local(
                    recorder,
                    ref,
                    reason="重用已驗證（size／SHA-256）的遠端副本；network=0",
                )
                return Materialized(cached, "remote_cache", size)
            async with self._semaphore:
                path = await self._download(ref, recorder)
            return Materialized(path, "download", size)

    def _record_local(
        self, recorder: Recorder | None, ref: Mapping[str, Any], *, reason: str
    ) -> None:
        if recorder is None:
            return
        size = int(ref["size_bytes"])
        recorder.transfer(
            "disk_read",
            direction="DISK_IN",
            submitted_bytes=size,
            logical_bytes=size,
            owner="consumer",
            byte_basis="logical_file",
            actual_copy=False,
            completion_status="no_op",
            src=f"file:{ref['node_id']}/{ref['file_id']}",
            dst="runtime",
            src_memory_kind="disk",
            dst_memory_kind="host",
            reason=reason,
        )

    async def _download(
        self, ref: Mapping[str, Any], recorder: Recorder | None
    ) -> Path:
        origin = str(ref["node_id"])
        file_id = str(ref["file_id"])
        expected = int(ref["size_bytes"])
        endpoint = self.directory.endpoint_for(origin)
        if endpoint is None:
            raise ComponentError(
                "NODE_UNREACHABLE",
                f"無法解析 FileRef 來源 Node {origin} 的位址（尚未從主控目錄取得）；不改用其他來源",
                details={"node_id": origin, "file_id": file_id},
            )
        url = f"{endpoint}/api/files/{file_id}"
        writer: FileWriter = await asyncio.to_thread(self.store.remote_writer, ref)
        received = 0
        write_ns = 0
        started = mono_ns()
        headers_seen = False
        error: ComponentError | None = None
        try:
            async with self.client.stream(
                "GET",
                url,
                headers={"Accept-Encoding": "identity"},
                timeout=DOWNLOAD_TIMEOUT,
            ) as response:
                headers_seen = True
                _check_source_response(response, file_id, url)
                async for chunk in response.aiter_raw(self.buffer_bytes):
                    received += len(chunk)
                    _check_size(received, expected)
                    t0 = mono_ns()
                    await asyncio.to_thread(writer.write, chunk)
                    write_ns += mono_ns() - t0
            t0 = mono_ns()
            await asyncio.to_thread(
                writer.commit,
                expected_size=expected,
                expected_sha256=str(ref["sha256"]),
            )
            write_ns += mono_ns() - t0
        except ComponentError as exc:
            error = exc
        except httpx.HTTPError as exc:
            if headers_seen:
                error = ComponentError(
                    "FILE_TRUNCATED",
                    f"下載 {file_id} 時連線中斷（收到 {received}/{expected} bytes）；不續傳、不公開半個檔案",
                    details={
                        "url": url,
                        "received_bytes": received,
                        "expected_size": expected,
                        "error": type(exc).__name__,
                    },
                )
            else:
                error = ComponentError(
                    "NODE_UNREACHABLE",
                    f"無法連到來源 Node（{url}）：{type(exc).__name__}",
                    details={"url": url, "error": exception_message(exc)[:500]},
                )
        except BaseException:
            await asyncio.to_thread(writer.abort)
            self._record_download(
                recorder,
                ref,
                transfer=_TransferTimes(
                    received=received, write_ns=write_ns, started=started
                ),
                failed="下載被取消",
            )
            raise
        if error is not None:
            await asyncio.to_thread(writer.abort)
            self._record_download(
                recorder,
                ref,
                transfer=_TransferTimes(
                    received=received, write_ns=write_ns, started=started
                ),
                failed=error.message,
            )
            raise error
        self._record_download(
            recorder,
            ref,
            transfer=_TransferTimes(
                received=received, write_ns=write_ns, started=started
            ),
            failed=None,
        )
        path = await asyncio.to_thread(self.store.remote_copy, ref)
        if path is None:
            raise ComponentError(
                "FILE_NOT_FOUND", f"下載完成但找不到已驗證的副本 {file_id}"
            )
        return path

    def _record_download(
        self,
        recorder: Recorder | None,
        ref: Mapping[str, Any],
        *,
        failed: str | None,
        transfer: _TransferTimes,
    ) -> None:
        if recorder is None:
            return
        elapsed_ms = (mono_ns() - transfer.started) / 1e6
        expected = int(ref["size_bytes"])
        status = "failed" if failed else "completed"
        recorder.transfer(
            "network",
            direction="NET",
            submitted_bytes=expected,
            completed_bytes=None if failed else transfer.received,
            owner="consumer",
            byte_basis="http_entity",
            host_ms=elapsed_ms,
            src=f"node:{ref['node_id']}",
            dst=f"node:{self.node_id}",
            src_memory_kind="network",
            dst_memory_kind="disk",
            completion_status=status,
            reason=None
            if not failed
            else f"{failed}（已收到 {transfer.received} bytes 的 HTTP entity）",
        )
        if transfer.received:
            recorder.transfer(
                "disk_write",
                direction="DISK_OUT",
                submitted_bytes=transfer.received,
                completed_bytes=None if failed else transfer.received,
                owner="consumer",
                byte_basis="logical_file",
                host_ms=transfer.write_ns / 1e6,
                src="network",
                dst=f"remote-cache:{ref['node_id']}/{ref['file_id']}",
                src_memory_kind="host",
                dst_memory_kind="disk",
                completion_status=status,
                reason=None if not failed else "下載未完成；暫存檔已刪除",
            )


__all__ = ["Directory", "FileResolver", "Materialized"]
