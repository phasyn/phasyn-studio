"""Read finished runs back into the Studio projects that rendered them.

A video take or an export is written as ``rendering`` when its run is sent and only became final when a client read
the run back: an open Studio tab (``useRenderTracker``) or an API client. A project nobody had open kept
``rendering`` takes for hours after their runs had succeeded. The Controller now reads every finished run back itself,
through the ordinary save path (revision + 1, audit line ``run-backfill``).

The rules are the Studio's (``apps/frontend`` ``pipelines.ts`` ``takeOutcome``/``exportOutcome`` and
``useRenderTracker``), ported here; a change to one copy must be made to both.

- A finished run is read back ``BACKFILL_DELAY_S`` after it ends, so an open tab, which reads it back at once, usually
  saves first and the Controller then finds nothing left to change (no revision conflict in that tab).
- At start-up every ``rendering`` take or export whose run is no longer live is read back once: runs that ended while
  the Controller was stopped (``interrupted``) or whose delayed read-back was cut short by a stop.
- Only ``rendering`` entries change; the project is read again under the store lock before the write, so a person's
  edit is never overwritten.
- Image takes follow the Image Studio's read-back (``image-studio`` ``outcome.ts`` ``imageTakeOutcome`` and
  ``reconcile.ts``; the CLI's ``image_model.reconcile_images``): the first succeeded take of a run becomes the image's
  active one, and a take sent with ``auto_library`` adds its white-matte copy to the project library, also when no
  page was open when it finished.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable, Mapping
from datetime import datetime
from fractions import Fraction
from typing import Any, TypeGuard

from phasyn_components.timeline_limits import MAX_FPS, MIN_FPS
from phasyn_components.timeutil import utc_now


BACKFILL_DELAY_S = 30.0
TERMINAL_RUN_STATES = frozenset({"succeeded", "failed", "cancelled", "interrupted"})
AUDIT_PATH = "run-backfill"

RANDOM_SEED = -1
FINAL_KEY = re.compile(r"^final(_\d+)?$")
ASSET_KINDS = frozenset({"preview", "final", "video", "audio"})
# A Studio take-level code that the client invents (apps/frontend src/i18n/errors.ts CLIENT_CODES), never a server
# error: the read-back here acts as that client, so it is not in phasyn_components.errors.ERROR_CODES.
OUTPUT_MISSING = "OUTPUT_MISSING"

OUTPUT_IMAGE = "image"
OUTPUT_WHITE = "image_white"
MAX_LIBRARY_ITEMS = 500
MAX_IMAGE_DIMENSION = 16384
MAX_ID = 160
SUFFIX_RE = re.compile(r"(_\d+)$")


# --------------------------------------------------------------------------- values as the Studio keeps them


def _number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


def is_file_ref(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("node_id"), str)
        and isinstance(value.get("file_id"), str)
        and _number(value.get("size_bytes"))
        and isinstance(value.get("sha256"), str)
        and isinstance(value.get("media_type"), str)
        and isinstance(value.get("metadata"), dict)
    )


def _latent_ref(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not is_file_ref(value.get("manifest_file")):
        return None
    keys = ("latent_id", "blob_sha256", "manifest_sha256")
    return value if all(isinstance(value.get(key), str) for key in keys) else None


def as_asset(value: Any) -> dict[str, Any] | None:
    """A run's asset value as the Studio keeps it (api/types.ts asAsset); None when it is not a well-formed asset."""
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("asset_id"), str)
        or value.get("kind") not in ASSET_KINDS
    ):
        return None
    if not is_file_ref(value.get("file")):
        return None
    fps = value.get("fps")
    return {
        "asset_id": value["asset_id"],
        "kind": value["kind"],
        "file": value["file"],
        "source_latent": _latent_ref(value.get("source_latent")),
        "frame_count": value["frame_count"] if _number(value.get("frame_count")) else 0,
        "fps": {"num": fps["num"], "den": fps["den"]}
        if isinstance(fps, dict) and _number(fps.get("num")) and _number(fps.get("den"))
        else None,
        "width": value["width"] if _number(value.get("width")) else 0,
        "height": value["height"] if _number(value.get("height")) else 0,
        "complete": value.get("complete") is True,
        "actual_settings": value["actual_settings"]
        if isinstance(value.get("actual_settings"), dict)
        else {},
    }


