"""Read-only versioned inference recipe and evidence export from the Controller's own run/recording store."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from phasyn_components.ids import is_uuid, require_uuid
from phasyn_components.inference_recipe import (
    RecordingEvidence,
    recording_matches,
)
from phasyn_components.recipe_comparison import compare_recipes
from phasyn_server.http import attachment, json_response, query_bool
from starlette.responses import JSONResponse

from .recipe_observations import EVENT_CODE, export_recipe, public_observation


if TYPE_CHECKING:
    from phasyn_components.records.store import RecordingStore

    from .state import Controller


_WINDOW = 96
_IDENTITY = ("recording_id", "node_id", "component_id", "run_id", "call_id")
_LEGACY_PROVIDERS = frozenset(
    {"h3.dit", "qimg.dit", "qimg.conditioning", "qimg.vae_encode"}
)
_EVENT_FIELDS = {
    "H3_REGIONAL_COMPILE": ("fact",),
    "H3_COMPILE_SIGNATURE": ("fact",),
    "H3_DENOISE_CACHE": ("fact",),
    "H3_ATTENTION_PROBE": ("fact",),
    "DENOISE": ("fact",),
    "REF_KV_CACHE": ("fact",),
    "COMPONENT_RESIDENCY": ("fact",),
    "QIMG_ENCODING_CACHE": (
        "status",
        "reason",
        "key_sha256",
        "model_content_sha256",
        "verified_input_bytes",
        "lookup_ms",
        "cached_bytes",
        "previous_compute_ms",
        "restore_ms",
        "compute_ms",
        "store_ms",
    ),
    "QIMG_DIT_PARAMS": ("effective", "cfg"),
    "QIMG_DIT_ADMISSION": (
        "placement",
        "memory",
        "components",
        "required_bytes",
        "available_bytes",
        "available_basis",
        "ok",
        "reason",
        "device_memory",
    ),
}
_FACT_FIELDS = {
    "H3_REGIONAL_COMPILE": (
        "requested",
        "effective",
        "region",
        "backend",
        "compiled_calls",
        "signature_hits",
        "signature_misses",
        "evictions",
        "retained_bytes",
        "max_cache_bytes",
        "live_signatures",
        "max_live_signatures",
        "fallbacks",
        "signatures",
        "scope",
        "cuda_graphs",
    ),
    "H3_COMPILE_SIGNATURE": (
        "signature",
        "digest",
        "cold_seconds",
        "warm_seconds",
        "artifact_bytes",
        "fallback",
    ),
    "H3_DENOISE_CACHE": (
        "algorithm",
        "threshold",
        "warmup_steps",
        "max_reuse_steps",
        "first_compute_blocks",
        "last_compute_blocks",
        "steps",
        "cache_dit_version",
        "sglang_revision",
        "source_sha256",
        "cached_steps",
        "reused_steps",
        "full_steps",
        "block_count",
    ),
    "H3_ATTENTION_PROBE": (
        "model_inputs",
        "scope",
        "mechanism",
        "torch_version",
        "status",
        "operators",
        "reason",
    ),
    "DENOISE": (
        "actual_dit_evaluations",
        "completed_updates",
        "attention",
        "lora_merge_mode",
        "lora_runtime",
    ),
    "REF_KV_CACHE": (
        "mode",
        "start_step",
        "cache_device",
        "cache_dtype",
        "refresh_steps",
        "max_cache_bytes",
        "steps",
        "forwards",
        "cache_bytes_allocated",
        "attention_backend",
        "source_sha256",
    ),
    "COMPONENT_RESIDENCY": (
        "after_use_requested",
        "after_use_effective",
        "host_bytes",
        "pinned_bytes",
        "released_bytes",
        "state",
        "source",
        "kind",
    ),
}


def _select_fields(
    fields: dict[str, Any], context: dict[str, Any]
) -> tuple[str, dict[str, Any]] | None:
    code = fields.get("code")
    if code == EVENT_CODE:
        if not all(isinstance(context.get(k), str) and context[k] for k in _IDENTITY):
            return None
        return public_observation(fields)
    provider = context.get("provider_id")
    if not isinstance(provider, str) or provider not in _LEGACY_PROVIDERS:
        return None
    if not isinstance(code, str) or code not in _EVENT_FIELDS:
        return None
    chosen = {key: fields[key] for key in _EVENT_FIELDS[code] if key in fields}
    if "fact" in chosen and isinstance(chosen["fact"], dict):
        chosen["fact"] = {
            key: chosen["fact"][key]
            for key in _FACT_FIELDS[code]
            if key in chosen["fact"]
        }
    return code, chosen


def _event(
    raw: dict[str, Any], context: dict[str, Any], evidence: RecordingEvidence
) -> None:
    if raw.get("kind") != "log" or raw.get("stream_id") != "runtime":
        return
    if any(raw.get(key) != context.get(key) for key in _IDENTITY):
        return
    data, seq = raw.get("data"), raw.get("seq")
    if not isinstance(data, dict) or type(seq) is not int or seq < 1:
        return
    fields = data.get("fields")
    selected = _select_fields(fields, context) if isinstance(fields, dict) else None
    if selected is None:
        return
    code, chosen = selected
    params = urlencode({"stream_id": "runtime", "after_seq": seq - 1, "limit": 1})
    entry = {
        "stream_id": "runtime",
        "seq": seq,
        "fields": chosen,
        "href": f"/api/recordings/{context['recording_id']}/events?{params}",
    }
    if code == "H3_COMPILE_SIGNATURE":
        # A run may compile multiple tensor shapes and may visit the same shape in several stages.
        evidence.events[f"{code}:{seq}"] = entry
    else:
        evidence.events[code] = entry


def _events(store: RecordingStore, rid: str, evidence: RecordingEvidence) -> None:
    stream = next((s for s in store.streams(rid) if s["stream_id"] == "runtime"), None)
    if not stream:
        evidence.capture = {"status": "missing_runtime_stream"}
        return
    last = int(stream["last_seq"])
    starts = [0] if last <= _WINDOW * 2 else [0, last - _WINDOW]
    width = _WINDOW * 2 if len(starts) == 1 else _WINDOW
    capture: dict[str, Any] = {
        "status": "bounded" if len(starts) > 1 else "complete_index_window",
        "indexed_events": stream["event_count"],
        "last_seq": last,
        "windows": [],
    }
    for start in starts:
        page = store.events(rid, stream_id="runtime", after_seq=start, limit=width)
        capture["windows"].append(
            {"after_seq": start, "through_seq": page["next_seq"], "gap": page["gap"]}
        )
        for event in page["events"]:
            _event(event, evidence.context, evidence)
    evidence.capture = capture


def _evidence(
    store: RecordingStore, run_id: str, step: dict[str, Any]
) -> RecordingEvidence:
    rid = step.get("recording_id")
    if not is_uuid(rid):
        return RecordingEvidence(capture={"status": "no_recording_id"})
    rid = str(rid)
    ctx = store.read_context(rid)
    if not ctx or not recording_matches(ctx, run_id, step):
        return RecordingEvidence(
            capture={"status": "missing_or_unmatched_recording_context"}
        )
    summary = store.read_summary(rid)
    evidence = RecordingEvidence(
        ctx, summary if summary and summary.get("recording_id") == rid else {}
    )
    try:
        _events(store, rid, evidence)
    except FileNotFoundError:
        evidence.capture = {"status": "recording_detail_unavailable"}
    return evidence


def _resolve(
    ctl: Controller, rid: str, active: dict[str, Any] | None
) -> dict[str, Any]:
    run = active if active is not None else ctl.runs.read(rid)
    evidence = {
        key: _evidence(ctl.store, rid, val)
        for key, val in run.get("steps", {}).items()
        if isinstance(val, dict)
    }
    return export_recipe(run, evidence)


def routes(ctl: Controller) -> APIRouter:
    """Expose effective recipes and measured comparisons for recorded runs."""
    router = APIRouter()

    @router.get("/api/runs/{run_id}/recipe")
    async def get_recipe(run_id: str, request: Request) -> JSONResponse:
        rid = require_uuid(run_id, "run_id")
        download = query_bool(request.query_params, "download", default=False)
        result = await asyncio.to_thread(_resolve, ctl, rid, ctl.runner.snapshot(rid))
        headers = attachment(f"inference-recipe-{rid}.json") if download else {}
        headers["Cache-Control"] = "no-store"
        return json_response(result, headers=headers)

    @router.get("/api/runs/{run_id}/recipe/compare")
    async def compare(run_id: str, against: str) -> JSONResponse:
        left_id = require_uuid(run_id, "run_id")
        right_id = require_uuid(against, "against")
        left = await asyncio.to_thread(
            _resolve, ctl, left_id, ctl.runner.snapshot(left_id)
        )
        right = (
            left
            if left_id == right_id
            else await asyncio.to_thread(
                _resolve, ctl, right_id, ctl.runner.snapshot(right_id)
            )
        )
        result = await asyncio.to_thread(compare_recipes, left, right)
        return json_response(result, headers={"Cache-Control": "no-store"})

    return router
