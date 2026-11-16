"""H3 second-stage semantic validation of a schema-valid JobRequest.

Field paths are job-request paths (``output.width``, ``materials[1].role``);
cross-checks against the site config are reported as ``config.<path>`` and
against the profile as ``profile.<path>``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_h3.recipe.abi.values import UINT64_MAX, get_path, parse_seed

from . import constants as C
from ._diag import INVALID, UNSUPPORTED, err, warn
from .geometry import build_geometry
from .materials import TASK_POLICIES, material_diagnostics


def task_variant_diagnostics(task: Any, model_variant: Any) -> list[dict[str, Any]]:
    """(SG:task_profiles.py:32-38)."""
    if task not in TASK_POLICIES:
        return [err(UNSUPPORTED, f"H3 未登記 task「{task}」；可用：t2va、fl2va、ref2va", "task", actual=task)]
    required = C.TASK_VARIANT[task]
    if model_variant != required:
        return [
            err(
                UNSUPPORTED,
                f"task {task} 需要 {required} checkpoint，目前模型 variant 是 {model_variant}；FL2VA 與 Ref2VA 不互換",
                "task",
                "model_id",
                expected=required,
                actual=model_variant,
            )
        ]
    return []


def seed_diagnostics(seed: Any, runtime_provider: str | None = None) -> list[dict[str, Any]]:
    """via ``parse_seed``; plus the pinned SGLang signed-int64 limit."""
    try:
        value = parse_seed(seed)
    except ValueError as exc:
        return [err(INVALID, str(exc), "sampling.seed", expected=f"0..{UINT64_MAX}", actual=seed)]
    if runtime_provider == C.RUNTIME_SGLANG and value > C.SGLANG_MAX_SEED:
        return [
            err(
                UNSUPPORTED,
                f"釘版 SGLang H3 只接受 0..{C.SGLANG_MAX_SEED} 的 seed"
                "（request_validation.py；condition noise 另用 seed+1）；"
                "此 uint64 seed 不會被改寫，請改用較小 seed 或其他 runtime",
                "sampling.seed",
                "profile.runtime_provider",
                expected=f"<= {C.SGLANG_MAX_SEED}",
                actual=seed,
            )
        ]
    return []


def sampling_diagnostics(sampling: Mapping[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    scheduler = sampling.get("scheduler")
    if scheduler != C.SCHEDULER_ID:
        out.append(
            err(
                UNSUPPORTED,
                f"H3 只支援 scheduler {C.SCHEDULER_ID}",
                "sampling.scheduler",
                expected=C.SCHEDULER_ID,
                actual=scheduler,
            )
        )
    steps = sampling.get("steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= C.MAX_STEPS:
        out.append(err(INVALID, f"steps 必須是 1..{C.MAX_STEPS} 的整數", "sampling.steps", actual=steps))
    for key in ("video_shift", "audio_shift"):
        value = sampling.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
            out.append(err(INVALID, f"{key} 必須是正數", f"sampling.{key}", actual=value))
    return out


def context_diagnostics(
    request: Mapping[str, Any], config: Mapping[str, Any] | None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Context modes.  Missing config means every provider is disabled."""
    config = config or {}
    mode = get_path(request, "prompt.context_mode", "verbatim")
    facts: dict[str, Any] = {
        "mode": mode,
        "keeps_original_prompt": True,
        "official_ir": False,
        "external_processing": False,
    }
    out: list[dict[str, Any]] = []
    if mode == "verbatim":
        return out, facts
    if mode == "local_rewrite":
        if get_path(config, "providers.local_rewrite.enabled") is not True:
            out.append(
                err(
                    UNSUPPORTED,
                    "local_rewrite 需要站台啟用本地改寫 provider；未啟用時不改寫、也不偽裝成官方 IR",
                    "prompt.context_mode",
                    "config.providers.local_rewrite.enabled",
                )
            )
        elif not get_path(config, "providers.local_rewrite.model_id"):
            out.append(
                err(
                    INVALID,
                    "local_rewrite 已啟用但沒有指定 model_id",
                    "prompt.context_mode",
                    "config.providers.local_rewrite.model_id",
                )
            )
        facts.update(provider="local_rewrite", node_role=get_path(config, "providers.local_rewrite.node_role"))
        return out, facts
    if mode == "official_api":
        checks = (
            (
                get_path(config, "network.allow_external_processing") is True,
                "config.network.allow_external_processing",
                "站台未允許外部處理",
            ),
            (request.get("allow_external_processing") is True, "allow_external_processing", "此 job 未允許外部處理"),
            (get_path(config, "network.offline") is not True, "config.network.offline", "站台處於 offline 模式"),
            (
                get_path(config, "providers.official_context_ir.enabled") is True,
                "config.providers.official_context_ir.enabled",
                "官方 Context-IR provider 未啟用",
            ),
            (
                bool(get_path(config, "providers.official_context_ir.secret_ref")),
                "config.providers.official_context_ir.secret_ref",
                "官方 Context-IR 沒有設定 secret_ref",
            ),
        )
        for ok, path, reason in checks:
            if not ok:
                out.append(
                    err(
                        UNSUPPORTED,
                        f"official_api 被拒絕：{reason}（RULE-009；官方 H3-Context-IR 只有 hosted 服務，BLK-001）",
                        "prompt.context_mode",
                        path,
                    )
                )
        if not out:
            out.append(
                warn(
                    "EXTERNAL_PROCESSING",
                    "將把 prompt 與素材描述送往官方 hosted H3-Context-IR（未開源，BLK-001）；結果不是本地生成的 IR",
                    "prompt.context_mode",
                )
            )
        facts.update(
            provider="official_context_ir",
            official_ir=True,
            external_processing=True,
            api_base=get_path(config, "providers.official_context_ir.api_base"),
        )
        return out, facts
    out.append(err(INVALID, f"未知的 context_mode「{mode}」", "prompt.context_mode"))
    return out, facts


def validate_job_semantics(
    request: Mapping[str, Any],
    model_variant: str | None,
    *,
    config: Mapping[str, Any] | None = None,
    runtime_provider: str | None = None,
) -> list[dict[str, Any]]:
    """All H3 job rules that need only the request (+ optional site config / runtime id).

    Returns diagnostics (errors and warnings); an empty error subset means the
    request is semantically valid for ``model_variant``.
    """
    out: list[dict[str, Any]] = []
    task = request.get("task")
    out.extend(task_variant_diagnostics(task, model_variant))
    materials = list(request.get("materials") or [])
    output = request.get("output") or {}
    out.extend(material_diagnostics(str(task), materials, duration_policy=output.get("duration_policy")))
    _, geometry_diags = build_geometry(
        requested_seconds=output.get("requested_seconds"),
        width=output.get("width"),
        height=output.get("height"),
        duration_policy=str(output.get("duration_policy", "preserve_generated")),
        runtime_provider=runtime_provider,
        fps=output.get("fps", C.FPS),
    )
    out.extend(geometry_diags)
    sampling = request.get("sampling") or {}
    out.extend(seed_diagnostics(sampling.get("seed"), runtime_provider))
    out.extend(sampling_diagnostics(sampling))
    context_diags, _ = context_diagnostics(request, config)
    out.extend(context_diags)
    return out
