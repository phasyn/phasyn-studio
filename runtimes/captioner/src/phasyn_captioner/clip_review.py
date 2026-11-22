"""``qwen_vl.clip_review``: review and caption every clip of a LoRA dataset (the automatic "reverse prompt").

For each clip the model sees its three-frame contact sheet (start, middle, end) and returns one JSON object:
the picture style (drawn animation, 3D CG, live action, title card), whether large on-screen text, subtitles or
a logo or watermark cover it, the number of people and whether they touch, the shot size, the camera move and a one or two
sentence caption. The user's training direction (for example the camera work and impact of fights) tells the
model what to describe in detail. People are referred to generically: no names, no titles, no hair or eye
colour. Unparsable answers are kept as such (``parsed: null``) and the clip is simply not trained on; nothing
is invented.
"""

from __future__ import annotations

import io
import json
import time
from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import Description, Part, Port, RunContext
from phasyn_components.settings import normalize_recording

from .provider import QwenVLDescribeProvider, _schema, cancel_criteria, extract_json

DATASET_TYPE = "lora.dataset.v1"
REVIEWS_TYPE = "lora.reviews.v1"
MAX_CLIPS = 4000
PARAMS: dict[str, dict[str, Any]] = {
    "max_new_tokens": {"type": "integer", "minimum": 64, "maximum": 1024, "default": 260},
    "roles": {
        "type": "array",
        "items": {"enum": ["train", "heldout", "eval_only"]},
        "default": ["train", "heldout", "eval_only"],
        "description": "要審核的來源角色",
    },
}
PROMPT = (
    "These are three frames (left to right, in time order) from one short shot of a video. "
    "The person training a video model on such shots wants to learn: {direction}. "
    "Answer with ONE JSON object only, keys: "
    '"style" (one of "2d animation", "3d cg", "live action", "mixed", "title card"), '
    '"people" (integer number of people or characters visible, 0 if none), '
    '"contact" (true if characters touch, grapple, strike or block each other), '
    '"camera" (one of "static", "pan", "tilt", "zoom in", "zoom out", "tracking", "shake", "rotate"), '
    '"shot" (one of "extreme close-up", "close-up", "medium", "wide", "extreme wide"), '
    '"big_text" (true if large on-screen text or a title covers the picture; a small subtitle line or a corner '
    'logo does not count), "subtitles" (true if a subtitle line is visible near the bottom edge), '
    '"logo" (true if a channel logo, a watermark or an uploader name is laid over the picture, even a faint one), '
    '"caption" (one or two English sentences describing the action and motion, the camera and the staging, '
    "in particular what the training goal above is about: who moves where, hits, impacts, reactions, speed lines, "
    "camera moves. Refer to people only as 'a person', 'a young woman', 'a man', 'two fighters' and so on. "
    "Never give names, never name a series, game or franchise, never mention hair or eye colour, never mention "
    "subtitles, text or logos)."
)


def _dataset(ctx: RunContext) -> dict[str, Any]:
    path = ctx.input("dataset").require_path("dataset")
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, Mapping) or doc.get("schema") != DATASET_TYPE:
        raise ComponentError("INVALID_ARGUMENT", "dataset 必須是 lora.dataset.v1")
    return dict(doc)


def _direction(ctx: RunContext) -> str:
    value = ctx.input("direction").value
    text = str(value.get("text") if isinstance(value, Mapping) else value or "").strip()
    if not text:
        raise ComponentError("INVALID_ARGUMENT", "需要訓練方向（direction）")
    return text[:500]