def as_error(value: Any) -> dict[str, Any] | None:
    """A step error as the Studio keeps it (api/types.ts asApiErrorBody)."""
    if not isinstance(value, dict) or not isinstance(value.get("code"), str):
        return None
    out: dict[str, Any] = {
        "code": value["code"],
        "message": value["message"] if isinstance(value.get("message"), str) else "",
    }
    if isinstance(value.get("details"), dict):
        out["details"] = value["details"]
    out["remote_outcome_unknown"] = value.get("remote_outcome_unknown") is True
    return out


def _output_asset(step: Mapping[str, Any] | None, output: str) -> dict[str, Any] | None:
    value = ((step or {}).get("outputs") or {}).get(output)
    if (
        (step or {}).get("state") != "succeeded"
        or not isinstance(value, dict)
        or "value" not in value
    ):
        return None
    return as_asset(value["value"])


def _elapsed(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        ms = (
            datetime.fromisoformat(end) - datetime.fromisoformat(start)
        ).total_seconds() * 1000
    except ValueError:
        return None
    return round(ms) if ms >= 0 else None


# --------------------------------------------------------------------------- one take's result


def _pipeline(run: Mapping[str, Any]) -> Mapping[str, Any]:
    pipeline = (run.get("request") or {}).get("pipeline")
    return pipeline if isinstance(pipeline, Mapping) else {}


def _branch_suffixes(run: Mapping[str, Any]) -> list[str]:
    suffixes = {
        m.group(1) or ""
        for key in _pipeline(run).get("outputs") or {}
        if (m := FINAL_KEY.match(key))
    }
    if not suffixes or "" in suffixes:
        return [""]
    return sorted(suffixes, key=lambda s: int(s[1:]))


def _branch_steps(run: Mapping[str, Any], output_key: str) -> list[str]:
    match = FINAL_KEY.match(output_key)
    suffix = (match.group(1) or "") if match else ""
    order = [str(s["step_id"]) for s in _pipeline(run).get("steps") or []]
    ids = order + [sid for sid in (run.get("steps") or {}) if sid not in order]
    suffixes = _branch_suffixes(run)
    if suffixes == [""]:
        return ids

    def own(sid: str) -> str:
        return next(
            (s for s in suffixes if s and len(sid) > len(s) and sid.endswith(s)), ""
        )

    return [sid for sid in ids if own(sid) == suffix]


def _first_frame_step(run: Mapping[str, Any], ids: list[str]) -> str | None:
    """The branch step whose output feeds a TE's first_frame input (the frame taken from the previous shot)."""
    own = set(ids)
    for step in _pipeline(run).get("steps") or []:
        if str(step.get("step_id")) not in own:
            continue
        binding = (step.get("inputs") or {}).get("first_frame")
        if isinstance(binding, dict) and str(binding.get("from_step")) in own:
            return str(binding["from_step"])
    return None


def _frame_rate(value: object) -> Fraction | None:
    if not isinstance(value, Mapping):
        return None
    num, den = value.get("num"), value.get("den")
    if (
        type(num) is not int
        or type(den) is not int
        or not (0 < num <= 2**53 - 1 and 0 < den <= 2**53 - 1)
    ):
        return None
    rate = Fraction(num, den)
    return rate if MIN_FPS <= rate <= MAX_FPS else None


def _delivery_error(
    take: Mapping[str, Any], asset: Mapping[str, Any], output: Mapping[str, Any]
) -> dict[str, Any] | None:
    """Check the declared delivery saved by a new Studio render against its branch output."""
    expected = take.get("expected_fps")
    if expected is None:
        return None
    actual = _frame_rate(asset["fps"])
    if (
        output.get("type_id") == "media.asset.v1"
        and asset["kind"] in {"final", "video"}
        and asset["complete"]
        and asset["file"]["media_type"].startswith("video/")
        and min(asset["file"]["size_bytes"], asset["width"], asset["height"]) > 0
        and type(asset["frame_count"]) is int
        and asset["frame_count"] == take.get("frames")
        and actual is not None
        and actual == _frame_rate(expected)
    ):
        return None
    return {
        "code": "STUDIO_OUTPUT_MISMATCH",
        "message": "The delivered video does not match the shot's requested duration or frame rate.",
        "details": {
            "expected_frames": take.get("frames"),
            "expected_fps": expected,
            "actual_frames": asset["frame_count"],
            "actual_fps": asset["fps"],
            "kind": asset["kind"],
            "complete": asset["complete"],
        },
    }


def take_outcome(run: Mapping[str, Any], take: Mapping[str, Any]) -> dict[str, Any]:
    """The take's result from its run (pipelines.ts takeOutcome, plus the first frame a continuation used)."""
    ids = _branch_steps(run, str(take.get("output_key")))
    run_steps = run.get("steps") or {}
    ref = (_pipeline(run).get("outputs") or {}).get(take.get("output_key"))
    asset = (
        _output_asset(run_steps.get(ref["from_step"]), ref["output"])
        if isinstance(ref, dict)
        else None
    )
    latent_value = next(
        (
            outputs["video_latent"]
            for sid in ids
            if "video_latent"
            in (outputs := (run_steps.get(sid) or {}).get("outputs") or {})
        ),
        None,
    )
    latent = latent_value.get("file") if isinstance(latent_value, dict) else None
    suffixes = _branch_suffixes(run)
    timings: dict[str, int | None] = {}
    for sid in ids:
        step = run_steps.get(sid) or {}
        base = next(
            (
                sid[: -len(s)]
                for s in suffixes
                if s and len(sid) > len(s) and sid.endswith(s)
            ),
            sid,
        )
        timings[base] = _elapsed(step.get("started_at"), step.get("finished_at"))
    outcome: dict[str, Any]
    if asset and isinstance(ref, dict):
        output = run_steps[ref["from_step"]]["outputs"][ref["output"]]
        delivery_error = _delivery_error(take, asset, output)
        outcome = {
            "state": "failed" if delivery_error else "succeeded",
            "asset": None if delivery_error else asset,
            "video_latent": None if delivery_error else latent,
            "error": delivery_error,
            "timings_ms": timings,
        }
    elif run.get("state") == "running":
        outcome = {
            "state": "rendering",
            "asset": None,
            "video_latent": None,
            "error": None,
            "timings_ms": timings,
        }
    else:
        state = {"cancelled": "cancelled", "interrupted": "interrupted"}.get(
            str(run.get("state")), "failed"
        )
        failed = next(
            (
                error
                for sid in ids
                if (error := as_error((run_steps.get(sid) or {}).get("error")))
            ),
            None,
        )
        error = (
            failed
            or run.get("error")
            or (
                {
                    "code": OUTPUT_MISSING,
                    "message": "the run succeeded but has no output for this shot",
                }
                if run.get("state") == "succeeded"
                else None
            )
        )
        outcome = {
            "state": state,
            "asset": None,
            "video_latent": None,
            "error": error,
            "timings_ms": timings,
        }
    used = take.get("continuity")
    if isinstance(used, dict) and used.get("mode") == "previous_last":
        frame_id = _first_frame_step(run, ids)
        frame = run_steps.get(frame_id) if frame_id else None
        image = ((frame or {}).get("outputs") or {}).get("image")
        first = (
            image.get("file")
            if (frame or {}).get("state") == "succeeded" and isinstance(image, dict)
            else None
        )
        outcome["continuity"] = {
            **used,
            "first_frame": first or used.get("first_frame"),
        }
    elif isinstance(used, dict):
        outcome["continuity"] = used
    return outcome


def export_outcome(run: Mapping[str, Any]) -> dict[str, Any]:
    """An export's result from its run (pipelines.ts exportOutcome)."""
    concat = (run.get("steps") or {}).get("concat") or {}
    asset = _output_asset(concat, "asset")
    if asset:
        return {
            "state": "succeeded",
            "asset": asset,
            "error": None,
            "frames": asset.get("frame_count"),
        }
    if run.get("state") == "running":
        return {"state": "rendering", "asset": None, "error": None, "frames": None}
    state = {"cancelled": "cancelled", "interrupted": "interrupted"}.get(
        str(run.get("state")), "failed"
    )
    return {
        "state": state,
        "asset": None,
        "error": as_error(concat.get("error")) or run.get("error"),
        "frames": None,
    }


# --------------------------------------------------------------------------- one image take's result


def image_snapshot(raw: Any) -> dict[str, Any] | None:
    """A take's params_snapshot when it is one (params.ts parseSnapshot, the fields read here)."""
    if not isinstance(raw, dict) or raw.get("v") != 1:
        return None
    outputs = raw.get("outputs") if isinstance(raw.get("outputs"), dict) else None
    if (
        raw.get("mode") not in ("t2i", "i2i")
        or not outputs
        or not isinstance(outputs.get("image"), str)
    ):
        return None
    return raw


def as_image_asset(value: Any) -> dict[str, Any] | None:
    """An image asset as the Image Studio keeps it (outcome.ts asImageAsset)."""
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("asset_id"), str)
        or not is_file_ref(value.get("file"))
    ):
        return None
    source = (
        value.get("source_take") if isinstance(value.get("source_take"), dict) else None
    )
    keys = ("project_id", "image_shot_id", "take_id")

    def number(key: str) -> Any:
        raw = value.get(key)
        return raw if _number(raw) else 0

    return {
        "asset_id": value["asset_id"],
        "file": value["file"],
        "width": number("width"),
        "height": number("height"),
        "mode": "RGB" if value.get("mode") == "RGB" else "RGBA",
        "has_alpha": value.get("has_alpha") is True,
        "white_matte": value.get("white_matte") is True,
        "source_take": {key: source[key] for key in keys}
        if source and all(isinstance(source.get(key), str) for key in keys)
        else None,
        "actual_settings": value["actual_settings"]
        if isinstance(value.get("actual_settings"), dict)
        else {},
    }


