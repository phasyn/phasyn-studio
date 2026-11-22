"""Resolve a source-relative transcript from the run that actually published it."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_server.http import parse_json_bytes

from .studio_media_probe import inspect_source
from .studio_take_source import published, step_source


if TYPE_CHECKING:
    from .state import Controller

type Doc = dict[str, Any]
_DAY_MS = 86_400_000
_MAX_TRANSCRIPT = 8 * 1024 * 1024


def _bad() -> ComponentError:
    return ComponentError(
        "INVALID_ARGUMENT", "轉錄檔的來源、時間基準或段落資料無法核對"
    )


def transcript_output(run: Doc, key: str) -> tuple[Doc, Doc]:
    """Find the declared report in this successful step's published outputs."""
    edge = run["request"]["pipeline"]["outputs"].get(key, {})
    step, typed = step_source(run, edge)
    if (
        typed != run.get("outputs", {}).get(key)
        or typed.get("type_id") != "speech.transcript.v1"
        or not contracts.is_valid("FileRef", typed.get("file"))
    ):
        raise _bad()
    return step, typed["file"]


def _source_file(run: Doc, step: Doc, source: Doc) -> Doc:
    for edge in step["inputs"].values():
        value: Doc | None
        if "from_step" in edge:
            _, value = step_source(run, edge)
        elif "from_input" in edge:
            value = run["request"]["inputs"].get(edge["from_input"], {})
        else:
            value = edge.get("literal", {})
        if not isinstance(value, dict):
            continue
        file = value.get("file") or {}
        if (
            value.get("type_id") in {"media.audio.v1", "media.video.v1"}
            and all(
                file.get(key) == source.get(key) for key in ("sha256", "size_bytes")
            )
            and contracts.is_valid("FileRef", file)
        ):
            return file
    raise _bad()


async def load_transcript(
    ctl: Controller,
    run: Doc,
    key: str,
    output: tuple[Doc, Doc],
    *,
    dry_run: bool = False,
) -> Doc:
    """Read bounded, hash-verified JSON and check its reported clock and input."""
    step, ref = output
    data = parse_json_bytes(
        await published(ctl, ref, manifest=True, limit=_MAX_TRANSCRIPT), what="語音轉錄"
    )
    if not isinstance(data, dict) or (
        data.get("schema_version"),
        data.get("time_basis"),
    ) not in (("1.0", "source_media"), ("1.1", "container_start")):
        raise _bad()
    origin = data.get("source")
    if not isinstance(origin, dict):
        raise _bad()
    source = origin.get("file")
    segments = data.get("segments")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("sha256"), str)
        or type(source.get("size_bytes")) is not int
        or not isinstance(segments, list)
    ):
        raise _bad()
    original = _source_file(run, step, source)
    clean = []
    last_start = -1
    spans = set()
    for row in segments:
        if not isinstance(row, dict):
            raise _bad()
        first, last, text = row.get("start_ms"), row.get("end_ms"), row.get("text")
        if (
            type(first) is not int
            or type(last) is not int
            or not 0 <= first < last <= _DAY_MS
            or first < last_start
            or (first, last) in spans
            or not isinstance(text, str)
            or not text.strip()
        ):
            raise _bad()
        spans.add((first, last))
        last_start = first
        clean.append({"start_ms": first, "end_ms": last, "text": text.strip()})
    if data["schema_version"] == "1.0":
        offset = (await inspect_source(ctl, original, dry_run=dry_run))[
            "clip_origin_offset"
        ]
    else:
        offset = origin.get("clip_origin_offset")
    if (
        not isinstance(offset, dict)
        or type(offset.get("num")) is not int
        or type(offset.get("den")) is not int
        or offset["den"] <= 0
    ):
        raise _bad()
    return {
        "clip_origin_offset": {"num": offset["num"], "den": offset["den"]},
        "run_id": run["run_id"],
        "output_key": key,
        "file": ref,
        "sha256": source["sha256"],
        "size_bytes": source["size_bytes"],
        "segments": clean,
    }
