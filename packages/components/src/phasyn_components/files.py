"""本機檔案儲存：串流寫入同時算 SHA-256、`.part`→原子發布、單一 Range 讀取。

layout（data_dir 內）::

    files/<file_id>/payload.part   寫入中，不對外可讀
    files/<file_id>/payload        已發布 payload
    files/<file_id>/meta.json      最後寫入；存在且 published=true 才算已發布
    files/remote/<origin_node>/<file_id>/...   從其他 Node 下載的完整副本（只供本機 consumer 重用）

雜湊是來源身分與截斷檢查，不是安全資格。來源與結果預設不自動刪除。
"""

from __future__ import annotations

import errno
import hashlib
import logging
import os
import shutil
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, BinaryIO

from .canonical import atomic_write_json, read_json
from .errors import ComponentError, exception_message
from .ids import is_uuid, new_id, require_uuid
from .timeutil import utc_now

log = logging.getLogger("phasyn_components.files")

DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024
PAYLOAD = "payload"
PART = "payload.part"
META = "meta.json"


def _disk_error(exc: OSError, what: str) -> ComponentError:
    if exc.errno == errno.ENOSPC:
        return ComponentError("DISK_FULL", f"{what}：磁碟已滿；未刪除任何既有檔案", details={"errno": exc.errno})
    return ComponentError("RUNTIME_ERROR", f"{what}：{exception_message(exc)}", details={"errno": exc.errno})


def ensure_within(root: Path, path: Path) -> Path:
    """路徑穿越防護（CWE-22）：``path`` 正規化後必須位於 ``root`` 之內，否則拒絕。

    回傳正規化後的路徑；``root`` 本身也接受（由呼叫端判斷是否合理）。
    """
    root_real = root.resolve()
    path_real = path.resolve()
    if path_real != root_real and root_real not in path_real.parents:
        raise ComponentError(
            "PATH_TRAVERSAL",
            f"路徑超出允許範圍：{path}",
            details={"path": str(path_real), "root": str(root_real)},
        )
    return path_real