def _image_outputs(take: Mapping[str, Any]) -> Mapping[str, Any]:
    snap = image_snapshot(take.get("params_snapshot"))
    return (
        snap["outputs"]
        if snap
        else {"image": OUTPUT_IMAGE, "image_white": OUTPUT_WHITE}
    )


def _upstream(run: Mapping[str, Any], step_id: str) -> list[str]:
    steps = _pipeline(run).get("steps") or []
    by_id = {s["step_id"]: s for s in steps}
    seen: set[str] = set()
    stack = [step_id]
    while stack:
        sid = stack.pop()
        if sid in seen or sid not in by_id:
            continue
        seen.add(sid)
        stack += [
            b["from_step"]
            for b in (by_id[sid].get("inputs") or {}).values()
            if isinstance(b, dict) and "from_step" in b
        ]
    return [s["step_id"] for s in steps if s["step_id"] in seen]


def _image_step_ids(run: Mapping[str, Any], take: Mapping[str, Any]) -> list[str]:
    outputs = _image_outputs(take)
    pipeline_outputs = _pipeline(run).get("outputs") or {}
    ids: set[str] = set()
    for key in (outputs.get("image"), outputs.get("image_white")):
        ref = pipeline_outputs.get(key) if key else None
        if ref:
            ids.update(_upstream(run, ref["from_step"]))
    return [
        s["step_id"] for s in _pipeline(run).get("steps") or [] if s["step_id"] in ids
    ]


