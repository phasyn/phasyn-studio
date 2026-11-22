"""Qwen3-VL native inference (processor and generate) on top of the public transformers API.

``prepare``：套 chat template、以 processor 處理圖片（min／max_pixels 明確設定，不截斷文字），核對每張圖的
原生 grid 與 image token 數；``generate``：greedy（do_sample=False）、只解碼新產生的 token、以
StoppingCriteria 在每個 token 邊界檢查取消／期限，回報 finish_reason（達上限=length）。

torch／transformers 只在建構與方法內匯入；provider 的測試以假的 engine 取代這個類別（不載入任何權重）。
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, override

from phasyn_components.errors import ComponentError


_GRID_RANK = 2


@dataclass
class Prepared:
    """Prepared multimodal inputs with their token counts."""

    inputs: Any
    input_tokens: int
    effective_pixels: list[tuple[int, int]] = field(default_factory=list)


@dataclass
class Generation:
    """Generated tokens and their decoded response."""

    raw: str
    output_tokens: int
    finish_reason: str  # stop | length
    elapsed_ms: float
    first_token_ms: float | None


class Engine(Protocol):
    """The generation engine used by the vision provider."""

    def prepare(
        self, messages: list[dict[str, Any]], images: Sequence[Any]
    ) -> Prepared:
        """Prepare the multimodal inputs used for generation."""
        ...

    def generate(
        self,
        prepared: Prepared,
        *,
        max_new_tokens: int,
        should_stop: Callable[[], bool],
    ) -> Generation:
        """Generate a response from prepared inputs."""
        ...

    def close(self) -> None:
        """Release the resources held by the engine."""
        ...


def validate_qwen_inputs(
    inputs: Any, processor: Any, image_count: int
) -> list[tuple[int, int]]:
    """Every image needs a native image grid, and the image token count must equal Σ t·h·w / merge²."""
    grid = inputs.get("image_grid_thw")
    if grid is None or len(grid.shape) != _GRID_RANK or grid.shape[0] != image_count:
        raise ComponentError(
            "RUNTIME_ERROR", "Qwen processor 未包含每張圖片的原生 image grid"
        )
    patch = getattr(processor.image_processor, "patch_size", None)
    merge = getattr(processor.image_processor, "merge_size", None)
    if (
        not isinstance(patch, int)
        or not isinstance(merge, int)
        or min(patch, merge) < 1
    ):
        raise ComponentError(
            "RUNTIME_ERROR", "Qwen processor 缺少原生 patch／merge 設定"
        )
    rows = grid.tolist()
    expected = sum(int(t) * int(h) * int(w) // (merge * merge) for t, h, w in rows)
    image_token = getattr(processor, "image_token_id", None)
    actual = inputs["input_ids"][0].tolist().count(image_token)
    if image_token is None or actual != expected or expected < 1:
        raise ComponentError("RUNTIME_ERROR", "Qwen 圖片 token 數與視覺 grid 不一致")
    return [(int(w) * patch, int(h) * patch) for _, h, w in rows]


def move_inputs(inputs: Any, torch: Any, device: str) -> dict[str, Any]:
    """只把浮點 pixel tensor 轉 bf16；token／mask／grid 保持整數型別（不對就拒絕）."""
    result: dict[str, Any] = {}
    for key, value in dict(inputs).items():
        if not hasattr(value, "to"):
            result[key] = value
            continue
        if key.startswith("pixel_values"):
            result[key] = value.to(device=device, dtype=torch.bfloat16)
        else:
            if key in {
                "input_ids",
                "attention_mask",
                "image_grid_thw",
                "video_grid_thw",
            } and bool(torch.is_floating_point(value)):
                raise ComponentError(
                    "RUNTIME_ERROR", "Processor 的 token／grid dtype 不正確"
                )
            result[key] = value.to(device=device)
    return result


class QwenEngine:
    """一個常駐的 Qwen3-VL（bf16、local_files_only、trust_remote_code=False）."""

    def __init__(
        self,
        model_path: str,
        *,
        device: str,
        attn_implementation: str,
        min_pixels: int,
        max_pixels: int,
    ) -> None:
        """Initialize the state for this operation."""
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

        self.torch = torch
        self.device = device
        self.min_pixels = int(min_pixels)
        self.max_pixels = int(max_pixels)
        load_pretrained: Callable[..., Any] = AutoProcessor.from_pretrained
        self.processor = load_pretrained(
            model_path, local_files_only=True, trust_remote_code=False
        )
        self.model: Any = Qwen3VLForConditionalGeneration.from_pretrained(
            model_path,
            local_files_only=True,
            trust_remote_code=False,
            dtype=torch.bfloat16,
            device_map={"": device},
            attn_implementation=attn_implementation,
            use_safetensors=True,
        )
        evaluate: Callable[[], Any] = self.model.eval
        evaluate()

    def parameter_dtypes(self) -> dict[str, int]:
        """Inspect the loaded model parameter dtypes."""
        counts: dict[str, int] = {}
        for parameter in self.model.parameters():
            counts[str(parameter.dtype)] = counts.get(str(parameter.dtype), 0) + int(
                parameter.numel()
            )
        return counts

    def prepare(
        self, messages: list[dict[str, Any]], images: Sequence[Any]
    ) -> Prepared:
        """Prepare the multimodal inputs used for generation."""
        rendered = self.processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = dict(
            self.processor(
                text=[rendered],
                images=list(images),
                return_tensors="pt",
                padding=False,
                truncation=False,
                images_kwargs={
                    "min_pixels": self.min_pixels,
                    "max_pixels": self.max_pixels,
                },
            )
        )
        dimensions = validate_qwen_inputs(inputs, self.processor, len(images))
        if any(width * height > self.max_pixels for width, height in dimensions):
            raise ComponentError(
                "RUNTIME_ERROR", "Qwen processor 未遵守 max_pixels 面積上限"
            )
        return Prepared(inputs, int(inputs["input_ids"].shape[-1]), dimensions)

    def generate(
        self,
        prepared: Prepared,
        *,
        max_new_tokens: int,
        should_stop: Callable[[], bool],
    ) -> Generation:
        """Generate a response from prepared inputs."""
        torch = self.torch
        from transformers import StoppingCriteria, StoppingCriteriaList

        started = time.perf_counter()
        first: dict[str, float] = {}

        class StopAtBoundary(StoppingCriteria):
            @override
            def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
                first.setdefault("t", time.perf_counter())
                return bool(should_stop())

        moved = move_inputs(prepared.inputs, torch, self.device)
        with torch.inference_mode():
            generated = self.model.generate(
                **moved,
                max_new_tokens=int(max_new_tokens),
                do_sample=False,
                use_cache=True,
                stopping_criteria=StoppingCriteriaList([StopAtBoundary()]),
                return_dict_in_generate=True,
            )
        sequences = generated.sequences
        suffix = sequences[0, moved["input_ids"].shape[-1] :]
        count = int(suffix.shape[-1])
        eos = getattr(self.model.generation_config, "eos_token_id", None)
        eos_values = set(eos) if isinstance(eos, list) else {eos}
        stopped = count > 0 and int(suffix[-1]) in eos_values
        reason = "length" if count >= max_new_tokens and not stopped else "stop"
        raw = self.processor.tokenizer.decode(
            suffix, skip_special_tokens=True, clean_up_tokenization_spaces=False
        )
        if not isinstance(raw, str):
            raise ComponentError("RUNTIME_ERROR", "模型未輸出可解碼文字")
        return Generation(
            raw=raw,
            output_tokens=count,
            finish_reason=reason,
            elapsed_ms=(time.perf_counter() - started) * 1000,
            first_token_ms=(first["t"] - started) * 1000 if first else None,
        )

    def close(self) -> None:
        """Release the resources held by the engine."""
        self.model = None
        self.processor = None


__all__ = [
    "Engine",
    "Generation",
    "Prepared",
    "QwenEngine",
    "move_inputs",
    "validate_qwen_inputs",
]
