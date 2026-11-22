# SPDX-License-Identifier: Apache-2.0
# Uses the pinned SGLang MiniMax-H3 classes (de487f8039e06853b5f376fd5f068ea9d7c400bb) without editing them:
# python/sglang/multimodal_gen/runtime/models/dits/minimax_h3.py (MiniMaxH3DiTModel and its block helpers),
# .../stages/model_specific_stages/minimax_h3/{condition_noise,denoise_loop,packed_sequence,packed_tokens}.py,
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
"""The frozen H3 Ref2VA DiT with trainable LoRA factors (torch + pinned SGLang, lazily imported).

* The base linears of the 50 blocks are stored as INT8 with BF16 group scales (``W8``) and dequantized to BF16
  for every matmul; the backward recomputes the dequantized weight instead of keeping it.
* AdaLN is served by SGLang's own rebuild cache (``adaln_proj`` streamed from the checkpoint once per
  timestep plan), so the 24 GiB projection is never resident.
* On CUDA the block helpers call fused in-place kernels without a backward. They are replaced, in this process
  only, by the eager formulas the CPU path of the same module uses (same math, autograd-safe), and every
  attention module uses torch SDPA. The replaced symbols must exist, or loading fails.
* LoRA factors (FP32 masters, used in the activations' dtype) wrap ``attn.qkv_proj``, ``attn.out_proj``,
  ``mlp.fc1`` and ``mlp.fc2``; ``B`` starts at zero, so an untrained adapter changes nothing.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import types
from collections.abc import Callable, Iterable
from functools import cache
from pathlib import Path
from typing import Any, override

from phasyn_h3.recipe.adapter.training_rules import TARGET_KEYS


GPU_ENV = {
    "LOCAL_RANK": "0",
    "RANK": "0",
    "WORLD_SIZE": "1",
    "GLOO_SOCKET_IFNAME": "lo",
    "NCCL_SOCKET_IFNAME": "lo",
}
PATCHED = (
    "_modulate_scale_shift",
    "_modulate_rmsnorm_scale_shift",
    "_modulate_gate",
    "_silu_mul",
    "_apply_qk_norm",
    "_apply_rope_qk",
)
_TARGET_RE = re.compile(
    r"blocks\.\d+\.(attn\.qkv_proj|attn\.out_proj|mlp\.fc1|mlp\.fc2)"
)
_LOG_EVERY = 64


def init_runtime(work: Path) -> types.SimpleNamespace:
    """Import the pinned SGLang H3 modules and a world-size-1 process group (file rendezvous)."""
    import torch
    from sglang.multimodal_gen.configs.models.dits.minimax_h3 import MiniMaxH3DiTConfig  # type: ignore[import-untyped]
    from sglang.multimodal_gen.runtime.distributed.parallel_state import (  # type: ignore[import-untyped]
        maybe_init_distributed_environment_and_model_parallel,
    )
    from sglang.multimodal_gen.runtime.layers.attention.backends.sdpa import SDPABackend  # type: ignore[import-untyped]
    from sglang.multimodal_gen.runtime.managers.forward_context import (  # type: ignore[import-untyped]
        set_forward_context,
    )
    from sglang.multimodal_gen.runtime.models.dits import minimax_h3 as mh  # type: ignore[import-untyped]
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3 import (  # type: ignore[import-untyped]
        condition_noise as cn,
        denoise_loop as dl,
        packed_sequence as ps,
        packed_tokens as ptok,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.stages.denoising import (  # type: ignore[import-untyped]
        _precompute_refined_prompt_embeds,
        _precompute_rope_cache,
    )
    from sglang.multimodal_gen.runtime.platforms import AttentionBackendEnum  # type: ignore[import-untyped]

    for key, value in GPU_ENV.items():
        os.environ.setdefault(key, value)
    work.mkdir(parents=True, exist_ok=True)
    maybe_init_distributed_environment_and_model_parallel(
        tp_size=1,
        sp_size=1,
        cfg_degree=1,
        ulysses_degree=1,
        ring_degree=1,
        dp_size=1,
        distributed_init_method=f"file://{work}/rdv-{os.getpid()}",
    )
    return types.SimpleNamespace(
        torch=torch,
        device=torch.device("cuda"),
        mh=mh,
        dl=dl,
        ps=ps,
        ptok=ptok,
        cn=cn,
        DiTConfig=MiniMaxH3DiTConfig,
        SDPABackend=SDPABackend,
        AttentionBackendEnum=AttentionBackendEnum,
        set_forward_context=set_forward_context,
        precompute_refined=_precompute_refined_prompt_embeds,
        precompute_rope=_precompute_rope_cache,
    )


def patch_autograd_safe(rt: types.SimpleNamespace) -> list[str]:
    """Replace H3's fused in-place CUDA helpers by their eager formulas (idempotent; refuses unknown symbols)."""
    mh = rt.mh
    if getattr(mh, "_phasyn_training_patch", None):
        return list(PATCHED)
    missing = [name for name in PATCHED if not callable(getattr(mh, name, None))]
    if missing:
        raise RuntimeError(
            f"pinned SGLang lacks minimax_h3.{missing}: the training patch does not match"
        )
    F = rt.torch.nn.functional  # noqa: N806 - the conventional name

    def modulate_scale_shift(
        x: Any, shift: Any, scale: Any, indices: Any, *, dtype: Any
    ) -> Any:
        return (
            x * (1.0 + scale.index_select(0, indices)) + shift.index_select(0, indices)
        ).to(dtype)

    def modulate_rmsnorm_scale_shift(  # noqa: PLR0913 - the patched upstream signature
        x: Any,
        norm: Any,
        shift: Any,
        scale: Any,
        indices: Any,
        *,
        dtype: Any,
        fused: bool = False,
    ) -> Any:
        del fused
        return modulate_scale_shift(norm(x), shift, scale, indices, dtype=dtype)

    def modulate_gate(  # noqa: PLR0913 - the patched upstream signature
        x: Any,
        gate: Any,
        other: Any,
        indices: Any,
        *,
        dtype: Any,
        allow_inplace: bool = True,
    ) -> Any:
        del allow_inplace
        return (x + gate.index_select(0, indices) * other).to(dtype)

    def silu_mul(hidden: Any, *, reuse_input: bool) -> Any:
        del reuse_input
        gate, up = hidden.chunk(2, dim=-1)
        return F.silu(gate) * up

    def apply_qk_norm(
        q: Any, k: Any, q_norm: Any, k_norm: Any, head_dim: int
    ) -> tuple[Any, Any]:
        del head_dim
        return q_norm(q), k_norm(k)

    def apply_rope_qk(
        q: Any, k: Any, cos_sin_cache: Any, positions: Any
    ) -> tuple[Any, Any]:
        del positions
        return mh._apply_rope(q, cos_sin_cache), mh._apply_rope(k, cos_sin_cache)

    for name, fn in zip(
        PATCHED,
        (
            modulate_scale_shift,
            modulate_rmsnorm_scale_shift,
            modulate_gate,
            silu_mul,
            apply_qk_norm,
            apply_rope_qk,
        ),
        strict=True,
    ):
        setattr(mh, name, fn)
    mh._phasyn_training_patch = True
    return list(PATCHED)


