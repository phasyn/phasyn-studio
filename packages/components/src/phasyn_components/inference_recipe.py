"""Resolve an inference recipe using only frozen run and recording evidence, without model imports."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .canonical import digest
from .ids import is_uuid


type Doc = dict[str, Any]

VERSION = "phasyn.inference-recipe.v1"
_H3 = "runtimes/h3/src/phasyn_h3/"
_QIMG = "runtimes/qimg/src/phasyn_qimg/dit/"
_CAPABILITIES = {
    "h3.dit": {
        "attention_selection": {
            "status": "conditional",
            "source": _H3 + "recipe/runtime/attention_runtime.py#prepare_dit_attention",
        },
        "torch_compile": {
            "status": "conditional_regional_mlp",
            "source": _H3 + "recipe/runtime/regional_compile_rules.py",
        },
        "denoising_step_cache": {
            "status": "conditional_cache_dit",
            "source": _H3 + "recipe/runtime/denoise_cache_rules.py",
        },
        "reference_kv_reuse": {
            "status": "conditional_ref2va",
            "source": _H3 + "config.py#_check_ref_kv_cache",
        },
    },
    "qimg.dit": {
        "attention_selection": {
            "status": "no_public_selector",
            "source": _QIMG + "options.py#build_settings_schema",
        },
        "torch_compile": {
            "status": "no_public_selector",
            "source": _QIMG + "options.py#build_settings_schema",
        },
        "denoising_step_cache": {
            "status": "no_public_selector",
            "source": _QIMG + "options.py#parameters_schema",
        },
        "prefix_kv_cache": {
            "status": "separate_model_feature",
            "source": _QIMG + "provider.py#QimgDitProvider",
        },
    },
}
_PARAMETERS = [
    "task",
    "phase",
    "width",
    "height",
    "frames",
    "fps",
    "fps_num",
    "fps_den",
    "duration",
    "aspect_ratio",
    "resolution",
    "seed",
    "steps",
    "start_step",
    "end_step",
    "scheduler",
    "sampler",
    "sigma_schedule",
    "sigmas",
    "timesteps",
    "cfg",
    "guidance",
    "guidance_scale",
    "true_cfg_scale",
    "video_shift",
    "audio_shift",
    "flow_shift_mu",
    "noise_type",
    "negative_mode",
    "nag",
    "preview",
    "compile",
    "shift",
    "num_images_per_prompt",
]
_LOAD = ("device", "precision", "offload", "part_overrides")
_OPTIONS = [
    "variant",
    "base",
    "mode",
    "precision",
    "attention",
    "adaln",
    "lora",
    "loras",
    "adapters",
    "quantization",
    "weight_streaming",
    "frame_streaming",
    "ref_kv_cache",
    "quantized_cache",
    "memory_model",
    "bounded_fp8_load",
    "shared_from",
    "video_vae_scope",
    "encoder_max_tokens",
    "encode_provider",
    "video_codec",
    "pixel_format",
    "quality",
    "unified_reserve_bytes",
    "gguf_file",
    "transformer_override",
    "preview_vae",
]
_METRICS = [
    "nvml_device_used_sample_peak_bytes",
    "host_rss_sample_peak_bytes",
    "torch_allocated_peak_bytes",
    "torch_reserved_peak_bytes",
    "host_wall_ms",
    "runtime.host_wall_ms",
    "host_load_ms",
    "scheduler_steps_completed",
    "denoiser_forwards_completed",
    "weight_h2d_completed_bytes",
    "sample_count",
    "h3.warm_call",
    "qimg.dit.warm_call",
]


@dataclass
class RecordingEvidence:
    """One step's verified local recording. A missing recording never replaces a call snapshot."""

    context: Doc = field(default_factory=dict)
    summary: Doc = field(default_factory=dict)
    events: dict[str, Doc] = field(default_factory=dict)
    capture: Doc = field(default_factory=dict)


_SHA256_HEX_CHARS = 64


def _object(value: object) -> Doc:
    return value if isinstance(value, dict) else {}


def _pick(value: object, keys: list[str] | tuple[str, ...]) -> Doc:
    obj = _object(value)
    return {key: obj[key] for key in keys if key in obj}


def _at(value: object, *keys: str) -> Any:
    for key in keys:
        value = _object(value).get(key)
    return value


def _fact(value: object, source: str, reason: str = "not recorded") -> Doc:
    if value is None:
        return {"status": "unknown", "value": None, "reason": reason}
    return {"status": "recorded", "value": value, "source": source}


def _sha(value: object) -> str | None:
    if (
        isinstance(value, str)
        and len(value) == _SHA256_HEX_CHARS
        and all(ch in "0123456789abcdef" for ch in value)
    ):
        return value
    return None


