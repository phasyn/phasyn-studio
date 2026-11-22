"""Versioned Wan-Animate reference, face and pose media shared by independent candidates."""

from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError
from phasyn_components.typed import file_links
from phasyn_media.limits import DEFAULT_LIMITS
from phasyn_media.probe import probe

from .sources import ENGINE_REVISION, MODELS, regular


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import RunContext


_MEMBERS = {
    "reference": ("src_ref.png", "image/png"),
    "face": ("src_face.mp4", "video/mp4"),
    "pose": ("src_pose.mp4", "video/mp4"),
}
_FORMAT = "wan.animate-conditioning.v1"
_MANIFEST_TYPE = "application/vnd.phasyn.wan-animate-conditioning+json"
_MAX_MANIFEST = 16 * 1024
_MAX_RECENT = 16
_CHUNK = 1024 * 1024


def _json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def recipe(ctx: RunContext, size: str, environment: str) -> dict[str, Any]:
    """Bind preparation to actual inputs and the preprocessing environment, independent of denoising."""
    return {
        "format": _FORMAT,
        "engine_revision": ENGINE_REVISION,
        "model_revision": MODELS["performance"][1],
        "environment": environment,
        "source_sha256": {
            port: (ctx.input(port).file or {})["sha256"]
            for port in ("character", "driving")
        },
        "size": size,
        "fps": 30,
        "retarget": True,
    }


def digest(settings: Mapping[str, Any]) -> str:
    """Content address of the exact preparation recipe."""
    return hashlib.sha256(_json(settings)).hexdigest()


def _read_manifest(path: Path, ref: Mapping[str, Any]) -> dict[str, Any]:
    with regular(path) as stream:
        raw = stream.read(_MAX_MANIFEST + 1)
    if len(raw) > _MAX_MANIFEST or hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
        raise ComponentError("INTEGRITY_MISMATCH", "表演條件索引與檔案摘要不符")
    try:
        doc = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ComponentError("INVALID_ARGUMENT", "表演條件索引格式錯誤") from error
    if not isinstance(doc, dict):
        raise ComponentError("INVALID_ARGUMENT", "表演條件索引必須是物件")
    return doc


def _check_media(ctx: RunContext, directory: Path) -> None:
    seconds = (ctx.settings["load"].get("provider_options") or {}).get(
        "max_duration_seconds", 30
    )
    limits = replace(DEFAULT_LIMITS, max_duration_seconds=seconds + 1)
    reference = probe(
        directory / _MEMBERS["reference"][0], limits=limits, cancel=ctx.cancel_token
    )
    if reference.kind != "image":
        raise ComponentError("INVALID_ARGUMENT", "表演條件的參考圖格式不符")
    counts = set()
    for role in ("face", "pose"):
        clip = probe(
            directory / _MEMBERS[role][0], limits=limits, cancel=ctx.cancel_token
        )
        if (
            clip.kind != "video"
            or clip.video_streams != 1
            or not clip.frame_count
            or not clip.frame_count_exact
        ):
            raise ComponentError(
                "INVALID_ARGUMENT", "表演條件影片的影格數或媒體格式不符"
            )
        counts.add(clip.frame_count)
    if len(counts) != 1:
        raise ComponentError("INVALID_ARGUMENT", "臉部與姿態影片的影格數不相符")


