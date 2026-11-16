"""Additive execution target gate; pure control-side validation, no runtime import."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .errors import diagnostic


def execution_target_diagnostics(request: Mapping[str, Any], family: str) -> list[dict[str, Any]]:
    target = request.get("execution_target", "generation")
    if target not in ("generation", "conditioning"):
        return [diagnostic("UNSUPPORTED_COMBINATION", "未知 execution_target", field_paths=["execution_target"])]
    cache_mode = request.get("conditioning_cache_mode", "off")
    if cache_mode not in ("off", "benchmark_exact"):
        return [
            diagnostic(
                "UNSUPPORTED_COMBINATION", "未知 conditioning_cache_mode", field_paths=["conditioning_cache_mode"]
            )
        ]
    if target == "generation" and cache_mode == "off":
        return []
    problems = []
    if family != "minimax_h3":
        problems.append(
            diagnostic(
                "UNSUPPORTED_COMBINATION",
                "此 adapter 未實作 conditioning target",
                field_paths=["execution_target", "model_id"],
            )
        )
    if (request.get("prompt") or {}).get("context_mode") != "verbatim":
        problems.append(
            diagnostic(
                "UNSUPPORTED_COMBINATION",
                "conditioning target 目前只接受 verbatim prompt",
                field_paths=["prompt.context_mode"],
            )
        )
    allowed = {"ingest", "resolve_context", "prepare_media", "encode_conditioning", "commit_artifacts"}
    if target == "conditioning" and set(request.get("stage_overrides") or {}) - allowed:
        problems.append(
            diagnostic(
                "UNSUPPORTED_COMBINATION",
                "conditioning target 不接受未執行 stage 的 override",
                field_paths=["stage_overrides"],
            )
        )
    return problems
