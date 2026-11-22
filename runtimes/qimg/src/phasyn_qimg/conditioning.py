# SPDX-License-Identifier: Apache-2.0
# Portions adapted from diffusers 578c9b2 (src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py,
# QwenImage21Pipeline._get_qwen_prompt_embeds and encode_prompt), Copyright 2026 Qwen-Image Team,
# The HuggingFace Team; modified by the Phasyn Studio authors (split into standalone functions that do not
# depend on diffusers, with reference-grid and token-limit checks).
"""``qimg.conditioning``: Qwen3-VL text (+ reference image) conditioning → ``qimg.conditioning.v1`` bundle.

The numeric path follows ``QwenImage21Pipeline._get_qwen_prompt_embeds``/``encode_prompt`` line by line but
does not depend on diffusers (a text-encoder-only runtime may lack it):

* the raw string template (not apply_chat_template; the two tokenize differently and the checkpoint uses
  this one); with references, ``<image1>…<imageN>`` each get ``<|vision_start|><|image_pad|><|vision_end|>``;
  an empty prompt is encoded as a single space;
* left padding in the processor; ``_drop_idx`` = token count of the system message (computed from the
  processor's chat template);
* a forward hook on ``language_model.norm`` returns its input: ``hidden_states[-1]`` must be the last decoder
  layer's output before the final RMSNorm (transformers 5.x returns the value after the norm);
* ``image_pad_mask`` = positions of ``<|image_pad|>`` among valid tokens (system part removed); at batch 1 the
  attention mask is all true, so no ``prompt_mask`` is emitted (the pipeline returns None as well).

Token pre-check: a full processor sequence (image pads included) longer than the text encoder's
max_position_embeddings is a 422 ``PROMPT_TOO_LONG`` (never truncated). The processor grid of each reference
must equal its prepared size (the VAE latent grid), otherwise 422 — the pipeline would only fail later
inside the DiT; this fails early and explains why.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
from collections.abc import Mapping
from importlib import import_module
from pathlib import Path
from typing import Any, ClassVar, cast, override

from phasyn_components import upstream
from phasyn_components.canonical import sha256_hex
from phasyn_components.errors import ComponentError
from phasyn_components.model_identity import model_identity
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Part,
    Port,
    RunContext,
    UnloadContext,
)
from phasyn_components.weights import WeightPlan

from . import (
    KIND_CONDITIONING,
    KIND_PREPARED,
    TYPE_CONDITIONING,
    TYPE_PREPARED,
    TYPE_PROMPT,
    VAE_SCALE_FACTOR,
    encoding_cache,
)
from .bundle import input_identity, read_bundle, write_bundle
from .config import (
    QIMG_LIBRARIES,
    RESEARCH_USE_NOTE,
    build_settings_schema,
    check_load,
    default_settings,
    model_dir,
    model_problem,
    model_root,
    parameters_schema,
    resolve_params,
    runtime_problem,
)
from .instrument import (
    CallMemory,
    HostResidency,
    allocator_window,
    check_vram,
    drop_frame_locals,
    dtype_census,
    finish_allocator,
    module_bytes,
    record_after_release,
    release_cuda_cache,
    timed_stage,
)
from .weights import image_plan


_RGB_CHANNELS = 3
_HWC_DIMENSIONS = 3

SYSTEM_PROMPT = "Comprehend and analyze the provided prompt."
TEMPLATE_T2I = f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n{{}}<|im_end|>\n<|im_start|>assistant\n"
IMAGE_SLOT_1 = "<image1><|vision_start|><|image_pad|><|vision_end|>"
TEMPLATE_TI2I = (
    f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n"
    f"<|im_start|>user\n{IMAGE_SLOT_1}{{}}<|im_end|>\n<|im_start|>assistant\n"
)
SUPPORTED_ARCHS = ("Qwen3VLForConditionalGeneration",)
TE_PART = "text_encoder.language_model"


def prompt_text(prompt: str, n_images: int) -> str:
    """pipeline:241-259：空 prompt → 單一空白；有參考圖時依張數展開影像佔位."""
    text = prompt or " "
    if n_images == 0:
        return TEMPLATE_T2I.format(text)
    replace = IMAGE_SLOT_1
    for i in range(2, n_images + 1):
        replace += f" <image{i}><|vision_start|><|image_pad|><|vision_end|>"
    return TEMPLATE_TI2I.replace(IMAGE_SLOT_1, replace).format(text)


def drop_index(processor: Any) -> int:
    """pipeline:223-225：系統訊息 token 數（由 processor 的 chat template 算，不寫死）."""
    sys_message = [
        {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]}
    ]
    sys_tokens = processor.apply_chat_template(
        sys_message, tokenize=True, return_dict=False
    )
    return len(sys_tokens[0])


def image_token_id(processor: Any) -> int:
    """Return the configured image token identifier."""
    return int(processor.tokenizer.encode("<|image_pad|>")[0])


def tokenize(processor: Any, prompt: str, images: list[Any] | None) -> Any:
    """pipeline:274-285：左側 padding、return_tensors=pt；影像（白底 RGB PIL）依佔位順序傳入."""
    kwargs: dict[str, Any] = {
        "text": [prompt_text(prompt, len(images or []))],
        "padding": True,
        "padding_side": "left",
        "return_tensors": "pt",
    }
    if images:
        kwargs["images"] = list(images)
    return processor(**kwargs)


def encode_tokens(  # noqa: PLR0913 - Keep the published runtime API.
    text_encoder: Any,
    model_inputs: Any,
    *,
    device: Any,
    drop_idx: int,
    img_token_id: int,
    with_images: bool,
) -> tuple[Any, Any, Any]:
    """pipeline:285-331+encode_prompt（num_images_per_prompt=1）→ (prompt_embeds, prompt_mask|None, image_pad_mask)."""
    import torch

    model_inputs = model_inputs.to(device)
    forward_kwargs = {
        "input_ids": model_inputs.input_ids,
        "attention_mask": model_inputs.attention_mask,
        "output_hidden_states": True,
    }
    if with_images and hasattr(model_inputs, "pixel_values"):
        forward_kwargs.update(
            pixel_values=model_inputs.pixel_values,
            image_grid_thw=model_inputs.image_grid_thw,
        )
    if hasattr(model_inputs, "mm_token_type_ids"):
        forward_kwargs["mm_token_type_ids"] = model_inputs.mm_token_type_ids
    # hidden_states[-1] 必須是最後一層 decoder 的輸出（final RMSNorm 之前）：hook 回傳 norm 的輸入
    text_model = getattr(text_encoder.model, "language_model", text_encoder.model)
    handle = text_model.norm.register_forward_hook(
        lambda _module, args, _output: args[0]
    )
    try:
        outputs = text_encoder(**forward_kwargs)
    finally:
        handle.remove()
    hidden_states = outputs.hidden_states[-1]

    bool_mask = model_inputs.attention_mask.bool()
    valid_lengths = bool_mask.sum(dim=1)
    selected = hidden_states[bool_mask]
    split_hidden_states = [
        e[drop_idx:] for e in torch.split(selected, valid_lengths.tolist(), dim=0)
    ]
    image_pad_mask_list = [
        (sample_ids[sample_mask.bool()] == img_token_id)[drop_idx:]
        for sample_ids, sample_mask in zip(
            model_inputs.input_ids, model_inputs.attention_mask, strict=True
        )
    ]
    attn_mask_list = [
        torch.ones(e.size(0), dtype=torch.long, device=e.device)
        for e in split_hidden_states
    ]
    max_seq_len = max(e.size(0) for e in split_hidden_states)
    prompt_embeds = torch.stack(
        [
            torch.cat([u, u.new_zeros(max_seq_len - u.size(0), u.size(1))])
            for u in split_hidden_states
        ]
    )
    encoder_attention_mask = torch.stack(
        [torch.cat([u, u.new_zeros(max_seq_len - u.size(0))]) for u in attn_mask_list]
    )
    image_pad_mask = torch.stack(
        [
            torch.cat([u, u.new_zeros(max_seq_len - u.size(0))])
            for u in image_pad_mask_list
        ]
    )
    # encode_prompt：沒有 padding 時 mask 不帶資訊 → None（pipeline:384-385）
    mask: Any = encoder_attention_mask
    if mask.all():
        mask = None
    return prompt_embeds, mask, image_pad_mask


def check_reference_grid(
    model_inputs: Any, prepared_sizes: list[tuple[int, int]], processor: Any
) -> list[int]:
    """Processor 實際的影像網格必須等於 prepared 尺寸（VAE latent 網格）；回傳每張的 image pad 數."""
    grid = model_inputs.get("image_grid_thw")
    if grid is None:
        raise ComponentError("RUNTIME_ERROR", "processor 沒有回傳 image_grid_thw")
    rows = [tuple(int(x) for x in row) for row in grid.tolist()]
    merge = int(getattr(processor.image_processor, "merge_size", 2))
    counts = []
    for index, ((t, gh, gw), (width, height)) in enumerate(
        zip(rows, prepared_sizes, strict=True)
    ):
        expected = (1, height // VAE_SCALE_FACTOR, width // VAE_SCALE_FACTOR)
        if (t, gh, gw) != expected:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"參考圖 {index + 1} 前處理後為 {width}×{height}，但 Qwen3-VL processor 會改成 "
                f"{gw * VAE_SCALE_FACTOR}×{gh * VAE_SCALE_FACTOR}（例如低於 processor 的最小像素數）；影像 token 與 VAE "
                "參考 latent 會對不上。請調高 reference_resolution 或換長寬比較不極端的圖",
                details={
                    "reason": "REFERENCE_SIZE_INCOMPATIBLE",
                    "reference": index,
                    "prepared_size": [width, height],
                    "processor_grid_thw": [t, gh, gw],
                },
            )
        counts.append(t * gh * gw // (merge * merge))
    return counts


def _prompt_value(value: Any, port: str) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return str(value["text"])
    if value is None:
        return ""
    raise ComponentError("INVALID_ARGUMENT", f"{port} 必須是字串或 {{text: 字串}}")


class ConditioningProvider(BaseProvider):
    """Encode Qwen image and text conditioning for the denoiser."""

    _cache: encoding_cache.EncoderCache | None = None
    provider_id = "qimg.conditioning"
    role: ClassVar[str] = "conditioning"
    # allocator reading at the start of the current call's GPU work (None: no GPU work yet in this call)
    _call_memory: CallMemory | None = None

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """The pinned Qwen-Image 2.1 directory this provider reads."""
        return image_plan(cls.role, settings)

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe the ports, settings and current runtime availability."""
        reason = runtime_problem(cls.role)
        code = "PROVIDER_NOT_INSTALLED" if reason else None
        if reason is None and settings is not None:
            reason = model_problem(cls.role, settings)
            code = "COMPONENT_NOT_CONFIGURED" if reason else None
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="image.conditioning",
            label="Qwen-Image 2.1 文字／參考圖條件（Qwen3-VL hidden states；pipeline 原始模板與 final-norm hook）",
            inputs=[
                Port(
                    "prompt",
                    TYPE_PROMPT,
                    required=True,
                    transport="inline",
                    description="生成 prompt（verbatim；不截斷）",
                ),
                Port(
                    "negative_prompt",
                    TYPE_PROMPT,
                    required=False,
                    transport="inline",
                    description="negative prompt：只有 cfg=true 時編碼（空白\N{FULLWIDTH EQUALS SIGN}單一空白字元）；cfg=false 時不使用並記錄",
                ),
                Port(
                    "prepared",
                    TYPE_PREPARED,
                    required=False,
                    transport="file",
                    description="qimg.prepare 的輸出（圖生圖：白底參考圖進 Qwen3-VL 的影像佔位）；文生圖不接",
                ),
            ],
            outputs=[
                Port(
                    "conditioning",
                    TYPE_CONDITIONING,
                    required=True,
                    transport="file",
                    description="qimg bundle：prompt_embeds BF16 (1,L,hidden)、image_pad_mask、cfg 時另有 neg_*",
                )
            ],
            parts=[
                Part("tokenizer", "preprocess", empty, ["host_ms"], "full", None),
                Part(
                    TE_PART,
                    "language_model",
                    empty,
                    ["host_ms", "gpu_event_ms"],
                    "partial",
                    "以整次 forward 量測（視覺塔與語言模型合計）；不逐層計時",
                ),
            ],
            settings_schema=build_settings_schema(cls.role),
            parameters_schema=parameters_schema(cls.role),
            default_settings=default_settings(cls.role),
            available=reason is None
            or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
            unavailable_code=code,
            unavailable_reason=reason,
            notes=[RESEARCH_USE_NOTE],
        )

    # ------------------------------------------------------------------ lifecycle
    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the encoder and verify the optional cache namespace."""
        self._cache, result = encoding_cache.configure(
            self.host, self.role, ctx, self._load
        )
        return result

    def _load(self, ctx: LoadContext) -> LoadResult:
        import torch
        from phasyn_components.recorder.gpu import runtime_identity, torch_backend_flags
        from transformers import Qwen3VLForConditionalGeneration, Qwen3VLProcessor

        load = ctx.load
        offload = check_load(self.role, load)
        problem = model_problem(self.role, ctx.settings)
        if problem:
            raise ComponentError("COMPONENT_NOT_CONFIGURED", problem)
        if (
            offload.get("mode") == "sequential"
            and importlib.util.find_spec("accelerate") is None
        ):
            raise ComponentError(
                "PROVIDER_NOT_INSTALLED",
                "offload.mode=sequential 需要 accelerate（此 runtime 沒有安裝）",
                status=422,
            )
        base = model_dir(load)

        _check_encoder_config(base)
        device_cfg = load.get("device") or {}
        self.cuda = device_cfg.get("kind") == "cuda"
        self.device = torch.device("cuda", 0) if self.cuda else torch.device("cpu")
        self.offload = offload
        window = allocator_window(self.cuda)
        with ctx.recorder.phase("load", part=TE_PART):
            self.processor = Qwen3VLProcessor.from_pretrained(
                str(base / "processor"), local_files_only=True, trust_remote_code=False
            )
            self.text_encoder = cast(
                Any,
                Qwen3VLForConditionalGeneration.from_pretrained(
                    str(base / "text_encoder"),
                    local_files_only=True,
                    dtype=torch.bfloat16,
                    use_safetensors=True,
                    trust_remote_code=False,
                ),
            )
            self.text_encoder.eval()
            self.weight_bytes = module_bytes(self.text_encoder)
            self.residency: HostResidency | None = None
            placement: dict[str, Any] = {
                "mode": offload.get("mode"),
                "after_use": offload.get("after_use"),
            }
            if self.cuda and offload.get("mode") == "sequential":
                cpu_offload = import_module("accelerate").cpu_offload

                module = self.text_encoder
                cpu_offload(
                    module, self.device, offload_buffers=len(module._parameters) > 0
                )
                placement["placement"] = (
                    "accelerate.cpu_offload（權重留在 host，逐子模組上 GPU）"
                )
            elif self.cuda and offload.get("after_use") == "keep":
                placement.update(
                    check_vram(
                        self.device,
                        self.weight_bytes,
                        what="TE 常駐",
                        hint="請改用 offload.mode=sequential 或其他裝置",
                    )
                )
                self.text_encoder.to(self.device)
                placement["placement"] = "resident"
            elif self.cuda:
                self.residency = HostResidency(
                    self.text_encoder,
                    device=self.device,
                    pinned=bool(offload["pinned"]),
                )
                placement["placement"] = "host（每次呼叫整個搬上 GPU）"
            else:
                placement["placement"] = "cpu"
        finish_allocator(ctx.recorder, window, scope="load", cuda=self.cuda)
        text_config = self._record_encoder_dimensions()
        self.identity = model_identity(
            model_root(load),
            {"text_encoder": base / "text_encoder", "processor": base / "processor"},
        )
        self.libraries = upstream.library_versions(QIMG_LIBRARIES, vcs=())
        self.calls = 0
        observed = {
            "parameter_dtypes": dtype_census(self.text_encoder),
            "weight_bytes": self.weight_bytes,
            "placement": placement,
            "drop_idx": self.drop_idx,
            "image_token_id": self.img_token_id,
            "token_limit": self.token_limit,
            "hidden_size": self.hidden_size,
            "attn_implementation": getattr(text_config, "_attn_implementation", None),
            "libraries": self.libraries,
            "diffusers_source": upstream.vcs_source("diffusers"),
            "accumulation_dtype": None,
            "accumulation_dtype_reason": "kernel 累加精度無法觀測",
        }
        if self.cuda:
            observed["backend_flags"] = torch_backend_flags()
        return LoadResult(
            effective_load={**load, "offload": offload},
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=self.identity,
            # CPU 元件不初始化 CUDA（runtime_identity 會讀裝置屬性 → 建立 CUDA context）
            runtime_identity=runtime_identity()
            if self.cuda
            else {"torch": torch.__version__, "device": "cpu"},
        )

    def _record_encoder_dimensions(self) -> Any:
        self.drop_idx = drop_index(self.processor)
        self.img_token_id = image_token_id(self.processor)
        text_config = getattr(
            self.text_encoder.config, "text_config", self.text_encoder.config
        )
        self.token_limit = int(text_config.max_position_embeddings)
        self.hidden_size = int(text_config.hidden_size)
        return text_config

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the loaded component state."""
        with contextlib.suppress(Exception):
            import torch

            self.residency = None
            del self.text_encoder
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def after_failure(self, code: str) -> dict[str, Any] | None:
        """Runs after the host has cleared the failed call's frames: drop what the TE itself still holds, move the weights back to the host and report whether the process is back at its allocation before the call."""
        self._discard_call_state()
        residency = getattr(self, "residency", None)
        if residency is not None and residency.on_device:
            with contextlib.suppress(Exception):
                residency.restore()
        memory, self._call_memory = self._call_memory, None
        if memory is not None:
            return memory.settle(code)
        with contextlib.suppress(Exception):
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        return None

    def _discard_call_state(self) -> None:
        """Undo the weight moves of accelerate's sequential offload that a failed forward left behind.

        Each offloaded submodule gets its weights (and tied weights, through the hook's tied-parameter map) in
        ``pre_forward`` and drops them in ``post_forward``; a failure in between keeps them on the GPU until that
        submodule runs again. Running ``post_forward`` on every hook is what a finished forward does anyway.
        """
        if (getattr(self, "offload", None) or {}).get("mode") != "sequential":
            return
        encoder = getattr(self, "text_encoder", None)
        if encoder is None:
            return
        for module in encoder.modules():
            hook = getattr(module, "_hf_hook", None)
            if hook is not None:
                with contextlib.suppress(Exception):
                    hook.post_forward(module, None)

    # ------------------------------------------------------------------ invoke
    def invoke(self, ctx: RunContext) -> None:
        """Run this provider with the validated call context."""
        self._call_memory = None
        encoding_cache.invoke(self._cache, ctx, self._encode)

    def _encode(self, ctx: RunContext) -> None:
        rec = ctx.recorder
        params = resolve_params(self.role, ctx.parameters)
        cfg = bool(params["cfg"])
        prompt = _prompt_value(ctx.input("prompt").value, "prompt")
        neg_item = ctx.optional_input("negative_prompt")
        negative = (
            _prompt_value(neg_item.value, "negative_prompt")
            if neg_item is not None
            else None
        )
        rec.set_metric(
            "qimg.warm_call",
            1 if self.calls else 0,
            unit="bool",
            scope="process",
            method="runtime_hook",
        )
        self.calls += 1
        prepared_meta, images, sizes = _conditioning_images(ctx)
        if not cfg and negative:
            rec.note(
                "cfg=false：negative_prompt 沒有編碼（guidance ≤ 1 不使用 negative；與 pipeline 相同）"
            )
        with rec.span("qimg.te.tokenize", part="tokenizer"):
            pos_inputs = tokenize(self.processor, prompt, images or None)
            neg_inputs = (
                tokenize(self.processor, negative or "", images or None)
                if cfg
                else None
            )
        image_counts = (
            check_reference_grid(pos_inputs, sizes, self.processor) if images else []
        )
        lengths = self._check_token_lengths(pos_inputs, neg_inputs)
        rec.set_metric(
            "input_tokens",
            lengths["prompt"],
            unit="count",
            scope="component_call",
            method="runtime_hook",
        )
        ctx.check_cancelled()
        window = allocator_window(self.cuda)
        self._call_memory = CallMemory.start(self.device, window)
        try:
            if self.residency is not None:
                self.residency.to_device(rec, part=TE_PART, what="TE 搬上 GPU")
            out = self._encode_prompt_branches(
                ctx, pos_inputs, neg_inputs, with_images=bool(images)
            )
        except BaseException as exc:
            # the failed forward's frames hold hidden states and sequential offload may have left weights on the
            # GPU: drop both so the release below is effective
            drop_frame_locals(exc)
            self._discard_call_state()
            raise
        finally:
            if self.residency is not None:
                self.residency.release(rec, part=TE_PART)
            finish_allocator(rec, window, scope="invoke", cuda=self.cuda)
            if self.cuda and self.offload.get("after_use") == "host":
                # weights stay on the host (sequential or after_use=host), so no VRAM is held between calls.
                # encode_tokens moved the processor inputs to the GPU in place (BatchFeature.to()) and the embeds
                # still have device copies: drop the references first, then return idle blocks to the driver
                # (otherwise the TE process keeps GiBs reserved after each call)
                pos_inputs = neg_inputs = None
                release_cuda_cache(self.device)
                record_after_release(rec, self.device)
        ctx.check_cancelled()
        text_len = _record_encoded_length(out, image_counts, rec)
        meta: dict[str, Any] = {
            "prompt_sha256": sha256_hex(prompt.encode("utf-8")),
            "negative_sha256": sha256_hex((negative or "").encode("utf-8"))
            if cfg
            else None,
            "negative_ignored": bool(negative) and not cfg,
            "cfg": cfg,
            "text_len": text_len,
            "neg_text_len": int(out["neg_prompt_embeds"].shape[1]) if cfg else None,
            "input_tokens": lengths,
            "token_limit": self.token_limit,
            "image_token_counts": image_counts,
            "img_shapes": [
                [1, h // VAE_SCALE_FACTOR, w // VAE_SCALE_FACTOR] for (w, h) in sizes
            ],
            "hidden_size": self.hidden_size,
            "dtype": "BF16",
            "template": "ti2i" if images else "t2i",
            "drop_idx": self.drop_idx,
            "image_token_id": self.img_token_id,
            "final_norm": "bypassed（hidden_states[-1]\N{FULLWIDTH EQUALS SIGN}最後一層 decoder 輸出，pipeline:297-309）",
            "prepared": input_identity(ctx, "prepared"),
            "target": (
                {
                    "width": int(prepared_meta["width"]),
                    "height": int(prepared_meta["height"]),
                }
                if prepared_meta
                else None
            ),
            "te_identity": self.identity,
            "lib_versions": self.libraries,
        }
        with rec.span("qimg.te.write", part="tokenizer"):
            write_bundle(
                ctx, "conditioning", kind=KIND_CONDITIONING, meta=meta, tensors=out
            )
        rec.log(
            "info",
            "Qwen3-VL 條件編碼完成",
            text_len=text_len,
            cfg=cfg,
            images=len(images),
            image_token_counts=image_counts,
            input_tokens=lengths,
        )

    def _encode_prompt_branches(
        self, ctx: RunContext, pos_inputs: Any, neg_inputs: Any, *, with_images: bool
    ) -> dict[str, Any]:
        import torch

        rec = ctx.recorder
        with torch.inference_mode():
            with timed_stage(rec, "qimg.te.forward", part=TE_PART, cuda=self.cuda):
                embeds, mask, pad_mask = encode_tokens(
                    self.text_encoder,
                    pos_inputs,
                    device=self.device,
                    drop_idx=self.drop_idx,
                    img_token_id=self.img_token_id,
                    with_images=with_images,
                )
                out: dict[str, Any] = {
                    "prompt_embeds": embeds.to("cpu"),
                    "image_pad_mask": pad_mask.to("cpu"),
                }
                if mask is not None:
                    out["prompt_mask"] = mask.to("cpu").bool()
            ctx.check_cancelled()
            if neg_inputs is not None:
                with timed_stage(
                    rec, "qimg.te.forward_negative", part=TE_PART, cuda=self.cuda
                ):
                    n_embeds, n_mask, n_pad = encode_tokens(
                        self.text_encoder,
                        neg_inputs,
                        device=self.device,
                        drop_idx=self.drop_idx,
                        img_token_id=self.img_token_id,
                        with_images=with_images,
                    )
                    out["neg_prompt_embeds"] = n_embeds.to("cpu")
                    out["neg_image_pad_mask"] = n_pad.to("cpu")
                    if n_mask is not None:
                        out["neg_prompt_mask"] = n_mask.to("cpu").bool()
        return out

    def _check_token_lengths(self, pos_inputs: Any, neg_inputs: Any) -> dict[str, int]:
        lengths = {"prompt": int(pos_inputs["input_ids"].shape[-1])}
        if neg_inputs is not None:
            lengths["negative_prompt"] = int(neg_inputs["input_ids"].shape[-1])
        for which, tokens in lengths.items():
            if tokens > self.token_limit:
                raise ComponentError(
                    "PROMPT_TOO_LONG",
                    f"{which} 加上模板與影像 token 共 {tokens} tokens，超過 text encoder 上限 {self.token_limit}（不截斷）",
                    details={
                        "which": which,
                        "tokens": tokens,
                        "limit": self.token_limit,
                    },
                    status=422,
                )
        return lengths


def _record_encoded_length(
    out: Mapping[str, Any], image_counts: list[int], rec: Any
) -> int:
    pad_total = int(out["image_pad_mask"].sum().item())
    if pad_total != sum(image_counts):
        raise ComponentError(
            "RUNTIME_ERROR",
            f"image_pad_mask 有 {pad_total} 個影像 token，processor 網格合計 {sum(image_counts)}",
        )
    text_len = int(out["prompt_embeds"].shape[1])
    rec.set_metric(
        "qimg.text_len",
        text_len,
        unit="count",
        scope="component_call",
        method="runtime_hook",
    )
    return text_len


def _conditioning_images(
    ctx: RunContext,
) -> tuple[dict[str, Any] | None, list[Any], list[tuple[int, int]]]:
    from PIL import Image

    rec = ctx.recorder
    prepared_meta: dict[str, Any] | None = None
    images: list[Any] = []
    sizes: list[tuple[int, int]] = []
    if (
        ctx.optional_input("prepared") is not None
        and ctx.input("prepared").file is not None
    ):
        with rec.span("qimg.te.read_prepared", part="tokenizer"):
            prepared_meta, tensors = read_bundle(ctx, "prepared", kind=KIND_PREPARED)
            for ref in prepared_meta.get("refs") or []:
                array = tensors[f"ref_rgb_{int(ref['index'])}"].numpy()
                if array.ndim != _HWC_DIMENSIONS or array.shape[2] != _RGB_CHANNELS:
                    raise ComponentError(
                        "LATENT_MISMATCH",
                        f"prepared 的 ref_rgb_{ref['index']} 不是 HWC RGB",
                    )
                images.append(Image.fromarray(array))
                sizes.append(
                    (int(ref["prepared_size"][0]), int(ref["prepared_size"][1]))
                )
    return prepared_meta, images, sizes


def _check_encoder_config(base: Path) -> None:
    archs = (
        json.loads(
            (base / "text_encoder" / "config.json").read_text(encoding="utf-8")
        ).get("architectures")
        or []
    )
    if not any(a in SUPPORTED_ARCHS for a in archs):
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"text_encoder 架構 {archs} 不是 {', '.join(SUPPORTED_ARCHS)}",
        )


__all__ = [
    "ConditioningProvider",
    "check_reference_grid",
    "drop_index",
    "encode_tokens",
    "image_token_id",
    "prompt_text",
    "tokenize",
]