def _take_total(timings: Mapping[str, Any]) -> int | float | None:
    values: list[int | float] = []
    for key, value in timings.items():
        if key != "total":
            if not _number(value):
                return None
            values.append(value)
    return sum(values) if values else None


def _read_image(run: Mapping[str, Any], key: Any) -> dict[str, Any] | None:
    ref = (_pipeline(run).get("outputs") or {}).get(key) if key else None
    if not ref:
        return None
    step = (run.get("steps") or {}).get(ref["from_step"]) or {}
    value = (step.get("outputs") or {}).get(ref["output"])
    if (
        step.get("state") != "succeeded"
        or not isinstance(value, dict)
        or "value" not in value
    ):
        return None
    return as_image_asset(value["value"])


def image_take_outcome(
    run: Mapping[str, Any], take: Mapping[str, Any]
) -> dict[str, Any]:
    """An image take's result from its run (outcome.ts imageTakeOutcome)."""
    outputs = _image_outputs(take)
    match = SUFFIX_RE.search(str(outputs.get("image") or ""))
    suffix = match.group(1) if match else ""
    ids = _image_step_ids(run, take)
    run_steps = run.get("steps") or {}
    timings: dict[str, Any] = {}
    for sid in ids:
        step = run_steps.get(sid) or {}
        base = sid[: -len(suffix)] if suffix and sid.endswith(suffix) else sid
        timings[base] = _elapsed(step.get("started_at"), step.get("finished_at"))
    timings["total"] = _take_total(timings)
    image = _read_image(run, outputs.get("image"))
    if image:
        white = _read_image(run, outputs.get("image_white"))
        return {
            "state": "succeeded",
            "image": image,
            "image_white": white,
            "error": None,
            "timings_ms": timings,
        }
    if run.get("state") == "running":
        return {
            "state": "rendering",
            "image": None,
            "image_white": None,
            "error": None,
            "timings_ms": timings,
        }
    state = {"cancelled": "cancelled", "interrupted": "interrupted"}.get(
        str(run.get("state")), "failed"
    )
    failed = next(
        (
            error
            for sid in ids
            if (error := as_error((run_steps.get(sid) or {}).get("error")))
        ),
        None,
    )
    error = (
        failed
        or run.get("error")
        or (
            {
                "code": OUTPUT_MISSING,
                "message": "the run succeeded but has no output for this image",
            }
            if run.get("state") == "succeeded"
            else None
        )
    )
    return {
        "state": state,
        "image": None,
        "image_white": None,
        "error": error,
        "timings_ms": timings,
    }


