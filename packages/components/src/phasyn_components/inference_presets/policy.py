"""Bind model-specific sampling checks to the effective, captured denoiser load configuration."""

from __future__ import annotations

from typing import Any

from phasyn_components.errors import ComponentError

from .accelerators import H3_ACCELERATORS


type Doc = dict[str, Any]
_MIN_QWEN_STEPS = 2
_MAX_QWEN_STEPS = 100
_MAX_QWEN_SEED = 2_147_483_647
PROVIDERS = {"h3.dit", "qimg.dit"}


def invalid(reason: str, **details: Any) -> ComponentError:
    """Give callers a machine-readable rejection before an execution exists."""
    return ComponentError(
        "INVALID_ARGUMENT", "推論配方不相容", details={"reason": reason, **details}
    )


def _task(run: Doc, providers: dict[str, str], denoiser: Doc) -> str:
    """Use graph ports and frozen semantic inputs, never labels or user-selected names."""
    if providers[denoiser["step_id"]] == "qimg.dit":
        return "i2i" if "ref_latents" in denoiser["inputs"] else "t2i"
    source = denoiser["inputs"].get("job", {})
    if "from_input" in source:
        task = (
            run["request"]["inputs"]
            .get(source["from_input"], {})
            .get("value", {})
            .get("task")
        )
    else:
        producer = run["steps"].get(source.get("from_step"), {})
        task = (
            producer.get("outputs", {})
            .get(source.get("output"), {})
            .get("value", {})
            .get("task")
        )
    if task not in {"fl2va", "ref2va", "t2va"}:
        raise invalid("missing_h3_task_evidence")
    return str(task)


def _h3_adapters(options: Doc, params: Doc) -> list[Doc]:
    stack = options.get("loras")
    if isinstance(stack, list) and stack:
        # a stack: every member must be a registered native accelerator (style LoRAs have no bundled identity)
        return [
            {**_h3_adapter(item, options, params), "order": index}
            for index, item in enumerate(stack)
        ]
    lora = options.get("lora")
    if not lora:
        return []
    return [_h3_adapter(lora, options, params)]


def _h3_adapter(lora: Doc, options: Doc, params: Doc) -> Doc:
    name: Any = lora.get("manifest_path")
    native = H3_ACCELERATORS.get(name)
    if native is None:
        raise invalid("unregistered_h3_adapter", manifest=name)
    variant, steps, video, audio, fixed, sha = native
    if (
        options.get("variant") != variant
        or params["steps"] not in steps
        or params.get("video_shift") != video
        or params.get("audio_shift") != audio
        or (fixed is not None and lora.get("scale") != fixed)
    ):
        raise invalid(
            "accelerator_sampling_contract",
            manifest=name,
            variant=variant,
            steps=list(steps),
            video_shift=video,
            audio_shift=audio,
            fixed_scale=fixed,
        )
    return {
        "order": 0,
        "role": "acceleration",
        "manifest": name,
        "weight_sha256": sha,
        "identity_source": "bundled_native_manifest",
        "scale": lora.get("scale"),
        "scheduler": "h3_euler",
    }


def _qwen_adapters(options: Doc, roles: list[str], recorded: Doc) -> list[Doc]:
    adapters = options.get("adapters") or []
    if roles and len(roles) != len(adapters):
        raise invalid("adapter_role_count")
    if options.get("variant") != "bf16" and adapters:
        raise invalid("qwen_adapter_requires_bf16")
    rows = recorded["adapters"].get("value") or []
    result = []
    for i, item in enumerate(adapters):
        role = roles[i] if roles else "unspecified"
        if role not in {"style", "unspecified"}:
            raise invalid(
                "qwen_has_no_registered_control_or_acceleration_contract", order=i
            )
        result.append(
            {
                "order": i,
                "role": role,
                "role_source": "operator" if roles else "unclassified",
                "native": item,
                "observed": rows[i] if i < len(rows) else None,
            }
        )
    return result


def resolve_policy(run: Doc, evidence: Doc, settings: Doc) -> Doc:
    """Resolve sampling, adapter roles, precision and attention for exactly one model stage."""
    providers = {
        sid: s.get("provider_id") for sid, s in evidence["recipe"]["steps"].items()
    }
    for sid, provider in providers.items():
        if not provider:
            raise invalid("legacy_run_missing_provider_identity", step_id=sid)
    stages = [
        s
        for s in run["request"]["pipeline"]["steps"]
        if providers.get(s["step_id"]) in PROVIDERS
    ]
    if len(stages) != 1:
        raise invalid("expected_one_native_denoiser")
    step = stages[0]
    sid = step["step_id"]
    provider = providers[sid]
    recorded = evidence["recipe"]["steps"][sid]
    effective = run["steps"][sid]["settings"]["effective"]
    load = effective["load"]
    options = load["provider_options"]
    overrides = settings.get("parameters", {})
    allowed = (
        {"seed", "steps", "audio_shift", "video_shift"}
        if provider == "h3.dit"
        else {"seed", "steps", "guidance", "sigma_schedule", "flow_shift_mu"}
    )
    if extra := sorted(set(overrides) - allowed):
        raise invalid("field_not_native_to_denoiser", fields=extra, provider=provider)
    params = {**effective["parameters"], **overrides}
    task = _task(run, providers, step)
    if task != settings["task"]:
        raise invalid(
            "task_does_not_match_source", requested=settings["task"], captured=task
        )
    variant = options.get("variant")
    roles = settings.get("adapter_roles", [])
    if provider == "h3.dit":
        if variant != ("ref2va" if task == "ref2va" else "fl2va"):
            raise invalid("h3_checkpoint_task_mismatch")
        adapters = _h3_adapters(options, params)
        if roles and roles != [a["role"] for a in adapters]:
            raise invalid("native_accelerator_role_mismatch")
        scheduler = "h3_euler"
    else:
        _validate_qwen_sampling(load, params, effective, variant)
        adapters = _qwen_adapters(options, roles, recorded)
        scheduler = "FlowMatchEulerDiscreteScheduler"
    return {
        "provider": provider,
        "step_id": sid,
        "task": task,
        "variant": variant,
        "parameters": params,
        "scheduler": scheduler,
        "adapters": adapters,
        "precision": load.get("precision"),
        "part_overrides": load.get("part_overrides", []),
        "requested_attention": options.get("attention"),
        "recorded_attention": recorded["observed"]["active_attention_backend"],
        "model_identity": recorded["model"],
        "runtime": recorded["runtime"],
    }


def _validate_qwen_sampling(
    load: Doc, params: Doc, effective: Doc, variant: str
) -> None:
    if (
        variant not in {"bf16", "gguf_q4km"}
        or load["precision"].get("compute_dtype") != "bf16"
    ):
        raise invalid("unsupported_qwen_variant_or_dtype")
    if (
        not _MIN_QWEN_STEPS <= params["steps"] <= _MAX_QWEN_STEPS
        or not 0 <= params["seed"] <= _MAX_QWEN_SEED
    ):
        raise invalid("qwen_native_sampling_bounds")
    if params.get("sigma_schedule") not in {"native", "karras", "exponential"}:
        raise invalid("qwen_sigma_schedule")
    if (params["guidance"] > 1) != (effective["parameters"]["guidance"] > 1):
        raise invalid("conditioning_cfg_mismatch")
