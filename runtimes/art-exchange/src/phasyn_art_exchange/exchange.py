"""Stream editor-friendly working packages and validate returned media without extracting archives."""

from __future__ import annotations

import hashlib
import json
import os
import zipfile
from io import RawIOBase
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, override

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_media.files import unchanged_since
from phasyn_media.limits import DEFAULT_LIMITS

from .media import ROLES, Material, alpha_formats, inspect, reference_png


if TYPE_CHECKING:
    from collections.abc import Buffer

    from phasyn_components.provider import InputValue, OutputFile, RunContext


_MANIFEST = "art.exchange-manifest.v1"
_LIMIT = 128 * 1024
_SCHEMA = Path(__file__).with_name("manifest.schema.json")
_IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]
_GEOMETRY = ("width", "height", "rotation_degrees")
_AUDIO = ("has_audio", "audio_sample_rate", "audio_channels")


class _Destination(Protocol):
    def write(self, block: bytes, /) -> object: ...


class _ZipSink(RawIOBase):
    """Write directly into the staged FileStore payload without a duplicate archive."""

    def __init__(self, out: OutputFile) -> None:
        super().__init__()
        self.out = out

    @override
    def writable(self) -> bool:
        return True

    @override
    def write(self, block: Buffer, /) -> int:
        data = memoryview(block).cast("B")
        self.out.write(data)
        return data.nbytes


def _selected(ctx: RunContext, role: str, alpha: dict[str, bool]) -> Material | None:
    options = [
        (f"{kind}_file" if role == "source" else f"{role}_{kind}", kind)
        for kind in ("image", "video")
    ]
    chosen = [
        (port, kind) for port, kind in options if ctx.optional_input(port) is not None
    ]
    if len(chosen) > 1:
        raise ComponentError(
            "INVALID_ARGUMENT", f"Choose one image or one video for {role}"
        )
    if not chosen:
        return None
    port, kind = chosen[0]
    return inspect(ctx, port, role, kind, alpha)


def _source(ctx: RunContext, alpha: dict[str, bool]) -> Material:
    source = _selected(ctx, "source", alpha)
    if source is None:
        raise ComponentError("INVALID_ARGUMENT", "A source image or video is required")
    return source


def _copy(ctx: RunContext, item: Material, target: _Destination) -> None:
    ref = item.record["file"]
    digest = hashlib.sha256()
    remaining = ref["size_bytes"]
    with item.local.path.open("rb") as stream:
        while remaining:
            ctx.check_cancelled()
            block = stream.read(min(1024**2, remaining))
            if not block:
                raise ComponentError("MEDIA_INCOMPLETE", "Source material is truncated")
            target.write(block)
            digest.update(block)
            remaining -= len(block)
        if stream.read(1):
            raise ComponentError(
                "MEDIA_INCOMPLETE", "Source material exceeds its published size"
            )
    if not unchanged_since(item.local) or digest.hexdigest() != ref["sha256"]:
        raise ComponentError(
            "INTEGRITY_MISMATCH", "Art material no longer matches its published digest"
        )


def _alignment(reference: dict[str, Any], plate: dict[str, Any]) -> list[str]:
    changed = [field for field in _GEOMETRY if reference[field] != plate[field]]
    if reference["kind"] == "image" and plate["kind"] == "video":
        changed.append("kind")
    if (
        plate["kind"] == reference["kind"] == "video"
        and reference["clock"]["presentation_sha256"]
        != plate["clock"]["presentation_sha256"]
    ):
        changed.append("frame_clock")
    if (
        reference["sample_aspect_ratio"]
        and plate["sample_aspect_ratio"]
        and reference["sample_aspect_ratio"] != plate["sample_aspect_ratio"]
    ):
        changed.append("sample_aspect_ratio")
    return changed


