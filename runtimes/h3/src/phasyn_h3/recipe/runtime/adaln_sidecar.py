# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/models/dits/minimax_h3.py (MiniMaxH3TimeEmbedder.forward, in time_embedding) and tools/build_minimax_h3_adaln_cache.py (sidecar file format)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: sidecars can be built with an AdaLN-touching LoRA applied.
"""Build an AdaLN sidecar for the stage-split DiT, optionally signed with an AdaLN-touching LoRA.

A fixed AdaLN cache (``--minimax-h3-adaln-cache-path``) stores, for every step's fp32 timestep
plan, ``adaln_proj(silu(time_embed(t)))`` of the 50 blocks and the final layer
(``SGR:runtime/models/dits/minimax_h3_adaln_cache.py:383-553``).  Upstream's offline builder
(``SGR:tools/build_minimax_h3_adaln_cache.py``) only knows base weights, and every cache mode
refuses LoRA deltas on ``adaln_proj`` (``minimax_h3.py:1880-1895``).
lets a PDD run keep AdaLN precomputation when the sidecar is built *with* the LoRA:
this tool evaluates each block's projection through the very layers the resident path runs —
``ColumnParallelLinear`` wrapped in the shim's in-place ``ColumnParallelLinearWithLoRA`` subclass
(``lora_inplace``: dynamic, BF16, term accumulated with ``addmm_``) — with each plan's own timestep
count as the GEMM batch (cuBLAS picks kernels by shape, ``:563-568``), so a sidecar built on the
serving GPU model reproduces "AdaLN off + dynamic AdaLN LoRA" bit for bit.  Metadata
``lora_accumulate`` records that arithmetic (sidecars built before it used upstream's out-of-place
term and differ from the runtime by BF16 rounding of the AdaLN LoRA term; ``prepare_adaln`` warns).

Plans come from the same functions the plan and ``prepare_adaln`` use (adapter
``build_schedule`` → shim ``step_unique_timesteps``), or from a plan's sigma artifact.  The file
is SGLang's format (``format_version`` 2, ``model_variant``) plus metadata ``lora_signature``
(``phasyn_h3.recipe.adapter.loras.adaln_lora_signature``; ``prepare_adaln`` refuses a mismatch),
``base_checkpoint_digest``, ``sigmas_digest`` and the build device.

    phasyn-h3-adaln-sidecar \\
        --transformer-path <models>/MiniMax-H3/FL2VA/transformer --variant fl2va \\
        --task-shape t2va --task-shape fl2va --steps 8 --video-shift 12 --audio-shift 3 \\
        --lora-manifest runtimes/h3/src/phasyn_h3/loras/pai-h3-fl2va-acc8.json --model-root <models> \\
        --output <models>/adaln-cache/h3-fl2va-pdd8.safetensors --device cuda

(``python -m phasyn_h3.recipe.runtime.adaln_sidecar`` is the same tool.)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from collections.abc import Iterable, Mapping, Sequence
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import numpy as np

from phasyn_h3.recipe.adapter.loras import pdd_blocks as manifest_pdd_blocks
from phasyn_h3.recipe.adapter.loras import pdd_blocks_problems

from .lora_policy import LORA_ACCUMULATE, SIDECAR_LORA_ACCUMULATE_KEY
from .sigmas import SigmaGrid, load_sigma_grid, plan_key, step_unique_timesteps

FORMAT_VERSION = "2"  # minimax_h3_adaln_cache.py:386
TASK_SHAPES = {  # (has_visual_condition, has_audio_reference) as prepare_adaln.condition_flags
    "t2va": (False, False),
    "fl2va": (True, False),
    "ref2va-image": (True, False),
    "ref2va-audio": (False, True),
    "ref2va-mixed": (True, True),
}
SHAPE_VARIANT = {
    "t2va": "fl2va",
    "fl2va": "fl2va",
    "ref2va-image": "ref2va",
    "ref2va-audio": "ref2va",
    "ref2va-mixed": "ref2va",
}
BUILDER = "phasyn_h3.recipe.runtime.adaln_sidecar/1"


class _SingleRankGroup:
    """TP group of one rank for the layer constructors (``layers/utils.py:17-32``)."""

    world_size = 1
    rank_in_group = 0


def grid_from_schedule(
    steps: int, video_shift: float, audio_shift: float, *, pdd_blocks: Sequence[int] | None = None
) -> tuple[SigmaGrid, str]:
    """The grid the plan compiler freezes for these sampling values (adapter build_schedule; ``pdd_blocks`` = a
    PDD manifest's non-uniform ``pdd.blocks``)."""
    from phasyn_h3.recipe.adapter.schedule import build_schedule, read_sigma_payload

    schedule, payload, _ = build_schedule(
        steps=steps, video_shift=video_shift, audio_shift=audio_shift, pdd_blocks=pdd_blocks
    )
    arrays = read_sigma_payload(payload)
    grid = SigmaGrid(
        video=tuple(float(x) for x in arrays["video_sigmas"].tolist()),
        audio=tuple(float(x) for x in arrays["audio_sigmas"].tolist()),
        sha256=str(schedule["sigmas_digest"]),
    )
    return grid, str(schedule["sigmas_digest"])


def collect_plans(grid: SigmaGrid, shapes: Iterable[str]) -> list[np.ndarray]:
    """Unique per-step timestep plans over all task shapes, first-seen order."""
    seen: dict[tuple[int, ...], np.ndarray] = {}
    for shape in shapes:
        visual, audio = TASK_SHAPES[shape]
        for plan in step_unique_timesteps(grid, has_visual_condition=visual, has_audio_reference=audio):
            seen.setdefault(plan_key(plan), plan)
    return list(seen.values())


class CheckpointReader:
    """Read named tensors from a native transformer dir (index.json or plain shards)."""

    def __init__(self, transformer_path: Path, stack: ExitStack) -> None:
        from safetensors import safe_open

        index = transformer_path / "model.safetensors.index.json"
        if index.is_file():
            weight_map: dict[str, str] = json.loads(index.read_text(encoding="utf-8"))["weight_map"]
            files = sorted(set(weight_map.values()))
        else:
            files = sorted(p.name for p in transformer_path.glob("*.safetensors"))
            weight_map = {}
        self.handles = {
            name: stack.enter_context(safe_open(str(transformer_path / name), framework="pt")) for name in files
        }
        if not weight_map:
            for name, handle in self.handles.items():
                for key in handle.keys():  # noqa: SIM118 - safe_open has no __iter__
                    weight_map[key] = name
        self.weight_map = weight_map
        h = hashlib.sha256()
        if index.is_file():
            h.update(index.read_bytes())
        for name in files:
            h.update(name.encode())
            h.update(str((transformer_path / name).stat().st_size).encode())
        config = transformer_path / "config.json"
        if config.is_file():
            h.update(config.read_bytes())
        self.digest = h.hexdigest()

    def get(self, name: str) -> Any:
        shard = self.weight_map.get(name)
        if shard is None:
            raise KeyError(f"checkpoint 沒有 {name}（需原生 layout 的未量化 DiT）")
        return self.handles[shard].get_tensor(name)

    def num_blocks(self) -> int:
        blocks = {
            int(k.split(".")[1])
            for k in self.weight_map
            if k.startswith("blocks.") and ".adaln_proj.linear.weight" in k
        }
        if not blocks or sorted(blocks) != list(range(len(blocks))):
            raise ValueError("checkpoint 的 blocks.N.adaln_proj.linear.weight 不連續或不存在")
        return len(blocks)


def adaln_lora_factors(lora_file: Path, *, num_blocks: int) -> dict[int, tuple[Any, Any]]:
    """``{block: (A [r,in], B [out,r])}`` of the LoRA's ``adaln_proj.linear`` factors, through
    SGLang's own normalization and name mapping (the same path the actor uses)."""
    from sglang.multimodal_gen.configs.models.dits.minimax_h3 import MiniMaxH3DiTArchConfig
    from sglang.multimodal_gen.runtime.loader.utils import get_param_names_mapping
    from sglang.multimodal_gen.runtime.pipelines_core.lora.format_adapter import normalize_lora_state_dict

    from .lora import read_lora_file

    raw, _ = read_lora_file(lora_file)
    adaln = {k: v for k, v in raw.items() if ".adaln_proj.linear." in k}
    arch = MiniMaxH3DiTArchConfig()
    lora_mapping = get_param_names_mapping(arch.lora_param_names_mapping)
    mapping = get_param_names_mapping(arch.param_names_mapping)
    out: dict[int, dict[str, Any]] = {}
    for source, tensor in normalize_lora_state_dict(adaln, adapter_config={}).items():
        name, _, _ = lora_mapping(source.replace(".weight", ""))
        target, merge_index, _ = mapping(name)
        parts = target.split(".")
        if (
            merge_index is not None
            or len(parts) != 5
            or parts[0] != "blocks"
            or parts[2:4] != ["adaln_proj", "linear"]
            or parts[4] not in ("lora_A", "lora_B")
        ):
            raise ValueError(f"AdaLN LoRA key {source} 對應到 {target}，不是 blocks.N.adaln_proj.linear")
        out.setdefault(int(parts[1]), {})[parts[4]] = tensor
    if sorted(out) != list(range(num_blocks)) or any(set(v) != {"lora_A", "lora_B"} for v in out.values()):
        raise ValueError(f"AdaLN LoRA 必須涵蓋全部 {num_blocks} 個 block 的 A/B，實際 {sorted(out)}")
    return {block: (pair["lora_A"], pair["lora_B"]) for block, pair in out.items()}


def time_embedding(timesteps: Any, weights: Mapping[str, Any], *, device: Any, tp_group: Any = None) -> Any:
    """``MiniMaxH3TimeEmbedder.forward`` (minimax_h3.py:616-668) with the same layer classes."""
    import torch
    from sglang.multimodal_gen.runtime.layers.linear import ColumnParallelLinear, RowParallelLinear

    w_in, w_out = weights["time_embedder.proj_in.weight"], weights["time_embedder.proj_out.weight"]
    proj_in = ColumnParallelLinear(
        int(w_in.shape[1]),
        int(w_in.shape[0]),
        bias=True,
        gather_output=False,
        params_dtype=torch.float32,
        tp_group=tp_group,
    )
    proj_out = RowParallelLinear(
        int(w_out.shape[1]),
        int(w_out.shape[0]),
        bias=True,
        input_is_parallel=True,
        params_dtype=torch.float32,
        tp_group=tp_group,
    )
    for layer, prefix in ((proj_in, "time_embedder.proj_in"), (proj_out, "time_embedder.proj_out")):
        layer.to(device)
        layer.weight.data.copy_(weights[f"{prefix}.weight"].to(device=device, dtype=torch.float32))
        layer.bias.data.copy_(weights[f"{prefix}.bias"].to(device=device, dtype=torch.float32))
    half = int(w_in.shape[1]) // 2
    freqs = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32, device=device) / half)
    args = timesteps.to(device=device, dtype=torch.float32)[:, None] * freqs[None]
    t_freq = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
    hidden, _ = proj_in(t_freq)
    hidden = torch.nn.functional.silu(hidden)
    out, _ = proj_out(hidden)
    return out


