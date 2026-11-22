"""Build a revision-bound OTIO exchange on disk and serve its verified files with bounded memory."""

from __future__ import annotations

import errno
import hashlib
import json
import shutil
import tempfile
import zipfile
from collections.abc import AsyncIterator, Iterator
from contextlib import ExitStack, asynccontextmanager
from fractions import Fraction
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, BinaryIO

from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_uuid
from phasyn_components.timeline_edit.otio_delivery import delivery_document
from phasyn_server.files import file_response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse

from .files import proxy_node_file


if TYPE_CHECKING:
    from .state import Controller


_CHUNK = 1024 * 1024


def _json(doc: Any) -> bytes:
    return json.dumps(
        doc, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
    ).encode("utf-8")


def _entries(
    record: dict[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    files: dict[str, list[dict[str, Any]]] = {}
    missing = []
    for source in record["media"]:
        owner = {
            k: source[k]
            for k in ("name", "source_id", "shot_id", "take_id", "library_id")
        }
        if source["original"] is None and source["kind"] not in {"text", "adjustment"}:
            missing.append({**owner, "role": "original", "reason": "no_source_file"})
        for role in ("original", "proxy"):
            ref = source[role]
            if ref is not None:
                files.setdefault(ref["target_url"], []).append(
                    {**ref, **owner, "role": role}
                )
    for item in record.get("auxiliary", []):
        ref = item["file"]
        files.setdefault(ref["target_url"], []).append(
            {**ref, **{k: item[k] for k in ("name", "role", "owner_id")}}
        )
    return files, missing


@asynccontextmanager
async def _file(
    ctl: Controller, ref: dict[str, Any]
) -> AsyncIterator[StreamingResponse | None]:
    nid, fid = (
        require_uuid(ref["node_id"], "node_id"),
        require_uuid(ref["file_id"], "file_id"),
    )
    try:
        response = (
            await file_response(ctl.files, fid, None)
            if nid == ctl.instance_id
            else await proxy_node_file(ctl, nid, fid, None)
        )
    except ComponentError as error:
        if error.code != "FILE_NOT_FOUND":
            raise
        yield None
        return
    try:
        if response.status_code == HTTPStatus.NOT_FOUND:
            yield None
        elif response.status_code == HTTPStatus.OK and isinstance(
            response, StreamingResponse
        ):
            yield response
        else:
            raise ComponentError(
                "RUNTIME_ERROR",
                "讀取剪輯交換素材失敗",
                details={"status": response.status_code},
                status=502,
            )
    finally:
        if response.background is not None:
            await response.background()


async def _include(
    ctl: Controller, archive: zipfile.ZipFile, target: str, refs: list[dict[str, Any]]
) -> bool:
    size = refs[0]["size_bytes"]
    if any(ref["size_bytes"] != size for ref in refs):
        raise ComponentError("FILE_HASH_MISMATCH", "相同雜湊的剪輯素材記載了不同的長度")
    seen: set[tuple[str, str]] = set()
    for ref in refs:
        key = ref["node_id"], ref["file_id"]
        if key in seen:
            continue
        seen.add(key)
        async with _file(ctl, ref) as response:
            if response is None:
                continue
            count, digest = 0, hashlib.sha256()
            with archive.open(target, "w", force_zip64=True) as output:
                async for chunk in response.body_iterator:
                    if isinstance(chunk, str):
                        raise ComponentError(
                            "RUNTIME_ERROR", "剪輯素材回覆必須是檔案位元組"
                        )
                    count += len(chunk)
                    if count > size:
                        raise ComponentError(
                            "FILE_HASH_MISMATCH", "剪輯素材超出登錄的檔案長度"
                        )
                    digest.update(chunk)
                    await run_in_threadpool(output.write, chunk)
            if count != size or digest.hexdigest() != ref["sha256"]:
                raise ComponentError(
                    "FILE_HASH_MISMATCH", "剪輯素材與登錄的大小或雜湊不符"
                )
            return True
    return False


def _subtitles(timeline: dict[str, Any]) -> str:
    fps = timeline["fps"]

    def stamp(frame: int) -> str:
        ticks = Fraction(frame * 1000 * fps["den"], fps["num"])
        ms = int(ticks + Fraction(1, 2))
        seconds, ms = divmod(ms, 1000)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"

    captions = sorted(timeline["captions"], key=lambda cue: cue["start_frame"])
    return "".join(
        f"{n}\n{stamp(cue['start_frame'])} --> {stamp(cue['end_frame'])}\n{cue['text']}\n\n"
        for n, cue in enumerate(captions, 1)
    )


def _generated_files(
    snapshot: dict[str, Any], entries: dict[str, list[dict[str, Any]]]
) -> None:
    reference = snapshot.get("reference")
    if reference:
        entries["reference.mp4"] = [
            {**reference["file"], "role": "full_timeline_reference"}
        ]
    bakes = snapshot.get("bakes")
    if bakes:
        for region in bakes["regions"]:
            entries.setdefault(region["target_url"], []).append(
                {**region["file"], "role": "delivery_bake", "key": region["key"]}
            )


async def _write(ctl: Controller, stream: BinaryIO, snapshot: dict[str, Any]) -> None:
    document = snapshot["document"]
    record = document["metadata"]["phasyn"]
    entries, missing = _entries(record)
    _generated_files(snapshot, entries)
    reference, bakes = snapshot.get("reference"), snapshot.get("bakes")
    size = sum(refs[0]["size_bytes"] for refs in entries.values())
    free = (await run_in_threadpool(shutil.disk_usage, ctl.data_dir)).free
    if size > free:
        raise ComponentError(
            "DISK_FULL",
            "暫存剪輯交換包的磁碟空間不足",
            details={"media_bytes": size, "free_bytes": free},
        )
    manifest = {
        key: snapshot[key] for key in ("project_id", "revision", "title", "takes")
    }
    manifest.update(
        fps=record["fps"],
        sources=record["media"],
        reference_run_id=reference["run_id"] if reference else None,
        subtitles="subtitles.srt",
        auxiliary=record.get("auxiliary", []),
        files=[],
    )
    if bakes:
        manifest["delivery"] = {
            "profile": "kdenlive-composite-v1",
            "document": "delivery.otio",
            "original_document": "timeline.otio",
            "bake_run_id": bakes["run_id"],
            "regions": bakes["regions"],
            "subtitles": "Visible captions are included in picture bakes. subtitles.srt is a separate text reference.",
            "audio": "Audio tracks remain separate. Picture bakes have silent audio.",
            "handles": "first and last are available sequence frames [first,last); start and end select the used cut.",
        }
    with zipfile.ZipFile(stream, mode="w", allowZip64=True) as archive:
        await run_in_threadpool(
            archive.writestr, "timeline.otio", _json(document), zipfile.ZIP_DEFLATED
        )
        if bakes:
            projection = await run_in_threadpool(
                delivery_document, document, bakes["regions"]
            )
            await run_in_threadpool(
                archive.writestr,
                "delivery.otio",
                _json(projection),
                zipfile.ZIP_DEFLATED,
            )
        await run_in_threadpool(
            archive.writestr,
            "subtitles.srt",
            _subtitles(json.loads(record["snapshot_json"])).encode("utf-8"),
            zipfile.ZIP_DEFLATED,
        )
        for target, refs in entries.items():
            included = await _include(ctl, archive, target, refs)
            if not included and target == "reference.mp4":
                raise ComponentError("FILE_NOT_FOUND", "合成參考片檔案已無法讀取")
            if not included and target.startswith("bakes/"):
                raise ComponentError("FILE_NOT_FOUND", "交付用效果素材已無法讀取")
            if not included:
                missing.extend({**ref, "reason": "file_not_found"} for ref in refs)
            manifest["files"].append(
                {
                    "target_url": target,
                    "sha256": refs[0]["sha256"],
                    "size_bytes": refs[0]["size_bytes"],
                    "included": included,
                    "uses": refs,
                }
            )
        report = {
            "conversion": record["report"],
            "missing": missing,
            "media_complete": not missing,
        }
        if bakes:
            report["delivery"] = manifest["delivery"]
        await run_in_threadpool(
            archive.writestr, "manifest.json", _json(manifest), zipfile.ZIP_DEFLATED
        )
        await run_in_threadpool(
            archive.writestr,
            "conversion-report.json",
            _json(report),
            zipfile.ZIP_DEFLATED,
        )


def _blocks(stream: BinaryIO) -> Iterator[bytes]:
    try:
        while chunk := stream.read(_CHUNK):
            yield chunk
    finally:
        stream.close()


async def exchange_response(
    ctl: Controller, snapshot: dict[str, Any]
) -> StreamingResponse:
    """Verify the entire archive before emitting success headers, including for non-seekable clients."""
    try:
        with ExitStack() as owner:
            stream = owner.enter_context(tempfile.TemporaryFile(dir=ctl.data_dir))
            await _write(ctl, stream, snapshot)
            size = stream.tell()
            stream.seek(0)
            name = f"studio-{snapshot['project_id']}-r{snapshot['revision']}.zip"
            response = StreamingResponse(
                _blocks(stream),
                media_type="application/zip",
                background=BackgroundTask(stream.close),
                headers={
                    "Content-Disposition": f'attachment; filename="{name}"',
                    "Content-Length": str(size),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
            owner.pop_all()  # The response iterator and its background callback now own the file.
    except OSError as error:
        if error.errno == errno.ENOSPC:
            raise ComponentError("DISK_FULL", "暫存剪輯交換包的磁碟空間不足") from error
        raise
    else:
        return response
