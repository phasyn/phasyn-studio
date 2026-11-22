"""``caption.compile``：依 SceneDocument 以固定規則組 caption.

觀測事實（training caption）與創作修改（generation_edits → generation prompt）分開：
訓練目標只用觀測內容，uncertain 事件預設排除，由使用者明確 include_uncertain。沒有 reviewed
旗標或審核門檻；空 caption 或來源不符是資料錯誤。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from .. import contracts
from ..errors import ComponentError
from ..provider import BaseProvider, Description, Port, RunContext, settings_schema
from ..settings import normalize_recording


PARAMS: dict[str, dict[str, Any]] = {
    "language": {"enum": ["en", "zh-Hant"], "default": "en"},
    "include_uncertain": {"type": "boolean", "default": False},
    "scene_recording_id": {"type": ["string", "null"], "default": None},
}


def load_scene(ctx: RunContext, port: str = "scene") -> dict[str, Any]:
    """Read the structured scene supplied as an input."""
    item = ctx.input(port)
    scene: dict[str, Any]
    if item.file is not None:
        try:
            scene = json.loads(item.require_path(port).read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT", f"Scene 不是有效 JSON：{exc}"
            ) from exc
    else:
        scene = item.value
    contracts.validate("SceneDocument", scene, what="SceneDocument")
    check_scene(scene)
    return scene


def check_scene(scene: Mapping[str, Any]) -> None:
    """Validate a scene before compiling its caption."""
    duration = float(scene["duration_seconds"])
    evidence_ids = {e["frame_id"] for e in scene.get("evidence") or []}
    entity_ids = {e["entity_id"] for e in scene.get("entities") or []}
    for event in scene.get("events") or []:
        if (
            not 0
            <= float(event["start_seconds"])
            <= float(event["end_seconds"])
            <= duration + 1e-6
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"事件 {event['event_id']} 的時間超出影片長度或起訖顛倒",
            )
        missing = [
            f for f in event.get("evidence_frame_ids") or [] if f not in evidence_ids
        ]
        if missing:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"事件 {event['event_id']} 引用不存在的證據影格：{', '.join(missing)}",
            )
        unknown = [e for e in event.get("entity_ids") or [] if e not in entity_ids]
        if unknown:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"事件 {event['event_id']} 引用不存在的主體：{', '.join(unknown)}",
            )


def _sentence(text: str, language: str) -> str:
    text = text.strip()
    if not text:
        return ""
    end = "。" if language == "zh-Hant" else "."
    return text if text[-1] in ".。!?！？" else text + end


def compile_caption(
    scene: Mapping[str, Any], *, language: str, include_uncertain: bool
) -> tuple[str, list[str]]:
    """回傳 (training_caption, 被排除的 uncertain 事件 id)."""
    excluded: list[str] = []
    parts: list[str] = []
    if scene.get("initial_state"):
        parts.append(_sentence(str(scene["initial_state"]), language))
    events = sorted(
        scene.get("events") or [],
        key=lambda e: (float(e["start_seconds"]), float(e["end_seconds"])),
    )
    for event in events:
        if event.get("certainty") == "uncertain" and not include_uncertain:
            excluded.append(str(event["event_id"]))
            continue
        parts.append(_sentence(str(event["description"]), language))
    if scene.get("final_state"):
        parts.append(_sentence(str(scene["final_state"]), language))
    if scene.get("camera"):
        prefix = "鏡頭：" if language == "zh-Hant" else "Camera: "
        parts.append(_sentence(prefix + str(scene["camera"]), language))
    sep = "" if language == "zh-Hant" else " "
    return sep.join(p for p in parts if p).strip(), excluded


class CaptionCompileProvider(BaseProvider):
    """Compile a structured scene into caption outputs."""

    provider_id = "caption.compile"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - Provider lifecycle accepts this parameter by contract.
        """Describe the provider and its supported inputs and outputs."""
        return Description(
            provider_id=cls.provider_id,
            kind="caption.compile",
            label="Caption 組裝（固定規則；觀測事實與創作修改分開）",
            inputs=[
                Port(
                    "scene",
                    "video.scene.v1",
                    required=True,
                    transport="either",
                    description="SceneDocument（反推結果或使用者另存的修正版）",
                )
            ],
            outputs=[
                Port(
                    "caption",
                    "caption.pair.v1",
                    required=True,
                    transport="inline",
                    description="training caption 與 generation prompt",
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=PARAMS, device_kinds=("cpu",)
            ),
            parameters_schema={
                "type": "object",
                "properties": PARAMS,
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-text"}
                },
                "invoke": {"language": "en", "include_uncertain": False},
                "recording": normalize_recording({"mode": "detailed"}),
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Perform one invocation using the supplied context."""
        params: dict[str, Any] = {
            k: v.get("default") for k, v in PARAMS.items()
        } | dict(ctx.parameters)
        language = str(params["language"])
        include_uncertain = bool(params["include_uncertain"])
        with ctx.recorder.span("caption.compile", part="caption.rules"):
            scene = load_scene(ctx)
            caption, excluded = compile_caption(
                scene, language=language, include_uncertain=include_uncertain
            )
        if not caption:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "Scene 沒有可用的觀測內容，無法產生 caption（資料錯誤，不是審核問題）",
            )
        edits = [
            str(e).strip()
            for e in scene.get("generation_edits") or []
            if str(e).strip()
        ]
        sep = "" if language == "zh-Hant" else " "
        prompt = caption + (
            sep + sep.join(_sentence(e, language) for e in edits) if edits else ""
        )
        ctx.recorder.log(
            "info",
            "caption 組裝完成",
            included_events=len(scene.get("events") or []) - len(excluded),
            excluded_uncertain=excluded,
            generation_edits=len(edits),
        )
        ctx.set_output(
            "caption",
            {
                "source": scene["source"],
                "scene_recording_id": params.get("scene_recording_id"),
                "training_caption": caption,
                "generation_prompt": prompt,
                "include_uncertain": include_uncertain,
                "language": language,
            },
        )


__all__ = ["CaptionCompileProvider", "check_scene", "compile_caption", "load_scene"]