def white_item_id(take: Mapping[str, Any]) -> str:
    """The library id of a take's white-matte copy (reconcile.ts whiteItemId: the same from every client)."""
    return f"imgw-{take['take_id']}"[:MAX_ID]


def _take_library_item(
    library: list[dict[str, Any]], shot_id: str, take: Mapping[str, Any]
) -> dict[str, Any] | None:
    linked = take.get("library_item_id")
    if linked:
        item = next(
            (entry for entry in library if entry.get("item_id") == linked), None
        )
        if item is not None:
            return item
    return next(
        (
            entry
            for entry in library
            if (entry.get("source") or {}).get("kind") == "image_take"
            and entry["source"].get("image_shot_id") == shot_id
            and entry["source"].get("take_id") == take.get("take_id")
        ),
        None,
    )


def white_library_item(
    project: Mapping[str, Any],
    shot: Mapping[str, Any],
    take: Mapping[str, Any],
    now: str,
) -> tuple[dict[str, Any] | None, bool]:
    """The library item of a take's white-matte copy (sendToVideo.ts whiteLibraryItem): (item, already there)."""
    library = project.get("library") or []
    existing = _take_library_item(library, shot["image_shot_id"], take)
    if existing is not None:
        return existing, True
    white = take.get("image_white")
    if (
        take.get("state") != "succeeded"
        or not take.get("image")
        or not white
        or len(library) >= MAX_LIBRARY_ITEMS
    ):
        return None, False

    def side(value: Any) -> int | None:
        return (
            value
            if isinstance(value, int)
            and not isinstance(value, bool)
            and 1 <= value <= MAX_IMAGE_DIMENSION
            else None
        )

    number = next(
        (
            i + 1
            for i, t in enumerate(shot.get("takes") or [])
            if t.get("take_id") == take["take_id"]
        ),
        0,
    )
    item = {
        "item_id": white_item_id(take),
        "kind": "image",
        "name": f"{shot.get('title') or 'Image'} · take {number or '?'} (white bg).png"[
            :200
        ],
        "file": white["file"],
        "created_at": now,
        "duration_seconds": None,
        "width": side(white.get("width")),
        "height": side(white.get("height")),
        "has_audio": False,
        "note": f"Image Studio · seed {take.get('seed')}",
        "source": {
            "kind": "image_take",
            "image_shot_id": shot["image_shot_id"],
            "take_id": take["take_id"],
        },
    }
    return item, False


def _add_library_item(project: dict[str, Any], item: dict[str, Any]) -> bool:
    """Add an item that is not in the library yet and link the take it comes from (the reducer's addLibraryItems)."""
    library = list(project.get("library") or [])
    if (
        any(entry.get("item_id") == item["item_id"] for entry in library)
        or len(library) + 1 > MAX_LIBRARY_ITEMS
    ):
        return False
    project["library"] = [*library, copy.deepcopy(item)]
    source = item["source"]
    for shot in project.get("image_shots") or []:
        if shot.get("image_shot_id") != source["image_shot_id"]:
            continue
        for take in shot.get("takes") or []:
            if take.get("take_id") == source["take_id"]:
                take["library_item_id"] = item["item_id"]
    return True


# --------------------------------------------------------------------------- reading runs back into a project