def _restore(
    ctx: RunContext,
    ref: Mapping[str, Any],
    settings: Mapping[str, Any],
    directory: Path,
) -> None:
    if ref.get("media_type") != _MANIFEST_TYPE:
        raise ComponentError("INVALID_ARGUMENT", "請選擇 Wan 表演條件索引")
    doc = _read_manifest(ctx.resolve_file(ref), ref)
    if doc.get("recipe") != settings:
        raise ComponentError(
            "UNSUPPORTED_COMBINATION", "表演條件的來源、尺寸或前處理版本不同"
        )
    links = file_links(ref)
    expected = doc.get("sha256")
    if (
        links.keys() != _MEMBERS.keys()
        or not isinstance(expected, dict)
        or expected.keys() != _MEMBERS.keys()
    ):
        raise ComponentError("INTEGRITY_MISMATCH", "表演條件缺少參考圖、臉部或姿態素材")
    # Resolve every link before creating files; a purged automatic hit can then fall back cleanly.
    paths = {role: ctx.resolve_file(link) for role, link in links.items()}
    directory.mkdir()
    for role, (name, mime) in _MEMBERS.items():
        link = links[role]
        if link["sha256"] != expected[role] or link["media_type"] != mime:
            raise ComponentError("INTEGRITY_MISMATCH", "表演條件的素材身分不同")
        checksum = hashlib.sha256()
        with regular(paths[role]) as source, (directory / name).open("xb") as output:
            size = os.fstat(source.fileno()).st_size
            if (
                size != link["size_bytes"]
                or not 0 < size <= DEFAULT_LIMITS.max_file_bytes
            ):
                raise ComponentError("FILE_TRUNCATED", "表演條件素材大小不符")
            while chunk := source.read(_CHUNK):
                ctx.check_cancelled()
                output.write(chunk)
                checksum.update(chunk)
        if checksum.hexdigest() != link["sha256"]:
            raise ComponentError("INTEGRITY_MISMATCH", "表演條件素材雜湊不符")
    _check_media(ctx, directory)


def publish(
    ctx: RunContext, directory: Path, settings: Mapping[str, Any]
) -> dict[str, Any]:
    """Give this run its own immutable files so purging one candidate cannot delete another's controls."""
    links: dict[str, Any] = {}
    for role, (name, mime) in _MEMBERS.items():
        output = ctx.new_file(None, mime, {"role": role})
        with regular(directory / name) as source:
            if (
                not 0
                < os.fstat(source.fileno()).st_size
                <= DEFAULT_LIMITS.max_file_bytes
            ):
                raise ComponentError("RESOURCE_EXHAUSTED", "表演條件素材大小超出範圍")
            while chunk := source.read(_CHUNK):
                ctx.check_cancelled()
                output.write(chunk)
        output.finish()
        links[role] = ctx.file_ref(output)
    ref = ctx.new_file(
        "conditioning",
        _MANIFEST_TYPE,
        {"recipe_sha256": digest(settings), "links": links},
    )
    ref.write(
        _json(
            {"recipe": settings, "sha256": {k: v["sha256"] for k, v in links.items()}}
        )
    )
    ref.finish()
    ctx.set_file_output("conditioning", ref)
    return ctx.file_ref(ref)


class RecentControls:
    """Bounded in-memory references to already published controls of the loaded component."""

    def __init__(self) -> None:
        """Initialize an empty index per loaded instance."""
        self.entries: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def restore(
        self, ctx: RunContext, settings: Mapping[str, Any], directory: Path
    ) -> str:
        """Prefer an explicit artifact; recompute an automatic lookup only when its files are gone."""
        given = ctx.optional_input("prepared")
        key = digest(settings)
        ref = given.file if given is not None else self.entries.get(key)
        if ref is None:
            if given is not None:
                raise ComponentError("INVALID_ARGUMENT", "表演條件需要檔案輸入")
            return "miss"
        try:
            _restore(ctx, ref, settings, directory)
        except ComponentError as error:
            if given is not None or error.code != "FILE_NOT_FOUND":
                raise
            self.entries.pop(key, None)
            return "miss"
        return "provided" if given is not None else "hit"

    def remember(self, settings: Mapping[str, Any], ref: dict[str, Any]) -> None:
        """Retain only recent lookup keys; the Node owns the public media's storage lifetime."""
        key = digest(settings)
        self.entries[key] = ref
        self.entries.move_to_end(key)
        if len(self.entries) > _MAX_RECENT:
            self.entries.popitem(last=False)
