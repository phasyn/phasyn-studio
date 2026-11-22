"""Stage verified immutable payloads, then publish the project as the visibility boundary."""

from __future__ import annotations

import hashlib
import shutil
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.fs import fsync_dir

from .studio_backfill import is_file_ref
from .studio_portable_archive import CHUNK, MAX_ZIP, Doc, file_table, invalid, objects


if TYPE_CHECKING:
    from .state import Controller


def detach(snapshot: Doc, node_id: str, pid: str) -> None:
    """Retarget FileRefs, including links, keeping the blob IDs embedded in latent manifests."""
    for obj in objects(snapshot):
        if is_file_ref(obj):
            obj["node_id"] = node_id
    project = snapshot["project"]
    project["project_id"] = pid
    snapshot["reviews"]["project_id"] = pid
    for item in [
        *project["exports"],
        *(
            take
            for key in ("shots", "image_shots")
            for shot in project.get(key, [])
            for take in shot["takes"]
        ),
    ]:
        if item["state"] == "rendering":
            item.update(
                state="interrupted",
                error={
                    "code": "INTERRUPTED",
                    "message": "此工作在封存時尚未完成，匯入後保留歷史紀錄。",
                },
            )


def stage_files(
    stream: BinaryIO, snapshot: Doc, stage: FileStore, destination: FileStore
) -> list[Doc]:
    """Materialize and verify every distinct file identity, keeping inputs out of the live store."""
    refs = [ref for group in file_table(snapshot).values() for ref in group]
    needed = sum(
        ref["size_bytes"] for ref in refs if destination.meta(ref["file_id"]) is None
    )
    if needed > MAX_ZIP:
        raise invalid("合併所有檔案身分後，專案素材超出容量上限")
    if shutil.disk_usage(stage.root).free < needed:
        raise ComponentError("DISK_FULL", "還原素材的磁碟空間不足")
    with zipfile.ZipFile(stream) as archive:
        for ref in refs:
            fid = ref["file_id"]
            existing = destination.meta(fid)
            if existing is not None:
                if existing["fileref"] != ref:
                    raise ComponentError(
                        "STATE_CONFLICT", "目的地已有相同檔案 ID 但內容或附件不同"
                    )
                with destination.payload_path(fid).open("rb") as handle:
                    if (
                        hashlib.file_digest(handle, "sha256").hexdigest()
                        != ref["sha256"]
                    ):
                        raise ComponentError(
                            "FILE_HASH_MISMATCH", "目的地既有素材不符合已登錄的摘要"
                        )
                continue
            writer = stage.new_writer(ref["media_type"], ref["metadata"], file_id=fid)
            try:
                with archive.open(f"media/{ref['sha256']}") as source:
                    while chunk := source.read(CHUNK):
                        writer.write(chunk)
                writer.commit(
                    expected_size=ref["size_bytes"], expected_sha256=ref["sha256"]
                )
            finally:
                writer.abort()
    return refs


@contextmanager
def publish_files(
    stage: FileStore, target: FileStore, refs: list[Doc]
) -> Iterator[None]:
    """Publish only new file IDs; an error before project visibility rolls those publications back."""
    published = []
    try:
        for ref in refs:
            fid = ref["file_id"]
            dest = target.directory(fid)
            try:
                dest.mkdir()
            except FileExistsError:
                if not target.meta(fid) or target.fileref(fid) != ref:
                    raise ComponentError(
                        "STATE_CONFLICT", "目的地檔案已有不同內容或正在寫入"
                    ) from None
                continue
            published.append(fid)
            try:
                stage.directory(fid).rename(dest)
            except FileNotFoundError as exc:
                raise ComponentError(
                    "STATE_CONFLICT", "目的地素材已變動，請重新檢查可攜包"
                ) from exc
        fsync_dir(target.root)
        yield
    except BaseException:
        for fid in reversed(published):
            shutil.rmtree(target.directory(fid), ignore_errors=True)
        raise


def restore(
    ctl: Controller, pid: str, snapshot: Doc, stream: BinaryIO, scratch: Path
) -> Doc:
    """Publish all resources and their project once the archive and target have been checked."""
    if ctl.studio.project_revision(pid) is not None:
        raise ComponentError("STATE_CONFLICT", "專案 ID 已存在，請使用新的專案 ID")
    detach(snapshot, ctl.instance_id, pid)
    stage = FileStore(scratch, ctl.instance_id)
    refs = stage_files(stream, snapshot, stage, ctl.files)
    return ctl.studio.restore_portable(
        pid, snapshot, publish_files(stage, ctl.files, refs)
    )
