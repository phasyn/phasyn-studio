"""CPU 元件 ``prompt.scene_compile`` 與 ``prompt.scene_score``（確定性；不載入模型、不 import torch）.

- ``prompt.scene_compile``：PromptScene → PromptCandidates（core／detailed），另輸出兩個 ``text.prompt.v1``
  （可直接接到 t2i 接線的 prompt）。
- ``prompt.scene_score``：op=loss（PromptComparison+凍結場景 → PromptScore）、op=rank（PromptEvaluationSet →
  PromptRanking）、op=confirm（A/B 與 B/A 兩個 PromptPairwise → PromptConfirmation）。

每個 op 需要的輸入以外的輸入一律 422（不默默忽略）；結果都以契約驗證後才輸出。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    Part,
    Port,
    RunContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

from .compiler import compile_scene
from .evaluation import (
    EvaluationError,
    evaluate_comparison,
    freeze_rubric,
    pairwise_confirms,
    ranking,
)
from .scene import SECTION_KEYS, SceneError, require_scene


SCENE = "prompt.scene.v1"
CANDIDATES = "prompt.candidates.v1"
PROMPT = "text.prompt.v1"
COMPARISON = "prompt.comparison.v1"
PAIRWISE = "prompt.pairwise.v1"
SCORE = "prompt.score.v1"
EVALUATIONS = "prompt.evaluations.v1"
RANKING = "prompt.ranking.v1"
CONFIRMATION = "prompt.confirmation.v1"
SECTION_LIST = {
    "type": "array",
    "items": {"enum": list(SECTION_KEYS)},
    "maxItems": 8,
    "uniqueItems": True,
}
VIEW_LIST = {
    "type": "array",
    "items": {"enum": ["v-full", "v-crop-1", "v-crop-2"]},
    "maxItems": 3,
    "uniqueItems": True,
}

COMPILE_PARAMS: dict[str, dict[str, Any]] = {
    "intentional_changes": {
        **SECTION_LIST,
        "default": [],
        "description": "有意修改的區段（必須是鎖定區段）",
    },
    "views": {
        "anyOf": [VIEW_LIST, {"type": "null"}],
        "default": None,
        "description": "研究實際使用的視圖（v-full\N{FULLWIDTH PLUS SIGN}裁切）；給定時 observation 只能引用這些視圖",
    },
}
SCORE_PARAMS: dict[str, dict[str, Any]] = {
    "op": {"enum": ["loss", "rank", "confirm"], "default": "loss"},
    "intentional_changes": {
        **SECTION_LIST,
        "default": [],
        "description": "op=loss：凍結 rubric 的有意修改",
    },
    "applicable_sections": {
        "anyOf": [{**SECTION_LIST, "minItems": 1}, {"type": "null"}],
        "default": None,
        "description": "op=loss：明確的適用區段；null\N{FULLWIDTH EQUALS SIGN}凍結場景中非空的區段",
    },
    "rubric_sha256": {
        "anyOf": [{"type": "string", "pattern": "^[a-f0-9]{64}$"}, {"type": "null"}],
        "default": None,
        "description": "op=loss：任務凍結的 rubric SHA-256；給定時必須與這次的場景\N{FULLWIDTH PLUS SIGN}有意修改相符",
    },
    "challenger_first": {
        "type": "boolean",
        "default": False,
        "description": "op=confirm：第一次比較 A 是否為挑戰者",
    },
}


def _cpu_defaults(group: str, invoke: dict[str, Any]) -> dict[str, Any]:
    return {
        "load": {"device": {"kind": "cpu", "id": "cpu", "resource_group": group}},
        "invoke": invoke,
        "recording": normalize_recording({"mode": "detailed"}),
    }


def _params(ctx: RunContext, schema: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    return {key: value.get("default") for key, value in schema.items()} | dict(
        ctx.parameters
    )


def _inline(ctx: RunContext, port: str, schema: str, what: str) -> dict[str, Any]:
    item = ctx.input(port)
    if item.value is None:
        raise ComponentError("INVALID_ARGUMENT", f"{what}（{port}）必須是 inline JSON")
    contracts.validate(schema, item.value, what=what)
    return dict(item.value)


def _only(ctx: RunContext, allowed: set[str], op: str) -> None:
    extra = sorted(set(ctx.inputs) - allowed)
    if extra:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"op={op} 不使用輸入 {', '.join(extra)}（不默默忽略）",
            details={"op": op, "unexpected_inputs": extra},
        )


class SceneCompileProvider(BaseProvider):
    """Compile a structured scene to a generation prompt."""

    provider_id = "prompt.scene_compile"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - Provider and callback signatures accept these argument names.
        """Describe the ports, settings and current runtime availability."""
        return Description(
            provider_id=cls.provider_id,
            kind="prompt.compile",
            label="反推場景編譯（確定性；core／detailed 兩個 prompt 候選）",
            inputs=[
                Port(
                    "scene",
                    SCENE,
                    required=True,
                    transport="inline",
                    description="PromptScene（八區段場景）",
                )
            ],
            outputs=[
                Port(
                    "candidates",
                    CANDIDATES,
                    required=True,
                    transport="inline",
                    description="PromptCandidates（core 在前）",
                ),
                Port(
                    "core_prompt",
                    PROMPT,
                    required=True,
                    transport="inline",
                    description="core 候選的 prompt（可直接接 t2i）",
                ),
                Port(
                    "detailed_prompt",
                    PROMPT,
                    required=True,
                    transport="inline",
                    description="detailed 候選的 prompt",
                ),
            ],
            parts=[
                Part(
                    "prompt.compiler",
                    "rules",
                    {"type": "object", "properties": {}},
                    ["host_ms"],
                    "full",
                    None,
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=COMPILE_PARAMS, device_kinds=("cpu",)
            ),
            parameters_schema={
                "type": "object",
                "properties": COMPILE_PARAMS,
                "additionalProperties": False,
            },
            default_settings=_cpu_defaults("cpu-text", {"intentional_changes": []}),
        )

    def invoke(self, ctx: RunContext) -> None:
        """Run this provider with the validated call context."""
        params = _params(ctx, COMPILE_PARAMS)
        _only(ctx, {"scene"}, "compile")
        with ctx.recorder.span("prompt.compile", part="prompt.compiler"):
            scene = require_scene(_inline(ctx, "scene", "PromptScene", "場景"))
            candidates = compile_scene(
                scene,
                params.get("intentional_changes") or [],
                view_ids=params.get("views"),
            )
        core, detailed = candidates["items"]
        ctx.recorder.log(
            "info",
            "場景編譯完成",
            scene_sha256=candidates["scene_sha256"],
            identical=candidates["identical"],
            core_sections=core["sections"],
            detailed_sections=detailed["sections"],
        )
        ctx.set_output("candidates", candidates)
        ctx.set_output("core_prompt", core["prompt"])
        ctx.set_output("detailed_prompt", detailed["prompt"])


class SceneScoreProvider(BaseProvider):
    """Score and rank the submitted scene candidates."""

    provider_id = "prompt.scene_score"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - Provider and callback signatures accept these argument names.
        """Describe the ports, settings and current runtime availability."""
        return Description(
            provider_id=cls.provider_id,
            kind="prompt.score",
            label="反推比較評分（確定性；逐區段加權損失、排名、雙順序確認）",
            inputs=[
                Port(
                    "comparison",
                    COMPARISON,
                    required=False,
                    transport="inline",
                    description="op=loss：qimg.vision compare 的結果",
                ),
                Port(
                    "scene",
                    SCENE,
                    required=False,
                    transport="inline",
                    description="op=loss：任務開始時凍結的場景（不是修訂後的場景）",
                ),
                Port(
                    "evaluations",
                    EVALUATIONS,
                    required=False,
                    transport="inline",
                    description="op=rank：同一任務、同一 rubric 的評估",
                ),
                Port(
                    "pairwise_ab",
                    PAIRWISE,
                    required=False,
                    transport="inline",
                    description="op=confirm：A\N{FULLWIDTH EQUALS SIGN}現任、B\N{FULLWIDTH EQUALS SIGN}挑戰者",
                ),
                Port(
                    "pairwise_ba",
                    PAIRWISE,
                    required=False,
                    transport="inline",
                    description="op=confirm：交換圖片後的同一比較",
                ),
            ],
            outputs=[
                Port(
                    "score",
                    SCORE,
                    required=False,
                    transport="inline",
                    description="op=loss：PromptScore",
                ),
                Port(
                    "ranking",
                    RANKING,
                    required=False,
                    transport="inline",
                    description="op=rank：PromptRanking",
                ),
                Port(
                    "confirmation",
                    CONFIRMATION,
                    required=False,
                    transport="inline",
                    description="op=confirm：PromptConfirmation",
                ),
            ],
            parts=[
                Part(
                    "prompt.scorer",
                    "rules",
                    {"type": "object", "properties": {}},
                    ["host_ms"],
                    "full",
                    None,
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=SCORE_PARAMS, device_kinds=("cpu",)
            ),
            parameters_schema={
                "type": "object",
                "properties": SCORE_PARAMS,
                "additionalProperties": False,
            },
            default_settings=_cpu_defaults("cpu-text", {"op": "loss"}),
        )

    def invoke(self, ctx: RunContext) -> None:
        """Run this provider with the validated call context."""
        params = _params(ctx, SCORE_PARAMS)
        op = str(params["op"])
        with ctx.recorder.span(f"prompt.score.{op}", part="prompt.scorer"):
            if op == "loss":
                self._loss(ctx, params)
            elif op == "rank":
                self._rank(ctx)
            else:
                self._confirm(ctx, params)

    def _loss(self, ctx: RunContext, params: Mapping[str, Any]) -> None:
        _only(ctx, {"comparison", "scene"}, "loss")
        comparison = _inline(ctx, "comparison", "PromptComparison", "比較結果")
        scene = require_scene(_inline(ctx, "scene", "PromptScene", "凍結場景"))
        try:
            rubric = freeze_rubric(
                scene,
                params.get("intentional_changes") or [],
                applicable_sections=params.get("applicable_sections"),
            )
        except SceneError as exc:
            raise ComponentError("INVALID_ARGUMENT", f"無法凍結 rubric：{exc}") from exc
        expected = params.get("rubric_sha256")
        if expected is not None and expected != rubric["sha256"]:
            raise ComponentError(
                "RUBRIC_MISMATCH",
                "凍結 rubric 與這次的場景\N{FULLWIDTH PLUS SIGN}有意修改不符（不同實驗的評估不可混用）",
                details={
                    "expected_rubric_sha256": expected,
                    "actual_rubric_sha256": rubric["sha256"],
                },
                status=422,
            )
        score = evaluate_comparison(comparison, rubric)
        contracts.validate("PromptScore", score, code="RUNTIME_ERROR", what="評分結果")
        ctx.recorder.log(
            "info",
            "比較評分完成",
            loss=score["loss"],
            evaluable_weight_fraction=score["evaluable_weight_fraction"],
            unverified=score["unverified"],
            rubric_sha256=rubric["sha256"],
        )
        ctx.set_output("score", score)

    def _rank(self, ctx: RunContext) -> None:
        _only(ctx, {"evaluations"}, "rank")
        evaluations = _inline(ctx, "evaluations", "PromptEvaluationSet", "評估集合")
        try:
            result = ranking(evaluations)
        except EvaluationError as exc:
            raise ComponentError("INVALID_ARGUMENT", f"評估無法排名：{exc}") from exc
        contracts.validate(
            "PromptRanking", result, code="RUNTIME_ERROR", what="排名結果"
        )
        ctx.recorder.log(
            "info",
            "評估排名完成",
            initial=result["initial"],
            improvement=result["improvement"],
        )
        ctx.set_output("ranking", result)

    def _confirm(self, ctx: RunContext, params: Mapping[str, Any]) -> None:
        _only(ctx, {"pairwise_ab", "pairwise_ba"}, "confirm")
        first = _inline(ctx, "pairwise_ab", "PromptPairwise", "第一次雙圖比較")
        second = _inline(ctx, "pairwise_ba", "PromptPairwise", "交換後的雙圖比較")
        challenger_first = bool(params.get("challenger_first"))
        result = {
            "confirmed": pairwise_confirms(
                str(first["winner"]),
                str(second["winner"]),
                challenger_first=challenger_first,
            ),
            "winners": [first["winner"], second["winner"]],
            "expected": ["A", "B"] if challenger_first else ["B", "A"],
            "challenger_first": challenger_first,
        }
        contracts.validate(
            "PromptConfirmation", result, code="RUNTIME_ERROR", what="確認結果"
        )
        ctx.set_output("confirmation", result)


__all__ = ["SceneCompileProvider", "SceneScoreProvider"]