def _settings(snapshot: object, provider: str | None) -> Doc | None:
    if not isinstance(snapshot, dict):
        return None
    load = snapshot.get("load")
    result: Doc = {
        "snapshot_sha256": digest(_pick(snapshot, ("load", "invoke", "parameters"))),
        "load": _pick(load, _LOAD),
        "parameters": _pick(snapshot.get("parameters"), _PARAMETERS),
        "invoke": _pick(snapshot.get("invoke"), _PARAMETERS),
    }
    if provider is None or provider.startswith(("h3.", "qimg.")):
        result["load"]["provider_options"] = _pick(
            _at(load, "provider_options"), _OPTIONS
        )
    return result


def _model(identity: Doc) -> Doc:
    parts = {
        name: _pick(
            value,
            (
                "path",
                "files",
                "size_bytes",
                "mtime_ns",
                "sha256",
                "config_files",
                "config_sha256",
            ),
        )
        for name, value in _object(identity.get("components")).items()
    }
    return {
        "identity": _pick(
            identity,
            (
                "model",
                "model_id",
                "base",
                "variant",
                "family",
                "revision",
                "source_revision",
                "transformer_class",
                "identity_strength",
                "shared_from",
            ),
        ),
        "sha256": _fact(
            _sha(identity.get("sha256")),
            "settings.model_identity.sha256",
            str(identity.get("sha256_reason") or "model content SHA-256 not recorded"),
        ),
        "components": parts,
    }


def _adapter(item: Doc, identity: Doc, index: int) -> Doc:
    return {
        "order": index,
        "binding": _pick(
            item,
            (
                "lora_id",
                "name",
                "kind",
                "format",
                "revision",
                "path",
                "manifest_path",
                "scale",
                "rank",
                "alpha",
            ),
        ),
        "purpose": _fact(
            item.get("purpose") or item.get("category"), "recorded adapter purpose"
        ),
        "content_sha256": _fact(
            _sha(_at(identity, "file", "sha256")),
            "settings.model_identity.adapters[].file.sha256",
        ),
        "declared_sha256": _fact(
            _sha(item.get("sha256") or _at(item, "file", "sha256")),
            "recorded adapter declaration",
        ),
    }


def _adapters(
    provider: str | None,
    effective: Doc,
    observed: Doc,
    identity: Doc,
    evidence: RecordingEvidence,
) -> Doc:
    options = _object(_at(effective, "load", "provider_options"))
    if provider == "h3.dit":
        stack = options.get("loras")
        if isinstance(stack, list) and stack:
            return _fact(
                [
                    _adapter(item, {}, index)
                    for index, item in enumerate(stack)
                    if isinstance(item, dict) and item
                ],
                "settings.effective.load.provider_options.loras",
            )
        if "lora" not in options:
            fact = _object(_at(evidence.events, "DENOISE", "fields", "fact"))
            if (
                "lora_runtime" in fact
                and fact["lora_runtime"] is None
                and fact.get("lora_merge_mode") is None
            ):
                return _fact([], "runtime.DENOISE.fact.lora_runtime")
            return _fact(None, "")
        item = options["lora"]
        entries = [_adapter(item, {}, 0)] if isinstance(item, dict) and item else []
        return _fact(entries, "settings.effective.load.provider_options.lora")
    if provider == "qimg.dit" and isinstance(observed.get("adapters"), list):
        identities = {
            a.get("name"): a
            for a in identity.get("adapters") or []
            if isinstance(a, dict)
        }
        return _fact(
            [
                _adapter(a, identities.get(a.get("name"), {}), i)
                for i, a in enumerate(observed["adapters"])
                if isinstance(a, dict)
            ],
            "settings.observed.adapters",
        )
    return _fact(None, "")


def _fingerprint(typed: object) -> Doc:
    obj = _object(typed)
    ref = obj.get("file")
    if isinstance(ref, dict):
        return {
            "type_id": obj.get("type_id"),
            "transport": "file",
            "sha256": _sha(ref.get("sha256")),
            "size_bytes": ref.get("size_bytes"),
            "links": {
                k: _sha(_at(v, "sha256"))
                for k, v in _object(_at(ref, "metadata", "links")).items()
            },
        }
    result = {
        "type_id": obj.get("type_id"),
        "transport": "inline",
        "value_sha256": digest(obj["value"]) if "value" in obj else None,
    }
    if obj.get("type_id") == "h3.job.v1":
        result["job"] = _pick(
            obj.get("value"),
            ("task", "variant", "width", "height", "frames", "fps", "geometry_digest"),
        )
    return result


def _bindings(inputs: object) -> Doc:
    out = {}
    for key, raw in _object(inputs).items():
        binding = _object(raw)
        out[key] = _pick(binding, ("from_step", "from_input", "output")) or {
            "literal_sha256": digest(binding)
        }
    return out