def bind_sdpa(rt: types.SimpleNamespace, model: Any) -> int:
    """Torch SDPA (autograd-capable) on every attention module; fused QK-norm+RoPE off."""
    n = 0
    for m in model.modules():
        if isinstance(m, rt.mh.MiniMaxH3Attention):
            m._set_attention_backend(rt.SDPABackend)
            m._use_fused_qknorm_rope = False
            n += 1
    model._resolved_attention_backend = rt.AttentionBackendEnum.TORCH_SDPA
    return n


def configure_cuda_sdpa() -> dict[str, str]:
    """Keep the fused SDPA backends that run forward and backward in BF16 (head dim 128); never MATH."""
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel

    F = torch.nn.functional  # noqa: N806 - the conventional name
    result: dict[str, str] = {}
    q = torch.randn(
        1, 4, 256, 128, device="cuda", dtype=torch.bfloat16, requires_grad=True
    )
    for name, backend in (
        ("flash", SDPBackend.FLASH_ATTENTION),
        ("efficient", SDPBackend.EFFICIENT_ATTENTION),
        ("cudnn", SDPBackend.CUDNN_ATTENTION),
    ):
        try:
            with sdpa_kernel([backend]):
                F.scaled_dot_product_attention(q, q, q).float().sum().backward()  # type: ignore[no-untyped-call]
            torch.cuda.synchronize()
            result[name] = "ok"
        except RuntimeError as exc:
            result[name] = f"{type(exc).__name__}: {str(exc)[:160]}"
        q.grad = None
    torch.backends.cuda.enable_flash_sdp(result["flash"] == "ok")
    torch.backends.cuda.enable_mem_efficient_sdp(result["efficient"] == "ok")
    torch.backends.cuda.enable_cudnn_sdp(
        result["cudnn"] == "ok" and "ok" not in (result["flash"], result["efficient"])
    )
    torch.backends.cuda.enable_math_sdp(enabled=False)
    if "ok" not in result.values():
        raise RuntimeError(
            f"no fused SDPA backend with a backward on this GPU: {result}"
        )
    return result


