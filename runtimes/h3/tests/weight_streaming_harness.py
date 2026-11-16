"""Test support for the weight-streaming video decode (runtime tuple only; no SGLang ServerArgs needed).

* :func:`build_resident` — the production decode half (``MiniMaxH3VideoVAE`` minus encoder/quant_conv, FP32) with the
  first ``blocks`` decoder blocks resident (``None``: all 36); on the CPU the weights are zero-copy views of the
  checkpoint (paged in on demand), elsewhere copies on the device.  This is the module the resident decode runs.
* :func:`build_streaming` — the streaming shell built with the loader's own steps (``loaders._load_video_vae_half``,
  weight-streaming branch): meta construction, :func:`~vae_weight_streaming.block_index`,
  :func:`~vae_weight_streaming.detach_blocks`, the shell tensors read, the RoPE buffer rebuilt, the state attached.
* :func:`decode` — ``decode_base`` through the production decode path of ``decode_video`` (inference mode, exact
  path, forward context, FP32 scope, callback-only temporal streaming; with ``streamed`` the weight-streaming scope
  and the early clip release), returning the raw FP32 output frames and the uint8 frames ``decode_video`` writes.

``USPAttention`` needs SGLang's global ServerArgs to be built, so both modules are built with the SDPA call of
SGLang's ``SDPAImpl`` in its place; FP32 never calls it (``Attention.forward`` takes ``_sdpa_attention`` for FP32),
and both modules of a comparison use the same one.
"""

from __future__ import annotations

import contextlib
import json
import mmap
import os
from pathlib import Path
from typing import Any

NUM_BLOCKS = 36


def _sdpa_stand_in() -> Any:
    import torch
    import torch.nn.functional as F

    class SdpaAttention(torch.nn.Module):
        def __init__(self, num_heads: int, head_size: int, causal: bool = False, **_ignored: Any) -> None:
            super().__init__()
            assert not causal
            self.scale = head_size**-0.5

        def forward(self, q: Any, k: Any, v: Any) -> Any:
            return F.scaled_dot_product_attention(
                q.transpose(1, 2),
                k.transpose(1, 2),
                v.transpose(1, 2),
                dropout_p=0.0,
                is_causal=False,
                scale=self.scale,
            ).transpose(1, 2)

    return SdpaAttention


def vae_config(vae_dir: Path) -> Any:
    from sglang.multimodal_gen.configs.models.vaes.minimax_h3_video import MiniMaxH3VideoVAEConfig

    config = json.loads((vae_dir / "config.json").read_text(encoding="utf-8"))
    config.pop("_class_name", None)
    out = MiniMaxH3VideoVAEConfig()
    out.update_model_arch(config)
    out.post_init()
    return out


def checkpoint(vae_dir: Path) -> Path:
    return vae_dir / "source" / "model.safetensors"


def construct_decode_half(vae_dir: Path, *, on_host: bool = False) -> Any:
    """``MiniMaxH3VideoVAE``, FP32, without the encode half (decode_only drops it unread): on the meta device, or
    (``on_host``) on the host like the pinned loader's decode half — uninitialized storage (``skip_init_modules``)
    that the checkpoint tensors replace untouched, and the constructor's own non-persistent RoPE buffer."""
    import torch
    from sglang.multimodal_gen.runtime.loader.utils import initialize_model
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3 import MiniMaxH3VideoVAE
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae import attention as attn_mod

    saved = attn_mod.USPAttention
    attn_mod.USPAttention = _sdpa_stand_in()
    try:
        where = None if on_host else torch.device("meta")
        vae = initialize_model(MiniMaxH3VideoVAE, {"config": vae_config(vae_dir)}, torch.float32, where)
    finally:
        attn_mod.USPAttention = saved
    for name in ("encoder", "quant_conv"):
        delattr(vae, name)
    return vae


class _Mapped:
    """Zero-copy CPU views of checkpoint tensors (MAP_PRIVATE of a read-only descriptor: never written)."""

    def __init__(self, path: Path) -> None:
        import torch
        from phasyn_h3.recipe.abi.tensors import read_header_from_file

        self.header = read_header_from_file(path)
        fd = os.open(path, os.O_RDONLY)
        try:
            self.map = mmap.mmap(fd, 0, access=mmap.ACCESS_COPY)
        finally:
            os.close(fd)
        self.base = torch.frombuffer(self.map, dtype=torch.uint8)

    def tensor(self, name: str) -> Any:
        import torch

        info = self.header.tensors[name]
        start = self.header.data_offset + info.start
        return self.base[start : start + info.byte_length].view(torch.float32).view(info.shape)


