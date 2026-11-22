"""Torch-free description of ``qimg.dit``: availability, parts, ports and settings schema for describe()."""

from __future__ import annotations

import importlib.util
import json
from collections.abc import Mapping
from importlib.resources import files
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.provider import Description, Part, Port

from ..config import RESEARCH_USE_NOTE, diffusers_problem
from .options import (
    CONDITIONING_TYPE,
    KIND,
    LATENT_TYPE,
    PROVIDER_ID,
    REF_LATENTS_TYPE,
    DitOptions,
    build_settings_schema,
    configuration_problem,
    default_settings,
    num_layers,
    parameters_schema,
    parse_options,
)
from .preview import PACKAGED_COEFFICIENTS


LABEL = (
    "Qwen-Image 2.1 DiT（文生圖／圖生圖去噪；完整迴圈在單次呼叫內，輸出正規化 latent）"
)
REQUIRED_MODULES = ("torch", "diffusers", "safetensors", "numpy")


def missing_modules(opts: DitOptions | None) -> list[str]:
    """List unavailable modules without importing the model."""
    needed = list(REQUIRED_MODULES)
    if opts is not None and opts.variant == "gguf_q4km":
        needed.append("gguf")
    if opts is not None and opts.adapters:
        needed.append("peft")
    if opts is not None and opts.placement == "group_stream":
        needed.append("accelerate")
    return [m for m in needed if importlib.util.find_spec(m) is None]


def dit_parts(layers: int) -> list[Part]:
    """List the independently configurable denoiser parts."""
    empty = {"type": "object", "properties": {}}
    observe = ["forward_count", "host_ms", "gpu_event_ms"]
    parts = [
        Part(
            f"transformer.transformer_blocks.{i}",
            "dit_block",
            empty,
            observe,
            "partial",
            "CUDA event 區間（含等待與 group_stream 搬運），不是 kernel active time；CPU 時只有 host 時間",
        )
        for i in range(layers)
    ]
    for name, kind in (
        ("transformer.txt_in", "text_projection"),
        ("transformer.img_in", "latent_projection"),
        ("transformer.time_text_embed", "timestep_embedding"),
        ("transformer.modulation", "modulation"),
        ("transformer.norm_out", "output_norm"),
        ("transformer.proj_out", "output_head"),
    ):
        parts.append(
            Part(name, kind, empty, [], "none", "未單獨計時；時間計入整次 forward")
        )
    parts.append(
        Part(
            "transformer",
            "placement",
            empty,
            ["weight_h2d_bytes", "host_ms"],
            "partial",
            "phase 搬移與 group_stream onload",
        )
    )
    parts.append(Part("scheduler", "scheduler", empty, ["sigma"], "full", None))
    parts.append(
        Part(
            "preview", "preview", empty, ["host_ms"], "partial", "背景執行緒；只記彙總"
        )
    )
    return parts


def describe_dit(settings: Mapping[str, Any] | None) -> Description:
    """describe() of ``qimg.dit``: never imports torch/diffusers; availability from package metadata and files."""
    reason: str | None = None
    code: str | None = None
    opts: DitOptions | None = None
    notes = [
        RESEARCH_USE_NOTE,
        "variant bf16／gguf_q4km 是兩個不同元件；placement 為明確設定（不自動選擇）",
        "guidance ≤ 1 不使用 CFG；> 1 時 conditioning 必須以 cfg=true 編碼負向（每步 forward 加倍）",
    ]
    if settings is not None:
        try:
            opts = parse_options(dict(settings.get("load") or {}))
        except ComponentError as exc:
            reason, code = exc.message, exc.code
    missing = missing_modules(opts)
    mismatch = None if missing else diffusers_problem()
    if missing:
        reason, code = (
            f"此 runtime 沒有安裝 {', '.join(missing)}（qimg.dit 需要 qimg GPU runtime 環境）",
            "PROVIDER_NOT_INSTALLED",
        )
    elif mismatch is not None:
        reason, code = mismatch, "PROVIDER_NOT_INSTALLED"
    elif opts is not None and reason is None:
        problem = configuration_problem(opts)
        if problem is not None:
            code, reason = problem
    coefficient_path = (
        opts.coefficients_path(PACKAGED_COEFFICIENTS) if opts else PACKAGED_COEFFICIENTS
    )
    if not coefficient_path.is_file():
        notes.append(
            "preview.mode=linear_fit 尚不可用：還沒有以我們自己的輸出擬合的係數檔"
        )
    return Description(
        provider_id=PROVIDER_ID,
        kind=KIND,
        label=LABEL,
        inputs=[
            Port(
                "conditioning",
                CONDITIONING_TYPE,
                required=True,
                transport="file",
                description="qimg.conditioning 的 bundle（正向；CFG 時含負向）",
            ),
            Port(
                "ref_latents",
                REF_LATENTS_TYPE,
                required=False,
                transport="file",
                description="圖生圖：qimg.vae_encode 的參考圖 latent（順序與 conditioning 的影像槽一致）",
            ),
        ],
        outputs=[
            Port(
                "latent",
                LATENT_TYPE,
                required=True,
                transport="file",
                description="最後一次 Euler 更新後的打包 latent（BF16，正規化空間）",
            )
        ],
        parts=dit_parts(num_layers(opts)),
        settings_schema=build_settings_schema(),
        parameters_schema=parameters_schema(),
        default_settings=default_settings(),
        available=reason is None
        or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
        unavailable_code=code,
        unavailable_reason=reason,
        notes=notes,
        facts=json.loads(
            files("phasyn_qimg.dit")
            .joinpath("lora_compatibility.json")
            .read_text(encoding="utf-8")
        ),
    )


__all__ = ["LABEL", "describe_dit", "dit_parts", "missing_modules"]