def _observations(observed: Doc, evidence: RecordingEvidence) -> Doc:
    denoise = _object(_at(evidence.events.get("DENOISE"), "fields", "fact"))
    attention = _object(denoise.get("attention"))
    built = _object(_at(observed, "load_facts", "acceleration", "built"))
    return {
        "measured_attention_dispatch": _fact(
            _at(evidence.events, "H3_ATTENTION_PROBE", "fields", "fact"),
            "runtime.H3_ATTENTION_PROBE.fact",
        ),
        "encoding_cache": _fact(
            _at(evidence.events, "QIMG_ENCODING_CACHE", "fields"),
            "runtime.QIMG_ENCODING_CACHE",
        ),
        "active_attention_backend": _fact(
            attention.get("active_backend"),
            "runtime.DENOISE.fact.attention.active_backend",
        ),
        "attention_implementation": _fact(
            attention.get("impl"), "runtime.DENOISE.fact.attention.impl"
        ),
        "attention_processors": _fact(
            observed.get("attention_processors"),
            "settings.observed.attention_processors",
        ),
        "parameter_dtypes": _fact(
            observed.get("parameter_dtypes"), "settings.observed.parameter_dtypes"
        ),
        "quantized_weight_dtypes": _fact(
            _at(built, "fp8", "weight_dtypes"),
            "settings.observed.load_facts.acceleration.built.fp8.weight_dtypes",
        ),
        "accumulation_dtype": _fact(
            observed.get("accumulation_dtype"),
            "settings.observed.accumulation_dtype",
            str(observed.get("accumulation_dtype_reason") or "not recorded"),
        ),
        "vae_weight_dtype": _fact(
            _at(observed, "video_vae_scope_facts", "dtype"),
            "settings.observed.video_vae_scope_facts.dtype",
        ),
        "kernel_compute_dtype": _fact(
            observed.get("kernel_compute_dtype"),
            "settings.observed.kernel_compute_dtype",
            "the available evidence reports storage dtype or configured compute policy",
        ),
        "jit_compile_mode": _fact(
            _at(evidence.events, "H3_REGIONAL_COMPILE", "fields", "fact", "effective"),
            "runtime.H3_REGIONAL_COMPILE.fact.effective",
        )
        if "H3_REGIONAL_COMPILE" in evidence.events
        else _fact(
            observed.get("graph_compile_mode"),
            "settings.observed.graph_compile_mode",
            "no graph compilation execution event recorded",
        ),
        "denoising_step_cache": _fact(
            _at(evidence.events, "H3_DENOISE_CACHE", "fields", "fact"),
            "runtime.H3_DENOISE_CACHE.fact",
        )
        if "H3_DENOISE_CACHE" in evidence.events
        else _fact(
            observed.get("denoising_step_cache"),
            "settings.observed.denoising_step_cache",
            "no generic denoising-step cache evidence recorded",
        ),
        "reference_kv_policy": _fact(
            _pick(
                _at(evidence.events, "REF_KV_CACHE", "fields", "fact"),
                (
                    "mode",
                    "start_step",
                    "cache_dtype",
                    "refresh_steps",
                    "max_cache_bytes",
                    "cache_device",
                ),
            )
            or None,
            "runtime.REF_KV_CACHE.fact",
        ),
        "prefix_kv_cache": _fact(
            observed.get("kv_cache"), "settings.observed.kv_cache"
        ),
    }


def _fallback(events: dict[str, Doc]) -> Doc:
    attention = _object(_at(events, "DENOISE", "fields", "fact", "attention"))
    count = _at(attention, "calls", "fp8_fallback_calls")
    reasons = attention.get("fallback_reasons")
    if count is None and not reasons:
        return _fact(None, "", "no explicit fallback count or reason was captured")
    return _fact({"calls": count, "reasons": reasons}, "runtime.DENOISE.fact.attention")


