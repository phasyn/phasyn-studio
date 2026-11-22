#!/usr/bin/env python3
"""Generate the numeric bounds of the timeline document as Python and TypeScript constants.

``contracts/component.schema.json`` is the single source: scalar bounds are ordinary JSON Schema keywords, and the
few bounds a schema cannot express (seconds, frame rates, the smallest animated mask size) are ``x-phasyn-limits``
annotations on the definition they belong to. The generated modules are

- ``packages/components/src/phasyn_components/timeline_limits.py`` (validation, normalization, commands), and
- ``apps/frontend/src/api/generated/timelineLimits.ts`` (the editor).

A bound that the schema repeats (the sequence length appears on clips, ranges, captions, markers and keys; the
source length on sources, clip ranges and the place command) must be the same everywhere; a difference stops the
generator instead of picking one.

Usage (standard library only; run with ``python3 -I``)::

    python3 -I tools/contracts/timeline_limits.py            # rewrite both modules
    python3 -I tools/contracts/timeline_limits.py --check    # exit 1 when a module has drifted
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "contracts" / "component.schema.json"
PYTHON_OUT = REPO / "packages" / "components" / "src" / "phasyn_components" / "timeline_limits.py"
TS_OUT = REPO / "apps" / "frontend" / "src" / "api" / "generated" / "timelineLimits.ts"
COMMAND = "python3 -I tools/contracts/timeline_limits.py"
MOTION_CHANNELS = ("x", "y", "scale", "rotation", "opacity", "gain_db", "pan")
MASK_CHANNELS = ("x", "y", "width", "height", "feather")

Bounds = dict[str, tuple[float, float]]


class LimitsError(Exception):
    """The schema does not state a bound, or states it in two ways."""


def _at(schema: Mapping[str, Any], pointer: str) -> Any:
    node: Any = schema["$defs"]
    for part in pointer.split("/"):
        try:
            node = node[int(part)] if isinstance(node, list) else node[part]
        except (KeyError, IndexError, ValueError) as exc:
            raise LimitsError(f"the schema has no $defs/{pointer}") from exc
    return node


def _same(schema: Mapping[str, Any], *pointers: str) -> Any:
    values = [_at(schema, pointer) for pointer in pointers]
    if any(value != values[0] for value in values):
        found = ", ".join(f"{pointer}={value}" for pointer, value in zip(pointers, values, strict=True))
        raise LimitsError(f"one bound, several values: {found}")
    return values[0]


def _range(node: Mapping[str, Any], *, exclusive_floor: float | None = None) -> tuple[float, float]:
    """(minimum, maximum) of a numeric property; ``exclusive_floor`` stands in for an exclusive minimum."""
    if "minimum" in node:
        low = float(node["minimum"])
    elif "exclusiveMinimum" in node and exclusive_floor is not None:
        low = exclusive_floor
    else:
        raise LimitsError("a numeric bound has no minimum")
    return low, float(node["maximum"])


def _numeric(properties: Mapping[str, Any], *, exclusive_floor: float | None = None) -> Bounds:
    return {
        name: _range(node, exclusive_floor=exclusive_floor)
        for name, node in properties.items()
        if isinstance(node, Mapping) and node.get("type") == "number"
    }


def _effect_bounds(schema: Mapping[str, Any]) -> dict[str, Bounds]:
    out: dict[str, Bounds] = {}
    for variant in _at(schema, "TimelineEffect/oneOf"):
        properties = variant["properties"]
        out[str(properties["kind"]["const"])] = _numeric(properties)
    return out


def _keyframe_limit(schema: Mapping[str, Any]) -> int:
    pointers = [f"TimelineMotion/properties/keyframes/properties/{name}/maxItems" for name in MOTION_CHANNELS]
    pointers += [f"TimelineMask/properties/keyframes/properties/{name}/maxItems" for name in MASK_CHANNELS]
    for index, variant in enumerate(_at(schema, "TimelineEffect/oneOf")):
        base = f"TimelineEffect/oneOf/{index}/properties/keyframes/properties"
        pointers += [f"{base}/{name}/maxItems" for name in variant["properties"]["keyframes"]["properties"]]
    return int(_same(schema, *pointers))


def _channel_bounds(schema: Mapping[str, Any]) -> tuple[Bounds, Bounds]:
    motion = _numeric(_at(schema, "TimelineMotion/properties"))
    if tuple(motion) != MOTION_CHANNELS:
        raise LimitsError(f"TimelineMotion channels changed: {tuple(motion)}")
    floor = float(_at(schema, "TimelineMask/x-phasyn-limits/animated_size_min"))
    mask = _numeric(_at(schema, "TimelineMask/properties"), exclusive_floor=floor)
    if tuple(mask) != MASK_CHANNELS:
        raise LimitsError(f"TimelineMask channels changed: {tuple(mask)}")
    return motion, mask


def limits(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Every constant by name, in the order the modules list them."""
    timeline = "StudioTimeline/properties"
    effects = "MediaClipEffects/properties"
    extra = _at(schema, "StudioTimeline/x-phasyn-limits")
    source_seconds = int(_at(schema, "TimelineSource/x-phasyn-limits/seconds"))
    source_frames = int(
        _same(
            schema,
            "TimelineSource/properties/duration_frames/maximum",
            "TimelineClip/properties/out_frame/maximum",
            "TimelineCommandPlace/properties/out_frame/maximum",
        )
    )
    if source_frames != source_seconds * int(extra["fps_max"]):
        raise LimitsError("TimelineSource.duration_frames.maximum must be its seconds limit at the highest frame rate")
    first_frames = _same(
        schema, "TimelineClip/properties/in_frame/maximum", "TimelineCommandPlace/properties/in_frame/maximum"
    )
    if int(first_frames) != source_frames - 1:
        raise LimitsError("a clip's in_frame.maximum must be one frame below the source length limit")
    motion, mask = _channel_bounds(schema)
    volume = _range(_at(schema, f"{effects}/volume_db"))
    gain = _range(_at(schema, f"{timeline}/master_gain_db"))
    return {
        "MAX_SEQUENCE_FRAMES": int(
            _same(
                schema,
                "TimelineClip/properties/start_frame/maximum",
                "TimelineOutputWindow/properties/end_frame/maximum",
                "TimelineRange/properties/end_frame/maximum",
                "TimelineCaption/properties/end_frame/maximum",
                "TimelineMarker/properties/frame/maximum",
                "TimelineKeyframe/properties/frame/maximum",
            )
        ),
        "MAX_SEQUENCE_SECONDS": int(extra["seconds"]),
        "MIN_FPS": int(extra["fps_min"]),
        "MAX_FPS": int(extra["fps_max"]),
        "MAX_SOURCE_FRAMES": source_frames,
        "MAX_SOURCE_SECONDS": source_seconds,
        "MAX_SOURCE_SIDE": int(
            _same(schema, "TimelineSource/properties/width/maximum", "TimelineSource/properties/height/maximum")
        ),
        "MAX_TRACKS": int(_at(schema, f"{timeline}/tracks/maxItems")),
        "MAX_CLIPS": int(_at(schema, f"{timeline}/clips/maxItems")),
        "MAX_SOURCES": int(_at(schema, f"{timeline}/sources/maxItems")),
        "MAX_CAPTIONS": int(_at(schema, f"{timeline}/captions/maxItems")),
        "MAX_MARKERS": int(_at(schema, f"{timeline}/markers/maxItems")),
        "MAX_PLACED_SHOTS": int(
            _same(schema, f"{timeline}/placed_shot_ids/maxItems", "StudioProject/properties/shots/maxItems")
        ),
        "MAX_MIGRATION_NOTES": int(_at(schema, f"{timeline}/migration_notes/maxItems")),
        "MAX_MIGRATION_NOTE_CHARS": int(_at(schema, f"{timeline}/migration_notes/items/maxLength")),
        "MAX_KEYFRAMES": _keyframe_limit(schema),
        "MAX_EFFECTS": int(_at(schema, "TimelineClip/properties/effect_stack/maxItems")),
        "MAX_NAME_CHARS": int(
            _same(
                schema,
                "TimelineClip/properties/name/maxLength",
                "TimelineSource/properties/name/maxLength",
                "TimelineTrack/properties/name/maxLength",
                "TimelineMarker/properties/name/maxLength",
            )
        ),
        "MAX_TEXT_CHARS": int(
            _same(schema, "MediaClipTitle/properties/text/maxLength", "TimelineCaption/properties/text/maxLength")
        ),
        "MIN_GAIN_DB": gain[0],
        "MAX_GAIN_DB": gain[1],
        "MIN_SPEED_PERCENT": int(_at(schema, f"{effects}/speed_percent/minimum")),
        "MAX_SPEED_PERCENT": int(_at(schema, f"{effects}/speed_percent/maximum")),
        "MIN_VOLUME_DB": volume[0],
        "MAX_VOLUME_DB": volume[1],
        "MAX_HOLD_FRAMES": int(
            _same(schema, f"{effects}/hold/properties/start/maximum", f"{effects}/hold/properties/end/maximum")
        ),
        "MAX_FADE_FRAMES": int(
            _same(
                schema,
                f"{effects}/fade/properties/video_in/maximum",
                f"{effects}/fade/properties/video_out/maximum",
                f"{effects}/fade/properties/audio_in/maximum",
                f"{effects}/fade/properties/audio_out/maximum",
            )
        ),
        "MAX_FRAME_STEP": int(_at(schema, f"{effects}/frame_step/maximum")),
        "MAX_IMPACT_FRAMES": int(_at(schema, f"{effects}/impact/properties/frames/maximum")),
        "MAX_TRANSITION_FRAMES": int(
            _same(
                schema,
                f"{effects}/transition_out/anyOf/1/properties/frames/maximum",
                "TimelineCommandTransition/properties/frames/maximum",
            )
        ),
        "MAX_COMMANDS": int(_at(schema, "StudioTimelineCommandsRequest/properties/commands/maxItems")),
        "MAX_SRT_CHARS": int(_at(schema, "TimelineCommandCaption/properties/srt/maxLength")),
        "MOTION_BOUNDS": motion,
        "EFFECT_BOUNDS": _effect_bounds(schema),
        "MASK_BOUNDS": mask,
    }