def quantize_w8(weight: Any, group: int, chunk_rows: int = 2048) -> tuple[Any, Any]:
    """Symmetric INT8 per (row, group of input columns) with BF16 scales (group 0 = one scale per row)."""
    import torch

    bf16 = torch.bfloat16
    out_f, in_f = weight.shape
    g = group or in_f
    if in_f % g:
        raise ValueError(f"in_features {in_f} not divisible by group {g}")
    q = torch.empty((out_f, in_f), dtype=torch.int8, device=weight.device)
    s = torch.empty((out_f, in_f // g), dtype=bf16, device=weight.device)
    for r0 in range(0, out_f, chunk_rows):
        blk = weight[r0 : r0 + chunk_rows].float().view(-1, in_f // g, g)
        sc = (blk.abs().amax(-1) / 127.0).clamp_min(1e-30).to(bf16)
        q[r0 : r0 + chunk_rows] = (
            torch.round(blk / sc.float().unsqueeze(-1))
            .clamp_(-127, 127)
            .to(torch.int8)
            .view(-1, in_f)
        )
        s[r0 : r0 + chunk_rows] = sc
    return q, s


def dequant_w8(q: Any, s: Any, dtype: Any = None) -> Any:
    """The BF16 (or ``dtype``) weight of a W8 linear."""
    import torch

    dtype = dtype or torch.bfloat16
    out_f, in_f = q.shape
    groups = s.shape[1]
    return (
        q.view(out_f, groups, in_f // groups).to(dtype) * s.to(dtype).unsqueeze(-1)
    ).view(out_f, in_f)


@cache
def layers() -> types.SimpleNamespace:
    """The torch module classes (defined on first use so the module imports without torch)."""
    import torch
    from torch import nn

    F = torch.nn.functional  # noqa: N806 - the conventional name

    class W8LinearFn(torch.autograd.Function):
        @staticmethod
        @override
        def forward(ctx: Any, x: Any, q: Any, s: Any) -> Any:
            ctx.save_for_backward(q, s)
            return F.linear(x, dequant_w8(q, s, x.dtype))

        @staticmethod
        @override
        def backward(ctx: Any, grad_out: Any) -> tuple[Any, None, None]:
            q, s = ctx.saved_tensors
            grad_x = (
                grad_out.matmul(dequant_w8(q, s, grad_out.dtype))
                if ctx.needs_input_grad[0]
                else None
            )
            return grad_x, None, None

    class W8Linear(nn.Module):
        """Frozen INT8-stored linear with SGLang's ``(out, bias)`` call contract (H3 block linears have no bias)."""

        def __init__(self, weight: Any, group: int) -> None:
            super().__init__()
            q, s = quantize_w8(weight, group)
            self.register_buffer("qweight", q)
            self.register_buffer("wscale", s)
            self.out_features, self.in_features = (
                int(weight.shape[0]),
                int(weight.shape[1]),
            )

        @override
        def forward(self, x: Any) -> tuple[Any, None]:
            if torch.is_grad_enabled() and x.requires_grad:
                return W8LinearFn.apply(x, self.qweight, self.wscale), None
            return F.linear(x, dequant_w8(self.qweight, self.wscale, x.dtype)), None

    class LoRALinear(nn.Module):
        """``base(x) + (x A^T)(s B)^T`` with ``s = alpha / rank``; FP32 masters used in x's dtype."""

        def __init__(
            self, base: Any, in_f: int, out_f: int, rank: int, alpha: float
        ) -> None:
            super().__init__()
            self.base = base
            self.rank, self.alpha = rank, float(alpha)
            self.scale = float(alpha) / float(rank)
            dev = (
                next((b.device for b in base.buffers()), None)
                or next(base.parameters()).device
            )
            self.lora_A = nn.Parameter(
                torch.empty(rank, in_f, device=dev, dtype=torch.float32)
            )
            self.lora_B = nn.Parameter(
                torch.zeros(out_f, rank, device=dev, dtype=torch.float32)
            )
            self.reset()

        def reset(self) -> None:
            with torch.no_grad():
                nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
                self.lora_B.zero_()

        @override
        def forward(self, x: Any) -> tuple[Any, Any]:
            out, bias = self.base(x)
            h = F.linear(x, self.lora_A.to(x.dtype))
            return out + F.linear(h, (self.lora_B * self.scale).to(x.dtype)), bias

    return types.SimpleNamespace(
        W8Linear=W8Linear, LoRALinear=LoRALinear, dequant_w8=dequant_w8
    )


def _linear_shape(module: Any) -> tuple[int, int]:
    if hasattr(module, "qweight"):
        return module.in_features, module.out_features
    w = module.weight
    return int(w.shape[1]), int(w.shape[0])


def inject_lora(
    model: Any,
    *,
    rank: int,
    alpha: float,
    targets: Iterable[str],
    blocks: Iterable[int],
) -> list[str]:
    """Wrap the target linears of ``blocks`` with LoRA layers and freeze everything else."""
    lay = layers()
    for p in model.parameters():
        p.requires_grad_(requires_grad=False)
    names = []
    for i in blocks:
        blk = model.blocks[i]
        for key in targets:
            parent_name, child = TARGET_KEYS[key].rsplit(".", 1)
            parent = blk.get_submodule(parent_name)
            base = getattr(parent, child)
            in_f, out_f = _linear_shape(base)
            setattr(parent, child, lay.LoRALinear(base, in_f, out_f, rank, alpha))
            names.append(f"blocks.{i}.{TARGET_KEYS[key]}")
    return names


def remove_lora(model: Any) -> int:
    """Unwrap every LoRA layer back to its frozen base linear; returns how many were removed."""
    cls = layers().LoRALinear
    removed = 0
    for name, module in list(model.named_modules()):
        if isinstance(module, cls):
            parent_name, child = name.rsplit(".", 1)
            setattr(model.get_submodule(parent_name), child, module.base)
            removed += 1
    return removed


def lora_modules(model: Any) -> list[tuple[str, Any]]:
    """(name, module) of every LoRA layer, in model order."""
    cls = layers().LoRALinear
    return [(n, m) for n, m in model.named_modules() if isinstance(m, cls)]


def lora_parameters(model: Any) -> list[Any]:
    """The trainable tensors (A and B of every LoRA layer)."""
    return [p for _, m in lora_modules(model) for p in (m.lora_A, m.lora_B)]


def lora_state(model: Any) -> dict[str, Any]:
    """CPU copies of every factor, keyed ``<layer>.lora_A`` / ``<layer>.lora_B``."""
    return {
        f"{n}.{p}": getattr(m, p).detach().clone().cpu()
        for n, m in lora_modules(model)
        for p in ("lora_A", "lora_B")
    }


def load_lora_state(model: Any, state: dict[str, Any]) -> None:
    """Copy saved factors into the LoRA layers (every layer must be present)."""
    import torch

    with torch.no_grad():
        for n, m in lora_modules(model):
            for p in ("lora_A", "lora_B"):
                getattr(m, p).copy_(state[f"{n}.{p}"].to(getattr(m, p).device))


def reset_lora(model: Any, seed: int) -> None:
    """A fresh adapter (seeded A, zero B) on the already injected layers."""
    import torch

    torch.manual_seed(seed)
    for _, m in lora_modules(model):
        m.reset()


def enable_checkpointing(model: Any, block_ids: Iterable[int]) -> list[int]:
    """Non-reentrant activation checkpointing per DiT block while grad is enabled."""
    import torch
    from torch.utils.checkpoint import checkpoint

    done = []
    for i in block_ids:
        blk = model.blocks[i]
        if getattr(blk, "_phasyn_ckpt", False):
            continue
        fwd = blk.forward

        def wrapped(x: Any, _fwd: Callable[..., Any] = fwd, **kw: Any) -> Any:
            if torch.is_grad_enabled():
                return checkpoint(
                    _fwd, x, use_reentrant=False, preserve_rng_state=False, **kw
                )
            return _fwd(x, **kw)

        blk.forward = wrapped
        blk._phasyn_ckpt = True
        done.append(i)
    return done


class _Checkpoint:
    """Tensor access of a sharded safetensors checkpoint (one open handle per file)."""

    def __init__(self, files: list[str], device: str) -> None:
        from safetensors import safe_open

        self.index: dict[str, str] = {}
        for f in files:
            with safe_open(f, framework="pt", device="cpu") as h:
                for k in h.keys():  # noqa: SIM118 - safe_open is not a mapping
                    self.index[k] = f
        self.device = device
        self.handles: dict[str, Any] = {}
        self._open = safe_open

    def get(self, name: str) -> Any:
        f = self.index.get(name)
        if f is None:
            raise KeyError(f"checkpoint has no tensor {name}")
        if f not in self.handles:
            self.handles[f] = self._open(
                f, framework="pt", device=self.device
            ).__enter__()  # type: ignore[no-untyped-call]
        return self.handles[f].get_tensor(name)

    def close(self) -> None:
        for h in self.handles.values():
            h.__exit__(None, None, None)


def _loaded_like(ckpt: _Checkpoint, p: Any, name: str, device: Any) -> Any:
    import torch
    from torch import nn

    src = ckpt.get(name)
    new = torch.empty(p.shape, dtype=p.dtype, device=device)
    loader = getattr(p, "weight_loader", None)
    if loader is not None:
        tmp = nn.Parameter(new, requires_grad=False)
        tmp.__dict__.update({k: v for k, v in p.__dict__.items() if k != "_is_param"})
        loader(tmp, src.to(p.dtype))
        new = tmp.data
    else:
        if tuple(src.shape) != tuple(p.shape):
            raise ValueError(
                f"{name}: checkpoint {tuple(src.shape)} != model {tuple(p.shape)}"
            )
        new.copy_(src)
    return new


def load_w8_model(
    rt: types.SimpleNamespace,
    transformer_dir: Path,
    *,
    w8_group: int,
    adaln_max_plans: int,
    log: Callable[[str], None],
) -> tuple[Any, dict[str, Any]]:
    """Build the DiT on the meta device and materialise it tensor by tensor (W8 block linears, AdaLN cache)."""
    import torch
    from torch import nn

    t0 = time.time()
    files = sorted(str(p) for p in transformer_dir.glob("*.safetensors"))
    if not files:
        raise FileNotFoundError(f"no safetensors in {transformer_dir.name}")
    cfg_json = json.loads((transformer_dir / "config.json").read_text())
    dit_cfg = rt.DiTConfig()
    dit_cfg.update_model_arch(
        {k: v for k, v in cfg_json.items() if not k.startswith("_")}
    )
    with torch.device("meta"):
        model = rt.mh.MiniMaxH3DiTModel(
            dit_cfg,
            hf_config=cfg_json,
            adaln_weight_files=files,
            adaln_max_plans=adaln_max_plans,
            adaln_plan_width=4,
        )
    device = rt.device
    ckpt = _Checkpoint(files, str(device))
    lay = layers()
    stats: dict[str, Any] = {"w8_layers": 0, "w8_bytes": 0, "tensors": 0}
    modules = dict(model.named_modules())
    try:
        for mname, module in list(modules.items()):
            if mname.startswith("adaln_cache"):
                continue
            if _TARGET_RE.fullmatch(mname):
                w = _loaded_like(ckpt, module.weight, f"{mname}.weight", device)
                w8 = lay.W8Linear(w, w8_group)
                del w
                parent_name, child = mname.rsplit(".", 1)
                setattr(modules[parent_name], child, w8)
                stats["w8_layers"] += 1
                stats["w8_bytes"] += w8.qweight.numel() + w8.wscale.numel() * 2
                continue
            for pname, p in list(module.named_parameters(recurse=False)):
                full = f"{mname}.{pname}" if mname else pname
                setattr(
                    module,
                    pname,
                    nn.Parameter(
                        _loaded_like(ckpt, p, full, device), requires_grad=False
                    ),
                )
                stats["tensors"] += 1
            for bname, b in list(module.named_buffers(recurse=False)):
                if b is None or bname == "_frequency_cache":
                    continue
                full = f"{mname}.{bname}" if mname else bname
                module._buffers[bname] = _loaded_like(ckpt, b, full, device)
                stats["tensors"] += 1
            if stats["tensors"] % _LOG_EVERY == 0:
                log(f"load: {stats['tensors']} tensors, {time.time() - t0:.0f} s")
    finally:
        ckpt.close()
    leftover = [n for n, p in model.named_parameters() if p.is_meta]
    if leftover:
        raise RuntimeError(f"parameters left on meta: {leftover[:8]}")
    model.post_load_weights()
    model.eval()
    stats["seconds"] = round(time.time() - t0, 1)
    return model, stats


def drop_token_refiner(model: Any) -> int:
    """Free the token refiner once every refined prompt is cached (the forward never calls it then)."""
    from torch import nn

    n = sum(p.numel() * p.element_size() for p in model.token_refiner.parameters())
    model.token_refiner.blocks = nn.ModuleList()
    return int(n)


def set_cuda_cap(cap_gib: float) -> dict[str, Any]:
    """Cap torch's caching allocator (unified memory is not bounded by the process cgroup); self-tested first."""
    import torch

    torch.cuda.init()  # type: ignore[no-untyped-call]
    total = int(torch.cuda.get_device_properties(0).total_memory)
    frac = cap_gib * 2**30 / total
    if not 0.0 < frac <= 1.0:
        raise ValueError(
            f"CUDA cap {cap_gib} GiB outside the device's {total / 2**30:.1f} GiB"
        )
    torch.cuda.set_per_process_memory_fraction(2**30 / total, 0)
    try:
        probe = torch.empty(2 * 2**30, dtype=torch.uint8, device="cuda:0")
    except torch.OutOfMemoryError:
        enforced = True
    else:
        enforced = False
        del probe
    torch.cuda.empty_cache()
    if not enforced:
        raise RuntimeError("the CUDA allocator cap is not enforced on this device")
    torch.cuda.set_per_process_memory_fraction(frac, 0)
    torch.cuda.reset_peak_memory_stats()
    return {
        "cap_gib": cap_gib,
        "fraction": round(frac, 5),
        "device_total_gib": round(total / 2**30, 2),
    }


def cuda_memory() -> dict[str, float]:
    """Allocator view of the device (allocated, reserved and their peaks) in GiB."""
    import torch

    if not torch.cuda.is_available() or not torch.cuda.is_initialized():  # type: ignore[no-untyped-call]
        return {}
    gib = 2**30
    return {
        "allocated_gib": round(torch.cuda.memory_allocated() / gib, 3),
        "reserved_gib": round(torch.cuda.memory_reserved() / gib, 3),
        "max_allocated_gib": round(torch.cuda.max_memory_allocated() / gib, 3),
    }


__all__ = [
    "bind_sdpa",
    "configure_cuda_sdpa",
    "cuda_memory",
    "drop_token_refiner",
    "enable_checkpointing",
    "init_runtime",
    "inject_lora",
    "layers",
    "load_lora_state",
    "load_w8_model",
    "lora_modules",
    "lora_parameters",
    "lora_state",
    "patch_autograd_safe",
    "reset_lora",
    "set_cuda_cap",
]
