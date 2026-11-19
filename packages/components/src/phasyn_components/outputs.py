"""Output files a provider writes into the Node's file store (``.part`` files, SHA-256 while writing).

The Node publishes them atomically after the call; until then they are invisible to readers.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .errors import ComponentError
from .files import FileStore
from .recorder import Recorder
from .timeutil import mono_ns


class OutputFile:
    """寫到 Node 檔案庫的 `.part`，寫入同時計算 SHA-256；Node 在 call 結束後原子發布。"""

    def __init__(
        self,
        store: FileStore,
        *,
        port: str,
        type_id: str,
        media_type: str,
        metadata: Mapping[str, Any] | None,
        recorder: Recorder | None,
    ) -> None:
        self.port = port
        self.type_id = type_id
        self.media_type = media_type
        self.metadata: dict[str, Any] = dict(metadata or {})
        self.file_id, self.path = store.reserve()
        if ".." in self.path.parts:  # 路徑穿越防護（CWE-22）：`.part` 一律落在檔案庫內
            raise ComponentError("PATH_TRAVERSAL", f"路徑不可包含 .. 分量：{self.path}")
        self._fh: Any = self.path.open("wb")  # noqa: SIM115 - finish/abort 管理
        self._hasher = hashlib.sha256()
        self.size = 0
        self._recorder = recorder
        self._t0 = mono_ns()
        self.finished = False
        self.sha256: str | None = None

    def write(self, data: bytes | bytearray | memoryview) -> None:
        self._fh.write(data)
        self._hasher.update(data)
        self.size += len(data)

    def finish(self) -> dict[str, Any]:
        if not self.finished:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._fh.close()
            self.sha256 = self._hasher.hexdigest()
            self.finished = True
            if self._recorder is not None:
                elapsed = (mono_ns() - self._t0) / 1_000_000
                self._recorder.transfer(
                    "disk_write",
                    direction="DISK_OUT",
                    submitted_bytes=self.size,
                    host_ms=elapsed,
                    byte_basis="logical_file",
                    owner="producer",
                    src="process",
                    dst=f"file:{self.file_id}",
                    src_memory_kind="host",
                    dst_memory_kind="disk",
                )
        return self.wire()

    def adopt_written(self) -> dict[str, Any]:
        """外部工具（例如 FFmpeg）已直接寫到 ``self.path``：讀一次算 SHA-256（明確記錄為 hash readback）。"""
        if not self.finished:
            self._fh.close()
            hasher = hashlib.sha256()
            size = 0
            t0 = mono_ns()
            with open(self.path, "rb") as fh:
                while chunk := fh.read(8 * 1024 * 1024):
                    hasher.update(chunk)
                    size += len(chunk)
            self.size = size
            self.sha256 = hasher.hexdigest()
            self.finished = True
            if self._recorder is not None:
                self._recorder.transfer(
                    "disk_read",
                    direction="DISK_IN",
                    submitted_bytes=size,
                    host_ms=(mono_ns() - t0) / 1_000_000,
                    byte_basis="logical_file",
                    owner="producer",
                    src=f"file:{self.file_id}",
                    dst="sha256",
                    src_memory_kind="disk",
                    dst_memory_kind="host",
                    reason="外部工具輸出後讀回一次計算 SHA-256",
                )
        return self.wire()

    def adopt_file(self, source: Path, *, sha256: str, size: int) -> dict[str, Any]:
        """外部工具已寫好並雜湊過的完整檔（同 filesystem rename，不讀回）。"""
        if not self.finished:
            self._fh.close()
            os.replace(source, self.path)
            actual = self.path.stat().st_size
            if actual != size:
                raise ComponentError("FILE_TRUNCATED", f"輸出檔大小 {actual} 與工具回報的 {size} 不同")
            self.size = size
            self.sha256 = sha256
            self.finished = True
        return self.wire()

    def abort(self) -> None:
        try:
            self._fh.close()
        except OSError:
            pass
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass

    def wire(self) -> dict[str, Any]:
        return {
            "type_id": self.type_id,
            "pending_file": {
                "file_id": self.file_id,
                "media_type": self.media_type,
                "metadata": self.metadata,
                "size_bytes": self.size,
                "sha256": self.sha256,
            },
        }


__all__ = ["OutputFile"]