def _py_bounds(bounds: Bounds, indent: str) -> list[str]:
    return [f'{indent}"{name}": ({low!r}, {high!r}),' for name, (low, high) in bounds.items()]


def render_python(values: Mapping[str, Any]) -> str:
    lines = [
        '"""Numeric bounds of the timeline document (generated; do not edit).',
        "",
        "Source: ``contracts/component.schema.json``. Regenerate with",
        f"``{COMMAND}``; ``--check`` reports drift.",
        '"""',
        "",
        "from typing import Final",
        "",
        "",
    ]
    for name, value in values.items():
        if name == "EFFECT_BOUNDS":
            lines.append(f"{name}: Final[dict[str, dict[str, tuple[float, float]]]] = {{")
            for kind, bounds in value.items():
                lines.append(f'    "{kind}": {{')
                lines.extend(_py_bounds(bounds, "        "))
                lines.append("    },")
            lines.append("}")
        elif isinstance(value, dict):
            lines.append(f"{name}: Final[dict[str, tuple[float, float]]] = {{")
            lines.extend(_py_bounds(value, "    "))
            lines.append("}")
        else:
            kind = "int" if isinstance(value, int) else "float"
            lines.append(f"{name}: Final[{kind}] = {value!r}")
    lines += ["", "__all__ = [", *(f'    "{name}",' for name in sorted(values)), "]"]
    return "\n".join(lines) + "\n"