def _resolved_step(
    step: Doc, definition: Doc, evidence: RecordingEvidence
) -> tuple[Doc, Doc]:
    settings = _object(step.get("settings")) or _object(
        evidence.context.get("settings")
    )
    provider = evidence.context.get("provider_id")
    observed = _object(settings.get("observed"))
    identity = _object(settings.get("model_identity"))
    requested = _settings(settings.get("requested"), provider)
    effective = _settings(settings.get("effective"), provider)
    runtime = _pick(
        settings.get("runtime_identity"),
        (
            "torch",
            "cuda",
            "driver",
            "cudnn",
            "device_name",
            "device_capability",
            "device_total_memory_bytes",
            "device",
        ),
    )
    acceleration = _object(_at(observed, "load_facts", "acceleration", "effective"))
    params_event = _at(evidence.events, "QIMG_DIT_PARAMS", "fields", "effective")
    sampling = (
        _fact(params_event, "runtime.QIMG_DIT_PARAMS.effective")
        if params_event is not None
        else _fact(
            _at(effective, "parameters") if effective else None,
            "settings.effective.parameters",
        )
    )
    resolved = {
        "provider_id": provider,
        "component_id": step.get("component_id") or definition.get("component_id"),
        "node_id": step.get("node_id") or definition.get("node_id"),
        "inputs": _bindings(definition.get("inputs")),
        "requested": {
            "step_parameters": _pick(definition.get("parameters"), _PARAMETERS),
            "step_parameters_sha256": digest(definition["parameters"])
            if isinstance(definition.get("parameters"), dict)
            else None,
            "frozen_invoke_sha256": digest(step["invoke_snapshot"])
            if isinstance(step.get("invoke_snapshot"), dict)
            else None,
            "frozen_invoke": _pick(step.get("invoke_snapshot"), _PARAMETERS),
            "settings": requested,
        },
        "effective": {
            "settings": effective,
            "sampling": sampling,
            "acceleration": acceleration or None,
            "component_policies": observed.get("components"),
        },
        "observed": _observations(observed, evidence),
        "model": _model(identity),
        "adapters": _adapters(
            provider, _object(settings.get("effective")), observed, identity, evidence
        ),
        "runtime": {**runtime, "libraries": observed.get("libraries")},
    }
    summary = evidence.summary
    rid = step.get("recording_id")
    provenance = {
        "recording_href": f"/api/recordings/{rid}"
        if is_uuid(rid) and evidence.context
        else None,
        "settings_evidence": "run.steps.settings"
        if step.get("settings")
        else (
            "recording.context.settings" if evidence.context.get("settings") else None
        ),
        "state": step.get("state"),
        "call_id": step.get("call_id"),
        "source_revision": _at(evidence.context, "environment", "source_revision"),
        "runtime_id": _at(evidence.context, "environment", "runtime_id"),
        "recording_id": step.get("recording_id"),
        "config_digest": settings.get("config_digest"),
        "loaded_revision": settings.get("loaded_revision"),
        "evidence_window": evidence.capture,
        "events": evidence.events,
        "metrics": _pick(summary.get("metrics"), _METRICS),
        "coverage": _pick(
            summary, ("detail_truncated", "dropped_events", "dropped_bytes")
        ),
        "placement": observed.get("placement"),
        "weight_streaming": observed.get("weight_streaming"),
        "admission": observed.get("ram_preload_admission"),
        "cost": summary.get("cost"),
        "fallback": _fallback(evidence.events),
        "current_provider_contract": _CAPABILITIES.get(provider, {})
        if isinstance(provider, str)
        else {},
    }
    return resolved, provenance


def inference_recipe(
    run: Mapping[str, Any], recordings: Mapping[str, RecordingEvidence]
) -> Doc:
    """Produce two self-verifiable canonical SHA-256 digests, one with per-run evidence and one without."""
    request = _object(run.get("request"))
    pipeline = _object(request.get("pipeline"))
    definitions = {
        s["step_id"]: s
        for s in pipeline.get("steps") or []
        if isinstance(s, dict) and "step_id" in s
    }
    steps: Doc = {}
    provenance: Doc = {}
    for sid, raw in _object(run.get("steps")).items():
        resolved, record = _resolved_step(
            _object(raw),
            definitions.get(sid, {}),
            recordings.get(sid, RecordingEvidence()),
        )
        compatibility = _object(raw).get("lora_compatibility")
        if isinstance(compatibility, dict):
            resolved["lora_compatibility"] = compatibility
        steps[sid] = resolved
        provenance[sid] = record
    recipe = {
        "schema_version": VERSION,
        "pipeline_id": pipeline.get("pipeline_id"),
        "inputs": {
            name: _fingerprint(value)
            for name, value in _object(request.get("inputs")).items()
        },
        "steps": steps,
    }
    result: Doc = {
        "schema_version": VERSION,
        "recipe_sha256": digest(recipe),
        "recipe": recipe,
        "execution": {
            "run_id": run.get("run_id"),
            "state": run.get("state"),
            "steps": provenance,
        },
    }
    if pin := _object(request.get("origin")).get("inference_preset"):
        result["execution"]["inference_preset"] = pin
    result["document_sha256"] = digest(result)
    return result


def recording_matches(context: Doc, run_id: str, step: Doc) -> bool:
    """Reject stale or unrelated recordings even when a persisted step contains a valid UUID."""
    return (
        is_uuid(step.get("recording_id"))
        and is_uuid(step.get("call_id"))
        and context.get("operation") == "invoke"
        and context.get("run_id") == run_id
        and all(
            context.get(k) == step.get(k)
            for k in ("recording_id", "call_id", "component_id", "node_id")
        )
    )