class FileWriter:
    """串流寫入一個新檔；``commit()`` 原子發布並回傳 FileRef。"""

    def __init__(
        self, directory: Path, *, node_id: str, file_id: str, media_type: str, metadata: Mapping[str, Any]
    ) -> None:
        self.directory = directory
        self.node_id = node_id
        self.file_id = file_id
        self.media_type = media_type
        self.metadata = dict(metadata)
        self.size = 0
        self._hasher = hashlib.sha256()
        self._closed = False
        if ".." in directory.parts:
            raise ComponentError("PATH_TRAVERSAL", f"目錄路徑不可包含 .. 分量：{directory}")
        directory.mkdir(parents=True, exist_ok=True)
        self.part_path = directory / PART
        try:
            self._fh: BinaryIO | None = self.part_path.open("wb")  # noqa: SIM115 - 生命週期由 commit/abort 管理
        except OSError as exc:
            raise _disk_error(exc, "建立暫存檔失敗") from exc

    def write(self, data: bytes | bytearray | memoryview) -> None:
        if self._fh is None:
            raise ComponentError("RUNTIME_ERROR", "檔案已關閉")
        try:
            self._fh.write(data)
        except OSError as exc:
            raise _disk_error(exc, "寫入檔案失敗") from exc
        self._hasher.update(data)
        self.size += len(data)

    @property
    def sha256(self) -> str:
        return self._hasher.hexdigest()

    def commit(
        self,
        *,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
        extra_meta: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._fh is None:
            raise ComponentError("RUNTIME_ERROR", "檔案已關閉")
        try:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._fh.close()
        except OSError as exc:
            self.abort()
            raise _disk_error(exc, "寫入檔案失敗") from exc
        self._fh = None
        sha = self.sha256
        if expected_size is not None and expected_size != self.size:
            self.abort()
            raise ComponentError(
                "FILE_TRUNCATED",
                f"檔案大小不符：預期 {expected_size} bytes，實際 {self.size} bytes（不公開半個檔案）",
                details={"expected_size": expected_size, "actual_size": self.size},
            )
        if expected_sha256 is not None and expected_sha256 != sha:
            self.abort()
            raise ComponentError(
                "FILE_HASH_MISMATCH",
                "檔案 SHA-256 與來源宣告不同",
                details={"expected_sha256": expected_sha256, "actual_sha256": sha},
            )
        return publish(
            self.directory,
            node_id=self.node_id,
            file_id=self.file_id,
            media_type=self.media_type,
            metadata=self.metadata,
            size=self.size,
            sha256=sha,
            extra_meta=extra_meta,
        )

    def abort(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None
        try:
            self.part_path.unlink(missing_ok=True)
        except OSError:
            pass

    def __enter__(self) -> FileWriter:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is not None or self._fh is not None:
            self.abort()


def publish(
    directory: Path,
    *,
    node_id: str,
    file_id: str,
    media_type: str,
    metadata: Mapping[str, Any],
    size: int,
    sha256: str,
    extra_meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """`.part` → payload rename，最後寫 meta.json（published 欄位最後出現）。"""
    part = directory / PART
    payload = directory / PAYLOAD
    try:
        actual = part.stat().st_size
    except FileNotFoundError as exc:
        raise ComponentError("FILE_NOT_FOUND", f"找不到待發布的暫存檔 {file_id}") from exc
    if actual != size:
        raise ComponentError(
            "FILE_TRUNCATED",
            f"待發布檔案大小 {actual} 與寫入時計算的 {size} 不同；不發布",
            details={"expected_size": size, "actual_size": actual},
        )
    try:
        os.replace(part, payload)
    except OSError as exc:
        raise _disk_error(exc, "發布檔案失敗") from exc
    ref = {
        "node_id": node_id,
        "file_id": file_id,
        "size_bytes": int(size),
        "sha256": sha256,
        "media_type": media_type,
        "metadata": dict(metadata),
    }
    meta = {"fileref": ref, "created_at": utc_now(), **dict(extra_meta or {}), "published": True}
    try:
        atomic_write_json(directory / META, meta)
    except OSError as exc:
        raise _disk_error(exc, "寫入檔案 metadata 失敗") from exc
    return ref


class FileStore:
    def __init__(self, data_dir: Path, node_id: str, *, buffer_bytes: int = DEFAULT_BUFFER_BYTES) -> None:
        self.root = (Path(data_dir) / "files").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.node_id = node_id
        self.buffer_bytes = int(buffer_bytes)

    # ------------------------------------------------------------ local files
    def directory(self, file_id: str) -> Path:
        return ensure_within(self.root, self.root / require_uuid(file_id, "file_id"))

    def new_writer(
        self, media_type: str, metadata: Mapping[str, Any] | None = None, *, file_id: str | None = None
    ) -> FileWriter:
        if not media_type or len(media_type) > 255:
            raise ComponentError("INVALID_ARGUMENT", "media_type 必填")
        fid = file_id or new_id()
        directory = self.directory(fid)
        if (directory / META).exists():
            raise ComponentError("INVALID_ARGUMENT", f"file_id {fid} 已存在")
        return FileWriter(directory, node_id=self.node_id, file_id=fid, media_type=media_type, metadata=metadata or {})

    def reserve(self) -> tuple[str, Path]:
        """給元件程序直接寫 `.part`：回傳 file_id 與 `.part` 路徑（Node 之後以 publish_reserved 發布）。"""
        fid = new_id()
        directory = self.directory(fid)
        if ".." in directory.parts:
            raise ComponentError("PATH_TRAVERSAL", f"目錄路徑不可包含 .. 分量：{directory}")
        directory.mkdir(parents=True, exist_ok=True)
        return fid, ensure_within(self.root, directory / PART)

    def publish_reserved(
        self, file_id: str, *, media_type: str, metadata: Mapping[str, Any], size: int, sha256: str
    ) -> dict[str, Any]:
        return publish(
            self.directory(file_id),
            node_id=self.node_id,
            file_id=file_id,
            media_type=media_type,
            metadata=metadata,
            size=size,
            sha256=sha256,
        )

    def discard_reserved(self, file_id: str) -> None:
        directory = self.directory(file_id)
        if not (directory / META).exists():
            shutil.rmtree(directory, ignore_errors=True)

    def meta(self, file_id: str) -> dict[str, Any] | None:
        if not is_uuid(file_id):
            return None
        path = self.root / file_id / META
        try:
            doc = read_json(path)
        except (OSError, ValueError):
            return None
        if not isinstance(doc, dict) or doc.get("published") is not True:
            return None
        return doc

    def fileref(self, file_id: str) -> dict[str, Any]:
        doc = self.meta(file_id)
        if doc is None:
            raise ComponentError("FILE_NOT_FOUND", f"找不到已發布檔案 {file_id}", details={"file_id": file_id})
        return dict(doc["fileref"])

    def payload_path(self, file_id: str) -> Path:
        self.fileref(file_id)
        return self.root / file_id / PAYLOAD

    def iter_range(self, file_id: str, start: int, end: int) -> Iterator[bytes]:
        """讀取 [start, end]（含 end）。"""
        path = self.payload_path(file_id)
        remaining = end - start + 1
        with open(path, "rb") as fh:
            fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(self.buffer_bytes, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def delete(self, file_id: str) -> bool:
        """使用者明確選定後的手動清理（不按 mtime 掃描）：刪除已發布檔的目錄（payload、meta.json）。

        目錄先原子改名離開 ``files/<id>``（之後讀取一律 FILE_NOT_FOUND），再清除。沒有已發布檔 → False；
        只有寫入中的 ``.part`` → STATE_CONFLICT（不中斷寫入）。其他 Node 下載的副本（files/remote/）不在這裡。
        """
        fid = require_uuid(file_id, "file_id")
        directory = self.root / fid
        if self.meta(fid) is None:
            if (directory / PART).exists():
                raise ComponentError("STATE_CONFLICT", "檔案仍在寫入中，不能刪除", details={"file_id": fid})
            return False
        trash = self.root / f".deleted-{fid}-{new_id()[:8]}"
        try:
            directory.rename(trash)
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise _disk_error(exc, f"刪除檔案 {fid} 失敗") from exc
        try:
            shutil.rmtree(trash)
        except OSError as exc:
            log.warning("已刪除檔案的目錄 %s 無法完全清除（已不對外提供，需手動清理）：%s", trash, exc)
        return True

    # ------------------------------------------------------------ remote copies
    def remote_directory(self, ref: Mapping[str, Any]) -> Path:
        return ensure_within(
            self.root,
            self.root / "remote" / require_uuid(ref["node_id"], "node_id") / require_uuid(ref["file_id"], "file_id"),
        )

    def remote_copy(self, ref: Mapping[str, Any]) -> Path | None:
        """已下載且大小／雜湊與 FileRef 相同的完整副本。"""
        directory = self.remote_directory(ref)
        try:
            doc = read_json(directory / META)
        except (OSError, ValueError):
            return None
        stored = doc.get("fileref") or {}
        if doc.get("published") is not True:
            return None
        if stored.get("sha256") != ref["sha256"] or stored.get("size_bytes") != ref["size_bytes"]:
            return None
        path = directory / PAYLOAD
        try:
            if path.stat().st_size != ref["size_bytes"]:
                return None
        except OSError:
            return None
        return path

    def remote_writer(self, ref: Mapping[str, Any]) -> FileWriter:
        directory = self.remote_directory(ref)
        shutil.rmtree(directory, ignore_errors=True)
        return FileWriter(
            directory,
            node_id=str(ref["node_id"]),
            file_id=str(ref["file_id"]),
            media_type=str(ref.get("media_type") or "application/octet-stream"),
            metadata=dict(ref.get("metadata") or {}),
        )

    def local_path_for(self, ref: Mapping[str, Any]) -> Path | None:
        """同 Node 的已發布檔直接回傳路徑（檢查 metadata 而不重新雜湊）。"""
        if ref.get("node_id") != self.node_id:
            return self.remote_copy(ref)
        doc = self.meta(str(ref.get("file_id")))
        if doc is None:
            return None
        stored = doc["fileref"]
        if stored.get("sha256") != ref.get("sha256") or stored.get("size_bytes") != ref.get("size_bytes"):
            raise ComponentError(
                "FILE_HASH_MISMATCH",
                f"本機檔案 {ref.get('file_id')} 的 size／SHA-256 與 FileRef 不同",
                details={"file_id": ref.get("file_id")},
            )
        return self.root / str(ref["file_id"]) / PAYLOAD


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """單一 byte Range；無效回 416（ComponentError RANGE_NOT_SATISFIABLE）。"""
    if not header:
        return None
    text = header.strip()
    if not text.startswith("bytes=") or "," in text:
        raise ComponentError("RANGE_NOT_SATISFIABLE", "只支援單一 bytes Range")
    spec = text[len("bytes=") :].strip()
    start_s, _, end_s = spec.partition("-")
    try:
        if start_s == "":
            length = int(end_s)
            if length <= 0:
                raise ValueError
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError as exc:
        raise ComponentError("RANGE_NOT_SATISFIABLE", f"無效 Range：{header}") from exc
    end = min(end, size - 1)
    if start < 0 or start > end or start >= size:
        raise ComponentError("RANGE_NOT_SATISFIABLE", f"Range 超出檔案大小 {size}：{header}", details={"size": size})
    return start, end


__all__ = ["DEFAULT_BUFFER_BYTES", "FileStore", "FileWriter", "ensure_within", "parse_range", "publish"]