def _ts_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def _ts_bounds(bounds: Bounds, indent: str) -> list[str]:
    return [f"{indent}{name}: [{_ts_number(low)}, {_ts_number(high)}]," for name, (low, high) in bounds.items()]


def render_typescript(values: Mapping[str, Any]) -> str:
    lines = [
        "/* eslint-disable */",
        "/**",
        " * Numeric bounds of the timeline document. Generated from contracts/component.schema.json by",
        " * tools/contracts/timeline_limits.py; do not edit.",
        f" * Regenerate: {COMMAND}",
        " */",
    ]
    for name, value in values.items():
        if name == "EFFECT_BOUNDS":
            lines.append(f"export const {name} = {{")
            for kind, bounds in value.items():
                lines.append(f"  {kind}: {{")
                lines.extend(_ts_bounds(bounds, "    "))
                lines.append("  },")
            lines.append("} as const;")
        elif isinstance(value, dict):
            lines.append(f"export const {name} = {{")
            lines.extend(_ts_bounds(value, "  "))
            lines.append("} as const;")
        else:
            lines.append(f"export const {name} = {_ts_number(value)};")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="only report drift; do not write")
    parser.add_argument("--schema", type=Path, default=SCHEMA)
    parser.add_argument("--python-out", type=Path, default=PYTHON_OUT)
    parser.add_argument("--ts-out", type=Path, default=TS_OUT)
    args = parser.parse_args(argv)

    try:
        values = limits(json.loads(args.schema.read_text(encoding="utf-8")))
    except LimitsError as exc:
        print(f"{args.schema.name}: {exc}", file=sys.stderr)
        return 1
    stale = 0
    for path, text in ((args.python_out, render_python(values)), (args.ts_out, render_typescript(values))):
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current == text:
            continue
        if args.check:
            print(f"{path.name} is out of date; run: {COMMAND}", file=sys.stderr)
            stale = 1
        else:
            path.write_text(text, encoding="utf-8")
            print(f"updated {path.name}")
    return stale


if __name__ == "__main__":
    sys.exit(main())