def _active_take(shot: Mapping[str, Any]) -> Mapping[str, Any] | None:
    takes = [take for take in shot.get("takes") or [] if isinstance(take, dict)]
    chosen = next(
        (take for take in takes if take.get("take_id") == shot.get("active_take_id")),
        None,
    )
    if chosen is not None:
        return chosen
    return next(
        (take for take in reversed(takes) if take.get("state") == "succeeded"), None
    )


def reconcile_takes(project: dict[str, Any], run: Mapping[str, Any]) -> int:
    """Complete pending video candidates, preserving the shot's existing selection."""
    changed = 0
    for shot in project.get("shots") or []:
        takes = shot.get("takes") or []
        current = _active_take(shot)
        variation = sum(1 for t in takes if t.get("run_id") == run.get("run_id")) > 1
        for take in takes:
            if (
                take.get("run_id") != run.get("run_id")
                or take.get("state") != "rendering"
            ):
                continue
            outcome = take_outcome(run, take)
            if outcome["state"] == "rendering":
                continue
            take.update(outcome)
            changed += 1
            if outcome["state"] != "succeeded":
                continue
            if current is None:
                current = take
                if (
                    variation
                    and take.get("seed") is not None
                    and shot.get("seed") != RANDOM_SEED
                ):
                    shot["seed"] = take["seed"]
            shot["active_take_id"] = current["take_id"]
    return changed


def reconcile_exports(project: dict[str, Any], run: Mapping[str, Any]) -> int:
    """Read a run back into the project's rendering exports (useRenderTracker); the number that changed."""
    changed = 0
    for record in project.get("exports") or []:
        if (
            record.get("run_id") != run.get("run_id")
            or record.get("state") != "rendering"
        ):
            continue
        outcome = export_outcome(run)
        if outcome["state"] == "rendering":
            continue
        record.update(outcome)
        changed += 1
    return changed


def reconcile_images(project: dict[str, Any], run: Mapping[str, Any], now: str) -> int:
    """Complete pending image candidates, preserving the image's selection and requested library copies."""
    changed = 0
    for shot in project.get("image_shots") or []:
        current = _active_take(shot)
        for take in shot.get("takes") or []:
            if (
                take.get("run_id") != run.get("run_id")
                or take.get("state") != "rendering"
            ):
                continue
            outcome = image_take_outcome(run, take)
            if outcome["state"] == "rendering":
                continue
            take.update(outcome)
            changed += 1
            if outcome["state"] == "succeeded":
                if current is None:
                    current = take
                shot["active_take_id"] = current["take_id"]
            snap = image_snapshot(take.get("params_snapshot"))
            if outcome["state"] == "succeeded" and snap and snap.get("auto_library"):
                item, existing = white_library_item(project, shot, take, now)
                if item is not None and not existing:
                    _add_library_item(project, item)
    return changed


def pending_run_ids(doc: Mapping[str, Any]) -> set[str]:
    """Run ids that still have a ``rendering`` video or image take or export in the project (lower case)."""
    ids: set[str] = set()
    for shot in [*(doc.get("shots") or []), *(doc.get("image_shots") or [])]:
        for take in shot.get("takes") or []:
            if take.get("state") == "rendering" and take.get("run_id"):
                ids.add(str(take["run_id"]).lower())
    for record in doc.get("exports") or []:
        if record.get("state") == "rendering" and record.get("run_id"):
            ids.add(str(record["run_id"]).lower())
    return ids


def apply_runs(
    doc: dict[str, Any], runs: Iterable[Mapping[str, Any]], now: str | None = None
) -> int:
    """Read finished runs back into ``doc`` in place; the number of takes and exports that changed.

    A run that is not terminal changes nothing (a ``running`` run keeps its takes ``rendering``). ``now`` stamps the
    library items added for image takes (default: the current time).
    """
    stamp = now or utc_now()
    changed = 0
    for run in runs:
        if run.get("state") not in TERMINAL_RUN_STATES:
            continue
        changed += (
            reconcile_takes(doc, run)
            + reconcile_exports(doc, run)
            + reconcile_images(doc, run, stamp)
        )
    return changed


__all__ = [
    "AUDIT_PATH",
    "BACKFILL_DELAY_S",
    "TERMINAL_RUN_STATES",
    "apply_runs",
    "export_outcome",
    "image_take_outcome",
    "pending_run_ids",
    "reconcile_exports",
    "reconcile_images",
    "reconcile_takes",
    "take_outcome",
    "white_library_item",
]