class ClipReviewProvider(QwenVLDescribeProvider):
    """Contact sheets of a LoRA dataset -> one structured review and caption per clip."""

    provider_id = "qwen_vl.clip_review"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Same model and settings as ``qwen_vl.describe``; other ports."""
        base = super().describe(settings)
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="lora.review",
            label="LoRA 訓練片段自動反推（Qwen-VL：風格判定與無身分 caption）",
            inputs=[
                Port("dataset", DATASET_TYPE, True, "file", "lora.dataset.v1（片段縮圖表）"),
                Port("direction", "text.prompt.v1", True, "inline", "訓練方向（例如：動漫戰鬥的運鏡與打擊感）"),
            ],
            outputs=[Port("reviews", REVIEWS_TYPE, True, "file", "lora.reviews.v1：每段的判定與 caption")],
            parts=[Part("language_model", "llm", empty, ["host_ms", "output_tokens"], "full", None)],
            settings_schema=_schema(),
            parameters_schema={"type": "object", "properties": PARAMS, "additionalProperties": False},
            default_settings={
                **base.default_settings,
                "invoke": {},
                "recording": normalize_recording({"mode": "summary"}),
            },
            available=base.available,
            unavailable_code=base.unavailable_code,
            unavailable_reason=base.unavailable_reason,
        )

    def _review_one(self, ctx: RunContext, image: Any, prompt: str, max_tokens: int) -> tuple[str, int]:
        import torch

        messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": prompt}]}]
        inputs = self.processor.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt"
        ).to(self.model.device)
        with torch.inference_mode():
            out = self.model.generate(
                **inputs, max_new_tokens=max_tokens, do_sample=False, stopping_criteria=cancel_criteria(ctx.cancelled)
            )
        start = int(inputs["input_ids"].shape[1])
        text = self.processor.batch_decode(out[:, start:], skip_special_tokens=True)[0]
        return text, int(out.shape[1] - start)

    def invoke(self, ctx: RunContext) -> None:
        """Review every kept clip of the requested roles and publish the reviews document."""
        from PIL import Image

        params: dict[str, Any] = {k: v.get("default") for k, v in PARAMS.items()} | dict(ctx.parameters)
        doc = _dataset(ctx)
        direction = _direction(ctx)
        roles = set(params["roles"])
        clips = [
            c for c in doc.get("clips") or [] if not c.get("rejected") and c.get("role") in roles and c.get("sheet")
        ]
        if len(clips) > MAX_CLIPS:
            raise ComponentError("INVALID_ARGUMENT", f"片段超過上限 {MAX_CLIPS}")
        prompt = PROMPT.format(direction=direction)
        reviews: dict[str, Any] = {}
        tokens = 0
        started = time.perf_counter()
        for i, clip in enumerate(clips):
            ctx.check_cancelled()
            data = ctx.resolve_file(clip["sheet"]).read_bytes()
            image = Image.open(io.BytesIO(data)).convert("RGB")
            with ctx.recorder.span("generate", part="language_model"):
                text, used = self._review_one(ctx, image, prompt, int(params["max_new_tokens"]))
            tokens += used
            try:
                parsed: dict[str, Any] | None = extract_json(text)
            except (ValueError, json.JSONDecodeError):
                parsed = None
            reviews[str(clip["clip_id"])] = {"parsed": parsed, "raw": text[:2000]}
            if ctx.preview_enabled:
                caption = (parsed or {}).get("caption") or "（無法解析）"
                ctx.publish_preview(
                    step=i + 1,
                    total=len(clips),
                    data=data,
                    media_type="image/jpeg",
                    width=image.width,
                    height=image.height,
                    note=f"{i + 1}/{len(clips)} {str(caption)[:300]}",
                )
        ctx.recorder.set_metric("output_tokens", tokens, unit="count", scope="component_call", method="runtime_hook")
        result = {
            "schema": REVIEWS_TYPE,
            "direction": direction,
            "prompt": prompt,
            "model": self.identity["components"]["model"].get("name"),
            "seconds": round(time.perf_counter() - started, 1),
            "reviews": reviews,
            "unparsed": sorted(k for k, v in reviews.items() if v["parsed"] is None),
        }
        out = ctx.new_file("reviews", "application/json", {"clips": len(reviews)})
        out.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
        ctx.set_file_output("reviews", out)


__all__ = ["PROMPT", "ClipReviewProvider"]