def _finish(vae: Any, device: Any, optimize: bool) -> Any:
    import torch
    from sglang.multimodal_gen.runtime.loader.utils import finalize_loaded_model

    vae = finalize_loaded_model(vae)
    if torch.device(device).type != "cpu":
        vae.to(device)
    if optimize:
        from sglang.multimodal_gen.runtime.platforms import current_platform

        vae = current_platform.optimize_vae(vae)
    return vae


def build_resident(
    vae_dir: Path, *, blocks: int | None, device: Any = "cpu", optimize: bool = False, hold_fp16: bool = False
) -> Any:
    """The production decode half with ``blocks`` real decoder blocks (None: all 36) — the resident decode.  Built on
    the host like the pinned loader (its RoPE buffer is the constructor's), the weights assigned as zero-copy views of
    the checkpoint and, off the CPU, moved to ``device``.  ``hold_fp16``: the fp16 recipe's decoder-linear rounding on
    the host before the move, as the pinned loader does (``_hold_decoder_weights_in_decode_dtype``)."""
    import torch

    vae = construct_decode_half(vae_dir, on_host=True)
    n = NUM_BLOCKS if blocks is None else int(blocks)
    vae.decoder.transformer_blocks = torch.nn.ModuleList(list(vae.decoder.transformer_blocks)[:n])
    mapped = _Mapped(checkpoint(vae_dir))
    names = [name for name, _ in [*vae.named_parameters(), *vae.named_buffers()] if name in mapped.header.tensors]
    want = {
        name
        for name in mapped.header.tensors
        if name.startswith(("decoder.", "post_quant_conv."))
        and (not name.startswith("decoder.transformer_blocks.") or int(name.split(".")[2]) < n)
    }
    if set(names) != want:
        raise RuntimeError(f"state mismatch: {sorted(set(names) ^ want)[:5]}")
    vae.load_state_dict({name: mapped.tensor(name) for name in names}, strict=False, assign=True)
    for p in vae.parameters():
        p.requires_grad = False
    if hold_fp16:
        vae.prepare_decoder_autocast_weights(torch.float16)
    return _finish(vae, device, optimize)


def build_streaming(vae_dir: Path, cfg: Any, *, blocks: int | None, device: Any = "cpu", optimize: bool = False) -> Any:
    """The weight-streaming shell, built with the loader's steps; ``blocks`` truncates the streamed decoder."""
    import torch
    from phasyn_h3.recipe.abi.tensors import read_header_from_file
    from phasyn_h3.recipe.runtime.loaders import video_vae_half_plan
    from phasyn_h3.recipe.runtime.stages import vae_weight_streaming as ws
    from safetensors import safe_open
    from sglang.multimodal_gen.runtime.loader.utils import load_model_state_dict

    path = checkpoint(vae_dir)
    vae = construct_decode_half(vae_dir)
    header = read_header_from_file(path)
    half = video_vae_half_plan(header.tensors, "decode_only")
    index = ws.block_index(path, header, keep=half["keep"], num_blocks=len(vae.decoder.transformer_blocks))
    slots = ws.detach_blocks(vae, cfg)
    loaded: dict[str, Any] = {}
    with safe_open(str(path), framework="pt", device="cpu") as handle:
        for name in index.shell:
            loaded[name] = handle.get_tensor(name)
    load_model_state_dict(vae, loaded, strict=True, assign=True)
    ws.rebuild_rope_buffers(vae)
    if optimize:
        from sglang.multimodal_gen.runtime.platforms import current_platform

        with ws.blocks_attached(vae, slots):
            assert current_platform.optimize_vae(vae) is vae
    vae = _finish(vae, device, optimize=False)
    if blocks is not None:
        index = index.truncated(int(blocks))
    state = ws.WeightStreamingState(config=cfg, index=index, slots=slots, pin=torch.device(device).type == "cuda")
    ws.attach_state(vae, state)
    return vae


