"""Freeze a known native graph and resolve typed input substitutions without loading model files."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.pipeline import validate_run_inputs

from .policy import Doc, invalid, resolve_policy


_RAW_INPUTS = {
    "text.prompt.v1",
    "media.image.v1",
    "media.video.v1",
    "media.audio.v1",
    "qimg.references.v1",
    "h3.materials.v1",
}
_PREFIX = {
    "media.image.v1": "image/",
    "media.video.v1": "video/",
    "media.audio.v1": "audio/",
}


_MAX_REFERENCE_LABEL_CHARS = 200
_MAX_SOURCE_FILES = 128


def capture(run: Doc, actual: Doc, options: Doc) -> Doc:
    """Freeze the actual invocation defaults, loaded revisions, graph and bound material as one revision."""
    if run.get("state") != "succeeded":
        raise invalid("source_run_not_succeeded")
    graph = deepcopy(run["request"]["pipeline"])
    pins = {}
    for step in graph["steps"]:
        sid = step["step_id"]
        snap = run["steps"][sid].get("settings") or {}
        load = (snap.get("effective") or {}).get("load")
        requested = (snap.get("requested") or {}).get("load")
        params = (snap.get("effective") or {}).get("parameters")
        rev = snap.get("loaded_revision")
        provider = actual["recipe"]["steps"][sid].get("provider_id")
        if (
            not isinstance(requested, dict)
            or not isinstance(load, dict)
            or not isinstance(params, dict)
            or type(rev) is not int
            or not provider
        ):
            raise invalid("legacy_run_missing_frozen_settings", step_id=sid)
        step["parameters"] = deepcopy(params)
        step["load_revision"] = rev
        pins[sid] = {
            "provider": provider,
            "load_revision": rev,
            "load_sha256": digest(requested),
            "effective_load_sha256": digest(load),
            "recorded_model": actual["recipe"]["steps"][sid]["model"],
        }
    policy = resolve_policy(run, actual, options)
    next(s for s in graph["steps"] if s["step_id"] == policy["step_id"])[
        "parameters"
    ] = policy["parameters"]
    frozen = {
        "schema_version": "phasyn.inference-preset.v1",
        "label": options["label"],
        "source_run_id": run["run_id"],
        "source_recipe_sha256": actual["recipe_sha256"],
        "pipeline": graph,
        "inputs": deepcopy(run["request"]["inputs"]),
        "policy": policy,
        "pins": pins,
    }
    return {**frozen, "definition_sha256": digest(frozen)}


def collect_files(value: Any, files: dict[tuple[str, str], Doc]) -> None:
    """Walk input manifests, including inline assets and nested file links."""
    if isinstance(value, list):
        for child in value:
            collect_files(child, files)
    if not isinstance(value, dict):
        return
    if {"node_id", "file_id", "media_type", "sha256", "size_bytes"} <= value.keys():
        contracts.validate("FileRef", value, what="FileRef")
        key = (value["node_id"], value["file_id"])
        if key in files and files[key] != value:
            raise invalid("conflicting_file_identities", file_id=key[1])
        files[key] = value
    for child in value.values():
        collect_files(child, files)


def _material_input(name: str, typed: Doc, original: Doc) -> None:
    """Keep the observed material roles and validate the replacement raw media at each position."""
    raw = typed.get("value")
    previous = original.get("value")
    if (
        not isinstance(raw, list)
        or not isinstance(previous, list)
        or len(raw) != len(previous)
    ):
        raise invalid("material_layout_changed", port=name)
    references = typed["type_id"] == "qimg.references.v1"
    for idx, (item, old) in enumerate(zip(raw, previous, strict=True)):
        if not isinstance(item, dict) or not isinstance(old, dict):
            raise invalid("invalid_material_entry", port=name, index=idx)
        if references:
            label = item.get("label")
            if set(item) - {"file", "label"} or (
                label is not None
                and (
                    not isinstance(label, str)
                    or len(label) > _MAX_REFERENCE_LABEL_CHARS
                )
            ):
                raise invalid("invalid_reference_entry", port=name, index=idx)
            mime = "image/"
        else:
            if {k: v for k, v in item.items() if k != "file"} != {
                k: v for k, v in old.items() if k != "file"
            }:
                raise invalid(
                    "h3_material_role_or_timing_changed", port=name, index=idx
                )
            mime = {
                "first_frame": "image/",
                "last_frame": "image/",
                "reference_image": "image/",
                "reference_video": "video/",
                "reference_audio": "audio/",
            }.get(str(item.get("role")), "")
        ref = item.get("file")
        if (
            not isinstance(ref, dict)
            or not mime
            or not str(ref.get("media_type", "")).startswith(mime)
        ):
            raise invalid("input_mime_mismatch", port=name, index=idx)
        contracts.validate("FileRef", ref, what=f"{name}[{idx}].file")


def bind(preset: Doc, inputs: Doc) -> tuple[Doc, list[Doc]]:
    """Accept raw material at native graph ports; encoded bundles must keep their original identity."""
    values = {**deepcopy(preset["inputs"]), **inputs}
    for name, typed in inputs.items():
        tid = typed["type_id"]
        if tid not in _RAW_INPUTS and typed != preset["inputs"].get(name):
            raise invalid("frozen_encoded_material_changed", port=name, type_id=tid)
        if tid in _PREFIX and not typed.get("file", {}).get(
            "media_type", ""
        ).startswith(_PREFIX[tid]):
            raise invalid("input_mime_mismatch", port=name, type_id=tid)
        if tid in {"h3.materials.v1", "qimg.references.v1"}:
            _material_input(name, typed, preset["inputs"].get(name, {}))
        raw = typed.get("value")
        if tid == "text.prompt.v1" and not (
            isinstance(raw, str)
            or (isinstance(raw, dict) and isinstance(raw.get("text"), str))
        ):
            raise invalid("expected_inline_prompt", port=name)
    validate_run_inputs(preset["pipeline"], values)
    files: dict[tuple[str, str], Doc] = {}
    collect_files(values, files)
    if len(files) > _MAX_SOURCE_FILES:
        raise invalid("material_reference_limit")
    return values, list(files.values())