def _validated(data: Any) -> dict[str, Any]:
    schema = json.loads(_SCHEMA.read_text(encoding="utf-8"))
    contracts.validate_with_schema(
        schema, data, code="INVALID_ARGUMENT", what="美術工作包 manifest"
    )
    a, b, c, d, e, f, g, h, i = data["canvas"]["crop_matrix"]
    if a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) == 0:
        raise ComponentError(
            "INVALID_ARGUMENT", "Crop matrix must describe an invertible transform"
        )
    if (
        data["canvas"]["alpha_interpretation"] != "unspecified"
        and not data["media"]["source"]["alpha_channel"]
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "Alpha interpretation requires a source alpha channel"
        )
    for role, plate in data["media"].items():
        if (
            role != plate["role"]
            or not plate["member"].startswith(f"media/{role}.")
            or (plate["kind"] == "video") != (plate["clock"] is not None)
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "Manifest contains inconsistent media roles or clocks",
            )
    return dict(data)


def _manifest_output(ctx: RunContext, data: dict[str, Any]) -> tuple[bytes, str]:
    payload = canonical_json(_validated(data))
    out = ctx.new_file(
        "manifest_file",
        "application/json",
        {
            "filename": "manifest.json",
            "role": _MANIFEST,
            "source_sha256": data["media"]["source"]["file"]["sha256"],
        },
    )
    out.write(payload)
    ctx.set_file_output("manifest_file", out)
    return payload, ctx.file_ref(out)["sha256"]


def export_art(ctx: RunContext) -> None:
    """Package whole ordinary source bytes, aligned controls, a PNG preview and a manifest."""
    if (
        ctx.optional_input("manifest_file")
        or ctx.parameters.get("role", "source") != "source"
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", "Export takes source and control plates"
        )
    alpha = alpha_formats(ctx)
    source = _source(ctx, alpha)
    plates = {"source": source}
    for role in ROLES[1:]:
        plate = _selected(ctx, role, alpha)
        if plate is not None:
            differences = _alignment(source.record, plate.record)
            if differences:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"Misaligned {role} plate",
                    details={"fields": differences},
                )
            plates[role] = plate
    total_bytes = sum(item.record["file"]["size_bytes"] for item in plates.values())
    if total_bytes > DEFAULT_LIMITS.max_file_bytes:
        raise ComponentError(
            "INPUT_TOO_LARGE", "Combined art plates exceed the local media limit"
        )
    notes = {
        "crop_matrix": ctx.parameters.get("crop_matrix", _IDENTITY),
        "camera_note": ctx.parameters.get("camera_note", ""),
        "color_note": ctx.parameters.get("color_note", ""),
        "alpha_interpretation": ctx.parameters.get(
            "alpha_interpretation", "unspecified"
        ),
    }
    payload, key = _manifest_output(
        ctx,
        {
            "schema_version": "1.0",
            "type": _MANIFEST,
            "canvas": notes,
            "media": {role: item.record for role, item in plates.items()},
        },
    )
    output = ctx.new_file(
        "delivery_file",
        "application/zip",
        {
            "filename": "art-exchange.zip",
            "role": "art_package",
            "manifest_sha256": key,
        },
    )
    space = os.statvfs(output.path.parent)
    if space.f_bavail * space.f_frsize < total_bytes + len(payload):
        raise ComponentError(
            "DISK_FULL", "Insufficient staging space for the art package"
        )
    with (
        _ZipSink(output) as sink,
        zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_STORED) as archive,
    ):
        archive.writestr(zipfile.ZipInfo("manifest.json"), payload)
        archive.writestr(
            zipfile.ZipInfo("reference.png"), reference_png(ctx, source.local.path)
        )
        for material in plates.values():
            member = zipfile.ZipInfo(material.record["member"])
            member.file_size = material.record["file"]["size_bytes"]
            with archive.open(
                member, mode="w", force_zip64=member.file_size >= 2**31 - 1
            ) as target:
                _copy(ctx, material, target)
    ctx.check_cancelled()
    ctx.set_file_output("delivery_file", output)
    ctx.set_output(
        "report",
        {
            "operation": "export",
            "manifest_sha256": key,
            "roles": list(plates),
            "preview": "reference.png",
            "notes": [
                "reference.png is a scaled first-frame preview; edit the matching media member."
            ],
        },
    )