def build_sidecar(
    *,
    reader: CheckpointReader,
    plans: Sequence[np.ndarray],
    variant: str,
    device: Any,
    lora: Mapping[str, Any] | None = None,
    tp_group: Any = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Tensors + metadata of the sidecar.  ``lora``: ``{"factors": {block: (A, B)}, "rank",
    "alpha", "scale", "signature"}`` (None → base sidecar, signature "none")."""
    import torch
    from sglang.multimodal_gen.runtime.layers.linear import ColumnParallelLinear

    from .lora_inplace import inplace_wrapper_classes

    if not plans:
        raise ValueError("沒有任何 timestep plan")
    num_blocks = reader.num_blocks()
    width = max(int(p.shape[0]) for p in plans)
    w0 = reader.get("blocks.0.adaln_proj.linear.weight")
    block_out, block_in = int(w0.shape[0]), int(w0.shape[1])
    wf = reader.get("final_layer.adaln_proj.linear.weight")
    final_out = int(wf.shape[0])
    del w0, wf
    plan_timesteps = torch.zeros((len(plans), width), dtype=torch.float32)
    plan_lengths = torch.tensor([int(p.shape[0]) for p in plans], dtype=torch.int64)
    block_params = torch.zeros((len(plans), width, num_blocks, block_out), dtype=torch.bfloat16)
    final_params = torch.zeros((len(plans), width, final_out), dtype=torch.bfloat16)

    time_weights = {
        f"time_embedder.{m}.{p}": reader.get(f"time_embedder.{m}.{p}")
        for m in ("proj_in", "proj_out")
        for p in ("weight", "bias")
    }
    # weights are written under no_grad and evaluated under inference_mode, like the loaded DiT
    # that the denoise loop calls inside torch.inference_mode (S/denoise_loop.py:595)
    inputs = []
    for index, plan in enumerate(plans):
        t = torch.from_numpy(np.asarray(plan, dtype=np.float32))
        plan_timesteps[index, : t.shape[0]] = t
        with torch.inference_mode():
            # prepare_adaln_plans "match" precision: silu(time_embedder(t)).to(bf16) (minimax_h3.py:1997-2003)
            emb = time_embedding(t, time_weights, device=device, tp_group=tp_group)
            inputs.append(torch.nn.functional.silu(emb).to(torch.bfloat16))

    with torch.no_grad():
        layer = ColumnParallelLinear(
            block_in, block_out, bias=True, gather_output=False, params_dtype=torch.bfloat16, tp_group=tp_group
        ).to(device)
    projector: Any = layer
    if lora is not None:
        # the runtime's dynamic path (lora.attach_dynamic): same class, same in-place arithmetic
        projector = inplace_wrapper_classes()["ColumnParallelLinearWithLoRA"](
            layer, lora_rank=int(lora["rank"]), lora_alpha=float(lora["alpha"]), snapshot_base=False
        )
    for block in range(num_blocks):
        prefix = f"blocks.{block}.adaln_proj.linear"
        with torch.no_grad():
            layer.weight.data.copy_(reader.get(f"{prefix}.weight").to(device=device, dtype=torch.bfloat16))
            layer.bias.data.copy_(reader.get(f"{prefix}.bias").to(device=device, dtype=torch.bfloat16))
        if lora is not None:
            a, b = lora["factors"][block]
            projector.lora_rank = int(lora["rank"])
            projector.lora_alpha = float(lora["alpha"])
            projector.set_lora_weights(
                a.to(device), b.to(device), strength=float(lora["scale"]), clear_existing=True, merge_weights=False
            )
        with torch.inference_mode():
            for index, x in enumerate(inputs):
                out, _ = projector(x)
                block_params[index, : x.shape[0], block] = out.to("cpu")
    with torch.no_grad():
        final = ColumnParallelLinear(
            block_in, final_out, bias=True, gather_output=False, params_dtype=torch.bfloat16, tp_group=tp_group
        ).to(device)
        final.weight.data.copy_(
            reader.get("final_layer.adaln_proj.linear.weight").to(device=device, dtype=torch.bfloat16)
        )
        final.bias.data.copy_(reader.get("final_layer.adaln_proj.linear.bias").to(device=device, dtype=torch.bfloat16))
    with torch.inference_mode():
        for index, x in enumerate(inputs):
            out, _ = final(x)
            final_params[index, : x.shape[0]] = out.to("cpu")

    device_name = str(device)
    if getattr(torch, "cuda", None) is not None and str(device).startswith("cuda") and torch.cuda.is_available():
        device_name = (
            f"{torch.cuda.get_device_name(device)} sm{''.join(map(str, torch.cuda.get_device_capability(device)))}"
        )
    metadata = {
        "format_version": FORMAT_VERSION,
        "model_variant": variant,
        "lora_signature": "none" if lora is None else str(lora["signature"]),
        # how the AdaLN LoRA term was added (prepare_adaln compares it with the runtime's dynamic path)
        **({} if lora is None else {SIDECAR_LORA_ACCUMULATE_KEY: LORA_ACCUMULATE}),
        "base_checkpoint_digest": reader.digest,
        "builder": BUILDER,
        "build_device": device_name,
        "torch": str(torch.__version__),
        "plans": str(len(plans)),
    }
    tensors = {
        "plan_timesteps": plan_timesteps,
        "plan_lengths": plan_lengths,
        "block_params": block_params,
        "final_params": final_params,
    }
    return tensors, metadata


def lora_inputs(
    manifest: Mapping[str, Any], *, model_root: Path, scale: float, lora_file: Path | None
) -> dict[str, Any]:
    """Verified AdaLN factors + signature of one registry manifest (``touches_adaln`` only)."""
    from phasyn_h3.recipe.adapter.loras import adaln_lora_signature

    from .lora import verify_lora_file
    from .lora_policy import LoraSpec

    if not manifest.get("touches_adaln"):
        raise ValueError(f"{manifest.get('lora_id')} 不觸及 adaln_proj：用基礎 sidecar（lora_signature none）即可")
    fixed = manifest.get("fixed_scale")
    if fixed is not None and float(scale) != float(fixed):
        raise ValueError(f"{manifest['lora_id']} 的強度固定為 {fixed}")
    file = manifest["file"]
    path = lora_file or (model_root / file["relative_path"])
    spec = LoraSpec(
        lora_id=str(manifest["lora_id"]),
        revision=str(manifest["source_revision"]),
        relative_path=str(file["relative_path"]),
        sha256=str(file["sha256"]),
        size_bytes=int(file["size_bytes"]),
        format=str(manifest["format"]),
        rank=int(manifest["rank"]),
        alpha=float(manifest["alpha"]),
        alpha_source=str(manifest["alpha_source"]),
        scale=float(scale),
        touches_adaln=True,
        targets=tuple(manifest.get("targets") or ()),
        pdd_num_steps=None,
        pdd_block_size=None,
        steps=(),
        video_shift=0.0,
        audio_shift=0.0,
        adaln_handling="sidecar",
    )
    verify_lora_file(path, spec)
    binding = {
        "lora_id": manifest["lora_id"],
        "revision": manifest["source_revision"],
        "scale": scale,
        "manifest": manifest,
    }
    return {
        "path": path,
        "rank": spec.rank,
        "alpha": spec.alpha,
        "scale": spec.scale,
        "signature": adaln_lora_signature([binding]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="phasyn-h3-adaln-sidecar", description=__doc__.split("\n")[0])
    parser.add_argument("--transformer-path", type=Path, required=True)
    parser.add_argument("--variant", choices=("fl2va", "ref2va"), required=True)
    parser.add_argument("--task-shape", action="append", choices=sorted(TASK_SHAPES), required=True)
    parser.add_argument("--steps", type=int, default=None)
    parser.add_argument("--video-shift", type=float, default=None)
    parser.add_argument("--audio-shift", type=float, default=None)
    parser.add_argument("--sigmas", type=Path, default=None, help="plan 的 sigma artifact（取代 steps/shift）")
    parser.add_argument(
        "--lora-manifest", type=Path, default=None, help="registry manifest JSON（觸及 adaln_proj 的 LoRA）"
    )
    parser.add_argument("--lora-file", type=Path, default=None, help="預設 --model-root + manifest relative_path")
    parser.add_argument("--lora-scale", type=float, default=1.0)
    parser.add_argument("--model-root", type=Path, default=Path(os.environ.get("PHASYN_MODEL_ROOT") or "models"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--allow-cpu", action="store_true", help="測試用；GPU 才能與 serving 逐位元一致")
    args = parser.parse_args(argv)

    import torch

    bad_shapes = [s for s in args.task_shape if SHAPE_VARIANT[s] != args.variant]
    if bad_shapes:
        parser.error(f"task shape {bad_shapes} 不屬於 variant {args.variant}")
    manifest = None
    if args.lora_manifest is not None:
        manifest = json.loads(args.lora_manifest.read_text(encoding="utf-8"))
        if args.variant not in manifest.get("variants", []):
            parser.error(f"LoRA {manifest.get('lora_id')} 不適用 {args.variant}")
    blocks = None
    if manifest is not None:
        problems = pdd_blocks_problems(manifest)
        if problems:
            parser.error("；".join(problems))
        blocks = manifest_pdd_blocks(manifest)
    if args.sigmas is not None:
        grid = load_sigma_grid(args.sigmas, {})
        sigmas_digest = grid.sha256
    else:
        if None in (args.steps, args.video_shift, args.audio_shift):
            parser.error("需要 --sigmas 或 --steps/--video-shift/--audio-shift")
        if blocks is not None and args.steps != len(blocks):
            parser.error(f"LoRA manifest 的 pdd.blocks {list(blocks)} 是 {len(blocks)} 步，--steps 是 {args.steps}")
        # a non-uniform PDD grouping: the plan grid is its block boundaries, as build_plan makes it
        grid, sigmas_digest = grid_from_schedule(args.steps, args.video_shift, args.audio_shift, pdd_blocks=blocks)
    plans = collect_plans(grid, args.task_shape)
    device = torch.device(args.device)
    if device.type == "cuda" and device.index is None:
        device = torch.device("cuda", 0)  # the platform set_device needs an index; narrow with CUDA_VISIBLE_DEVICES
    tp_group: Any = _SingleRankGroup()
    if device.type == "cuda":
        from .sglang_env import SglangSession

        SglangSession(args.output.parent / ".sidecar-build").ensure_process(device)
        tp_group = None  # the real (single-rank) TP group, as in the actor
    elif not args.allow_cpu:
        parser.error("serving 的 AdaLN 輸出在 GPU 上計算；CPU 建置只供測試（--allow-cpu）")
    lora = None
    if manifest is not None:
        lora = lora_inputs(manifest, model_root=args.model_root, scale=args.lora_scale, lora_file=args.lora_file)
    with ExitStack() as stack:
        reader = CheckpointReader(args.transformer_path, stack)
        if lora is not None:
            lora["factors"] = adaln_lora_factors(lora["path"], num_blocks=reader.num_blocks())
        tensors, metadata = build_sidecar(
            reader=reader, plans=plans, variant=args.variant, device=device, lora=lora, tp_group=tp_group
        )
    metadata["sigmas_digest"] = sigmas_digest
    metadata["task_shapes"] = ",".join(args.task_shape)
    from safetensors.torch import save_file

    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.output.with_suffix(".tmp")
    save_file(tensors, str(tmp), metadata=metadata)
    tmp.replace(args.output)
    print(json.dumps({"written": str(args.output), **metadata}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
