"""Analytic FLOPs and compute timings of the H3 stages (pure Python; torch only inside ``StepTimer``).

Analytic cost model v1 (theory only, from the checkpoint configs; the formulas are in this module),
applied to the sizes the stage really ran with:

* DiT, per evaluation over the N packed rows (alignment padding included):
  linear ``2·50·385,351,680·N`` (qkv + out + SwiGLU fc1 + fc2 of every block) and attention
  ``4·N²·7168·50``; the token refiner (prompt rows, once per run), embeddings, AdaLN and the LoRA
  term are not in the total (the LoRA term is reported separately); a ``ref_kv_cache`` skip step runs
  only the M = N - R non-reference rows through the blocks: linear ``2·50·385,351,680·M``, attention
  ``4·M·N·7168·50`` (M queries over every key, the R reference keys come from the cache);
* Qwen3-VL text encoder over S tokens (50 of 64 layers): linear ``2·50·487,587,840·S``,
  causal attention ``4·S²·8192·50/2``; the vision tower is not modelled;
* video VAE decode: 2.15 PFLOP at 124×768×1344 scaled per output pixel-frame
  (≈ 16.8 MFLOP per pixel-frame).

Stages hand these to ``StageRun.measure``; the provider reports them in the info diagnostic
``RUNTIME_COMPUTE`` (also for failed stages).

ETA work record (``COST_STAGES``): every stage also states the work it really did, in the units of the
ETA cost model (``StageRun.cost``); the provider reports it in the info diagnostic ``RUNTIME_COST`` and the
component host writes it to the recording's ``cost.stages`` (the controller fits time per unit from them).
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, cast

from phasyn_h3.recipe.adapter import constants
from phasyn_h3.recipe.adapter.loras import DIT_LORA_LAYER_DIMS


_MIN_TIMING_EVENTS = 2


COST_MODEL = "h3_cost_model_v1"  # recorded with every measurement; the formulas are in this module
# ETA work record: stage -> unit (one amount per stage and call; the units are the recorder's COST_UNITS)
COST_STAGES = MappingProxyType(
    {
        "encode": "flop",  # text encoder: text_encoder_flop over the S conditioning tokens
        "encode_keyframe": "pixel",  # fl2va keyframe canvases, width x height each
        "encode_image": "pixel",  # ref2va reference images, prepared canvas
        "encode_video": "pixel_frame",  # reference videos, frames x width x height
        "encode_audio": "second",  # reference audio and soundtracks
        "denoise": "flop",  # DiT: dit_flop(seq_len, evaluations); risk_measure = used rows
        "decode_video": "pixel_frame",  # output frames x width x height
        "decode_audio": "second",  # output PCM
    }
)
COST_MESSAGE_LIMIT = 2000  # diagnostic message size
DIT_ATTN_DIM = constants.DIT_HEADS * constants.DIT_HEAD_DIM
DIT_LINEAR_PARAMS_PER_BLOCK = (
    constants.DIT_HIDDEN * 3 * DIT_ATTN_DIM
    + DIT_ATTN_DIM * constants.DIT_HIDDEN
    + constants.DIT_HIDDEN * 2 * constants.DIT_FFN
    + constants.DIT_FFN * constants.DIT_HIDDEN
)
TE_Q = constants.TEXT_HEADS * constants.TEXT_HEAD_DIM
TE_KV = constants.TEXT_KV_HEADS * constants.TEXT_HEAD_DIM
TE_PARAMS_PER_LAYER = (
    constants.TEXT_HIDDEN * TE_Q
    + 2 * constants.TEXT_HIDDEN * TE_KV
    + TE_Q * constants.TEXT_HIDDEN
    + 3 * constants.TEXT_HIDDEN * constants.TEXT_FFN
)
VAE_DECODE_FLOP_PER_PIXEL_FRAME = 2.15e15 / (124 * 768 * 1344)


@dataclass(frozen=True)
class AnalyticFlop:
    """Record an estimated operation count with its calculation basis."""

    total: float
    detail: Mapping[str, Any] = field(default_factory=dict)


def dit_step_flop(tokens: int) -> dict[str, float]:
    """Estimate the operation count of one transformer step."""
    n = int(tokens)
    linear = 2.0 * constants.DIT_NUM_LAYERS * DIT_LINEAR_PARAMS_PER_BLOCK * n
    attention = 4.0 * n * n * DIT_ATTN_DIM * constants.DIT_NUM_LAYERS
    return {
        "linear_flop": linear,
        "attention_flop": attention,
        "total_flop": linear + attention,
    }


def dit_skip_step_flop(tokens: int, reduced_tokens: int) -> dict[str, float]:
    """One evaluation whose block stack runs ``reduced_tokens`` query rows over all ``tokens`` key rows (a ``ref_kv_cache`` skip step: the reference rows only contribute their cached K/V)."""
    n, m = int(tokens), int(reduced_tokens)
    linear = 2.0 * constants.DIT_NUM_LAYERS * DIT_LINEAR_PARAMS_PER_BLOCK * m
    attention = 4.0 * m * n * DIT_ATTN_DIM * constants.DIT_NUM_LAYERS
    return {
        "linear_flop": linear,
        "attention_flop": attention,
        "total_flop": linear + attention,
    }


def dynamic_lora_step_flop(tokens: int, rank: int) -> float:
    """``x·Aᵀ`` and ``(x·Aᵀ)·Bᵀ`` of the four block linears over N rows, 50 blocks (adaln_proj rows are the AdaLN plan width, negligible)."""
    n, r = int(tokens), int(rank)
    per_block = sum(
        2.0 * n * groups * r * fan_in + 2.0 * n * r * fan_out
        for fan_in, fan_out, groups in DIT_LORA_LAYER_DIMS.values()
    )
    return per_block * constants.DIT_NUM_LAYERS


def dit_flop(
    tokens: int,
    evaluations: int,
    *,
    lora_rank: int | None = None,
    ref_skip: tuple[int, int] | None = None,
    cached: dict[str, Any] | None = None,
) -> AnalyticFlop:
    """``ref_skip`` = (reduced tokens, skipped evaluations) of a ``ref_kv_cache`` run; the skipped evaluations are part of ``evaluations`` and cost :func:`dit_skip_step_flop` instead of a full step."""
    step = dit_step_flop(tokens)
    detail: dict[str, Any] = {
        "model": COST_MODEL,
        "component": "dit",
        "tokens": int(tokens),
        "evaluations": int(evaluations),
        "linear_flop_per_step": step["linear_flop"],
        "attention_flop_per_step": step["attention_flop"],
        "flop_per_step": step["total_flop"],
        "attention_share": step["attention_flop"] / step["total_flop"]
        if step["total_flop"]
        else None,
        "not_counted": ["token_refiner", "embeddings_and_adaln", "dynamic_lora"],
    }
    if lora_rank:
        detail["dynamic_lora_flop_per_step"] = dynamic_lora_step_flop(tokens, lora_rank)
    total = step["total_flop"] * int(evaluations)
    if ref_skip is not None:
        reduced, skipped = int(ref_skip[0]), min(int(ref_skip[1]), int(evaluations))
        skip = dit_skip_step_flop(tokens, reduced)
        total = (
            step["total_flop"] * (int(evaluations) - skipped)
            + skip["total_flop"] * skipped
        )
        detail["ref_kv_cache"] = {
            "reduced_tokens": reduced,
            "skipped_evaluations": skipped,
            "linear_flop_per_skipped_step": skip["linear_flop"],
            "attention_flop_per_skipped_step": skip["attention_flop"],
            "flop_per_skipped_step": skip["total_flop"],
            "skipped_step_ratio": skip["total_flop"] / step["total_flop"]
            if step["total_flop"]
            else None,
        }
    if cached is not None:
        # The existing model covers only the uniform transformer blocks' linear and attention FLOPs.
        per_hit = int(cached["first_compute_blocks"]) + int(
            cached["last_compute_blocks"]
        )
        blocks = int(cached["block_count"])
        executed = (
            int(cached["full_steps"]) * blocks + int(cached["reused_steps"]) * per_hit
        )
        total = step["total_flop"] * executed / blocks
        detail["cache_dit"] = {
            "block_count": blocks,
            "block_evaluations": executed,
            "block_evaluations_per_hit": per_hit,
        }
        detail["not_counted"].append("cache_dit_residual_comparison_and_reuse")
    return AnalyticFlop(total, detail)


def text_encoder_flop(tokens: int) -> AnalyticFlop:
    """Estimate the operation count for text encoding."""
    s = int(tokens)
    linear = 2.0 * constants.TEXT_SELECTED_LAYER * TE_PARAMS_PER_LAYER * s
    attention = 4.0 * s * s * TE_Q * constants.TEXT_SELECTED_LAYER / 2  # causal
    return AnalyticFlop(
        linear + attention,
        {
            "model": COST_MODEL,
            "component": "text_encoder",
            "tokens": s,
            "linear_flop": linear,
            "attention_flop": attention,
            "not_counted": ["vision_tower"],
        },
    )


def video_vae_decode_flop(frames: int, height: int, width: int) -> AnalyticFlop:
    """Estimate the operation count for video decoding."""
    pixel_frames = int(frames) * int(height) * int(width)
    return AnalyticFlop(
        VAE_DECODE_FLOP_PER_PIXEL_FRAME * pixel_frames,
        {
            "model": COST_MODEL,
            "component": "video_vae_decode",
            "frames": int(frames),
            "height": int(height),
            "width": int(width),
            "flop_per_pixel_frame": VAE_DECODE_FLOP_PER_PIXEL_FRAME,
        },
    )


class StepTimer:
    """Seconds between marks on the device timeline (CUDA events; ``perf_counter`` on the CPU).

    ``mark()`` enqueues an event behind the work issued so far, so marking from the loop's
    ``on_step`` hook times every update without synchronizing inside the loop; ``seconds()``
    waits for the last event once.
    """

    def __init__(self, device: Any) -> None:
        """Start measuring transformer step durations."""
        import torch

        self._torch = torch
        self._cuda = (
            getattr(device, "type", str(device)) == "cuda" and torch.cuda.is_available()
        )
        self._events: list[Any] = []
        self._times: list[float] = []

    def mark(self) -> None:
        """Record the completion of the timing interval."""
        if self._cuda:
            event = self._torch.cuda.Event(enable_timing=True)  # type: ignore[no-untyped-call]
            event.record()
            self._events.append(event)
        else:
            self._times.append(time.perf_counter())

    def seconds(self) -> list[float]:
        """Read the elapsed time in seconds."""
        if self._cuda:
            if len(self._events) < _MIN_TIMING_EVENTS:
                return []
            self._events[-1].synchronize()
            return [
                a.elapsed_time(b) / 1000.0
                for a, b in zip(self._events, self._events[1:], strict=False)
            ]
        return [b - a for a, b in zip(self._times, self._times[1:], strict=False)]


def _finite(value: Any) -> Any:
    """JSON-safe copy: non-finite floats become null (the actor protocol refuses NaN/Infinity)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(k): _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def runtime_measurements(kind: str, measured: Mapping[str, Any]) -> dict[str, Any]:
    """The stage's measurement fields (always all four keys; null = not measured for this stage)."""
    return cast(
        "dict[str, Any]",
        _finite(
            {
                "stage_kind": kind,
                "analytic_flop": measured.get("analytic_flop"),
                "analytic_flop_detail": measured.get("analytic_flop_detail"),
                "compute_seconds": measured.get("compute_seconds"),
                "per_step_seconds": measured.get("per_step_seconds"),
                **(
                    {"compute_detail": measured["detail"]}
                    if measured.get("detail")
                    else {}
                ),
            }
        ),
    )