def _read_manifest(ctx: RunContext, ref: InputValue) -> tuple[dict[str, Any], str]:
    if ref.file is None or not 0 < ref.file["size_bytes"] <= _LIMIT:
        raise ComponentError(
            "INVALID_ARGUMENT", "Select a bounded published art manifest JSON"
        )
    ctx.check_cancelled()
    with ref.require_path("manifest_file").open("rb") as stream:
        payload = stream.read(_LIMIT + 1)
    sha = hashlib.sha256(payload).hexdigest()
    if len(payload) != ref.file["size_bytes"] or sha != ref.file["sha256"]:
        raise ComponentError(
            "INTEGRITY_MISMATCH",
            "Selected manifest no longer matches its file reference",
        )
    try:
        data = json.loads(payload)
    except (ValueError, RecursionError) as exc:
        raise ComponentError("INVALID_ARGUMENT", "Invalid art manifest JSON") from exc
    return _validated(data), sha


def return_art(ctx: RunContext) -> None:
    """Validate an ordinary revised plate against its selected role and publish a new copy."""
    if any(
        ctx.optional_input(f"{role}_{kind}")
        for role in ROLES[1:]
        for kind in ("image", "video")
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            "Return accepts one revised plate and its saved manifest",
        )
    data, selected_digest = _read_manifest(ctx, ctx.input("manifest_file"))
    for key, default in (
        ("camera_note", ""),
        ("color_note", ""),
        ("alpha_interpretation", "unspecified"),
        ("crop_matrix", _IDENTITY),
    ):
        incoming = ctx.parameters.get(key, default)
        if incoming != default and incoming != data["canvas"][key]:
            raise ComponentError(
                "INVALID_ARGUMENT", f"Return must use the saved {key} setting"
            )
    role = ctx.parameters.get("role", "source")
    if role not in data["media"]:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "The selected role is absent from the original working package",
        )
    original = data["media"][role]
    revised = _source(ctx, alpha_formats(ctx))
    measured = revised.record
    changed = _alignment(original, measured)
    if measured["kind"] != original["kind"] and "kind" not in changed:
        changed.append("kind")
    if measured["alpha_channel"] != original["alpha_channel"]:
        changed.append("alpha_channel")
    if changed:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "美術修改稿與工作包不相容",
            details={
                "role": role,
                "fields": changed,
                "original": {k: original.get(k, original["clock"]) for k in changed},
                "revised": {k: measured.get(k, measured["clock"]) for k in changed},
            },
        )
    notices = [
        {"field": field, "original": original[field], "revised": measured[field]}
        for field in ("pixel_format", "color", "sample_aspect_ratio", *_AUDIO)
        if original[field] != measured[field]
    ]
    revised_name = measured["member"].split(".")[-1]
    meta = {
        "role": role,
        "filename": f"{role}-revision.{revised_name}",
        "manifest_sha256": selected_digest,
        "original_sha256": original["file"]["sha256"],
        "imported_sha256": measured["file"]["sha256"],
        "operation": "art_return",
    }
    out = ctx.new_file("delivery_file", measured["media_type"], meta)
    _copy(ctx, revised, out)
    ctx.check_cancelled()
    ctx.set_file_output("delivery_file", out)
    _manifest_output(ctx, data)
    ctx.set_output(
        "report",
        {
            "operation": "return",
            "role": role,
            "manifest_sha256": selected_digest,
            "output": ctx.file_ref(out),
            "original_sha256": meta["original_sha256"],
            "identical_bytes": meta["original_sha256"] == meta["imported_sha256"],
            "media_changes": notices,
            "alignment": "matched",
            "alpha_check": "channel_presence",
            "alpha_interpretation": data["canvas"]["alpha_interpretation"],
        },
    )