def load_test_latent(
    vae: Any,
    *,
    latent_path: Path | None = None,
    frames: int | None = None,
    height: int | None = None,
    width: int | None = None,
    device: Any = "cpu",
) -> Any:
    """A reverse-normalized video latent (``decode_video``'s ``_reverse_normalize_latents``): the ``video_latent`` of
    a safetensors payload at ``latent_path`` cropped to ``frames x height x width``, or seeded noise of that size."""
    import torch

    arch = vae.sglang_config.arch_config
    if latent_path is not None:
        from safetensors import safe_open

        with safe_open(str(latent_path), framework="pt", device="cpu") as fh:
            z = fh.get_tensor("video_latent")
    else:
        z = torch.randn(
            1,
            len(arch.latents_mean),
            frames or 7,
            height or 24,
            width or 40,
            generator=torch.Generator().manual_seed(0),
        )
    z = z[:, :, : frames or z.shape[2], : height or z.shape[3], : width or z.shape[4]].contiguous()
    z = z.to(device=device, dtype=torch.float32)
    mean = torch.as_tensor(tuple(arch.latents_mean), device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    std = torch.as_tensor(tuple(arch.latents_std), device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    return z * std + mean


class FrameSink:
    """``decode_video``'s ``on_frames``: revert, crop, ``(x*255).clamp(0,255).to(uint8)``; keeps the raw FP32 frames
    (``keep_raw``) and the uint8 frames on the host."""

    def __init__(self, vae: Any, *, height: int, width: int, keep_raw: bool = True) -> None:
        self.vae, self.height, self.width, self.keep_raw = vae, height, width, keep_raw
        self.raw: list[Any] = []
        self.u8: list[Any] = []

    def __call__(self, chunk: Any) -> None:
        import torch

        if self.keep_raw:
            self.raw.append(chunk.detach().to("cpu", copy=True))
        frames = self.vae.processor.revert_tensor(chunk)[..., : self.height, : self.width]
        self.u8.append((frames[0] * 255).clamp(0, 255).to(torch.uint8).permute(1, 2, 3, 0).contiguous().cpu())

    def raw_frames(self) -> Any:
        import torch

        return torch.cat(self.raw, dim=2) if self.raw else None

    def u8_frames(self) -> Any:
        import torch

        return torch.cat(self.u8, dim=0)


@contextlib.contextmanager
def decode_context(vae: Any, *, device: Any, precision: str = "fp32", streamed: bool = False) -> Any:
    """The ``with`` block of ``decode_video.run`` around ``vae.decode_base`` (fp32: tile batch 1, today's TF32 rule)."""
    import torch
    from phasyn_h3.recipe.runtime.stages.vae_fp32_accel import STRICT_FP32_CONV, fp32_decode_scope
    from phasyn_h3.recipe.runtime.stages.vae_streaming import streaming_decode_scope
    from phasyn_h3.recipe.runtime.stages.vae_weight_streaming import weight_streaming_scope
    from sglang.multimodal_gen.runtime.managers.forward_context import set_forward_context
    from sglang.multimodal_gen.runtime.models.vaes.fast_path_gate import use_vae_fast_path

    fp32 = (
        fp32_decode_scope(vae, tile_batch=1, w2_per_tile=True, strict_fp32_conv=STRICT_FP32_CONV)
        if precision == "fp32"
        else contextlib.nullcontext({})
    )
    autocast = torch.autocast("cuda", dtype=torch.float16) if precision == "fp16" else contextlib.nullcontext()
    stream = (
        weight_streaming_scope(vae, device=device, precision=precision) if streamed else contextlib.nullcontext(None)
    )
    with (
        torch.inference_mode(),
        autocast,
        use_vae_fast_path(vae, False),
        set_forward_context(current_timestep=0, attn_metadata=None),
        fp32 as accel,
        stream as weight_streaming,
        streaming_decode_scope(vae, release_clip_outputs=streamed) as streaming,
    ):
        yield {"fp32_accel": accel, "weight_streaming": weight_streaming, "streaming": streaming}


def decode(vae: Any, z: Any, *, streamed: bool = False, precision: str = "fp32", device: Any = "cpu") -> Any:
    """Raw FP32 output frames of ``decode_base(z)`` through the production decode path."""
    sink = FrameSink(vae, height=int(z.shape[-2]) * 16, width=int(z.shape[-1]) * 16)
    with decode_context(vae, device=device, precision=precision, streamed=streamed):
        vae.decode_base(z, on_frames=sink)
    return sink.raw_frames()


__all__ = [
    "NUM_BLOCKS",
    "FrameSink",
    "build_resident",
    "build_streaming",
    "checkpoint",
    "construct_decode_half",
    "decode",
    "decode_context",
    "load_test_latent",
    "vae_config",
]