def cost_message(kind: str, entries: Sequence[Mapping[str, Any]]) -> str | None:
    """``RUNTIME_COST`` message: the stage's ETA work entries as JSON (``None`` without entries).

    Whole entries are dropped from the end when the JSON would not fit the diagnostic (counted in
    ``dropped``); the JSON itself is never cut.
    """
    if not entries:
        return None
    doc: dict[str, Any] = {
        "stage_kind": kind,
        "cost_model": COST_MODEL,
        "stages": [_finite(dict(e)) for e in entries],
    }
    text = json.dumps(doc, sort_keys=True, allow_nan=False, separators=(",", ":"))
    while len(text) > COST_MESSAGE_LIMIT and doc["stages"]:
        doc["stages"].pop()
        doc["dropped"] = int(doc.get("dropped", 0)) + 1
        text = json.dumps(doc, sort_keys=True, allow_nan=False, separators=(",", ":"))
    return text


__all__ = [
    "COST_MESSAGE_LIMIT",
    "COST_MODEL",
    "COST_STAGES",
    "DIT_LINEAR_PARAMS_PER_BLOCK",
    "TE_PARAMS_PER_LAYER",
    "VAE_DECODE_FLOP_PER_PIXEL_FRAME",
    "AnalyticFlop",
    "StepTimer",
    "cost_message",
    "dit_flop",
    "dit_skip_step_flop",
    "dit_step_flop",
    "dynamic_lora_step_flop",
    "runtime_measurements",
    "text_encoder_flop",
    "video_vae_decode_flop",
]
