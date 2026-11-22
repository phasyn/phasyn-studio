# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/reference_encoding.py (minimax_h3_encode_reference_video_rows),
# python/sglang/multimodal_gen/runtime/models/vaes/minimax_h3_video_vae/klvae.py (encode_videos, encode_base, encode_temporal, tiled_encode),
# python/sglang/multimodal_gen/runtime/models/vaes/minimax_h3_video_vae/vae_cnn.py and conv.py (the EncoderFCN3D, ResnetBlock3D, Downsample3D and BaseConv3d forwards)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Upstream origin: the SGLang code above is itself derived from the MiniMax-H3 video VAE published by MiniMax
# (https://huggingface.co/MiniMaxAI/MiniMax-H3, revision 42ed227ee7df40d41602854ae760620d6eb651fe), whose source
# files carry "SPDX-License-Identifier: Apache-2.0" and are used here under that licence:
#   Ref2VA/video_vae/klvae.py:297 tiled_encode, :461 encode_temporal, :919 encode_videos, :1231 encode_base;
#   Ref2VA/video_vae/vae_cnn.py:177 EncoderFCN3D, :83 ResnetBlock3D, :34 Downsample3D; Ref2VA/video_vae/conv.py:12 BaseConv3d.
#   Original work by MiniMax.
# Modified by the Phasyn Studio authors: the reference video stays on the host and is converted one tile at a time; the causal encoder's high-resolution levels run a few frames per pass with a two-frame cache per temporal convolution, and its low-resolution levels run once per tile with their weights on the device only for that phase.
"""Frame-streaming reference-video encode (``provider_options.frame_streaming`` of ``h3.video_encode``; opt-in).

The MiniMax-H3 video VAE encoder (``EncoderFCN3D`` + ``quant_conv``) is causal in time: every temporal
convolution has kernel 3 with two zero frames of front padding (``BaseConv3d._apply_temporal_padding``), the
time strides of ``Downsample3D`` only look back, and every GroupNorm normalizes each frame on its own
(``TemporalIsolatedGroupNorm``).  Production encodes each 17-frame clip of each 256-pixel tile in one call: the
first level alone holds 128 channels x 17 frames x 256 x 256 FP32 per tensor (544 MiB), and one call needs about
2.5 GiB of activations next to the 0.69 GiB of FP32 encoder weights.

With the option on, the reference video goes through the same recipe in another order:

* ``minimax_h3_encode_reference_video_rows`` -> ``encode_videos`` -> ``encode_base`` -> ``encode_temporal`` ->
  ``tiled_encode`` are re-stated here with the uint8 frames kept on the host: each tile of each clip is copied
  to the device and converted there by the processor's own ``convert_numpy_to_tensor`` and ``transform_tensor``
  (element-wise, so a converted tile holds the values the converted whole video holds), instead of the whole
  video converted to FP32 on the device first;
* the encoder is split after its last time-strided downsample.  The *head* (``conv_in`` and the
  high-resolution levels: little weight, big activations) runs ``frames_per_pass`` frames at a time: every
  temporal convolution keeps the last two frames of its spatially padded input, the first pass of a tile sees
  two zero frames (the causal padding), and a time-strided convolution emits output ``o`` once input frame
  ``o * stride`` has arrived.  The *tail* (the low-resolution levels, ``norm_out``, ``conv_out``,
  ``quant_conv``: 0.65 GB of the weights, small activations) then runs once per tile on the clip's latent
  frames through the upstream module forwards themselves — the production shapes;
* per clip, the head of every tile runs first while the tail's FP32 weights wait in host memory, then the tail
  weights come back to the device and the tail runs for every tile; the weights are moved, never changed, and
  are back on the device when the call ends (also on failure or cancel);
* the tile outputs are blended by the VAE's own ``_assemble_tiles``, the clips concatenated, ``token_drop``
  applied, and the posterior sampled under the same seed-42 scoped RNG, cast to FP16, normalized and
  patchified by the pinned helpers.

Values: with 17 frames per pass (the clip length) every convolution runs on the production shapes and the
result is bit-identical to the production function; with fewer frames per pass a head convolution may
accumulate in another order for the shorter time extent (FP32 rounding only).  Tiles stay 256 / 64 (the
checkpoint's).  ``fp16`` (approximate profiles, CUDA only) evaluates the encoder with FP16 copies of its weights
made for the call and FP16 activations, with every FP32 weight in host memory meanwhile; the tile outputs are
blended in FP32.  Keyframes and reference images never come here (the stage keeps their FP32 recipe).

Every re-stated upstream function, and the per-frame norm the streaming relies on, is source-pinned
(``pins.py`` group ``vae_frame_streaming``); :func:`check_encoder` refuses any encoder this module does not
reproduce (another module type, a non-causal or non-isolated layer, stacked or parallel tiling).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from importlib import import_module
from typing import Any, NamedTuple, Self

from .. import pins
from ..errors import UnsupportedCombination


_TRIPLET_LENGTH = 3
_STRIDE_TWO = 2
_FRAME_RANK = 4
_RGB_CHANNELS = 3
_UNBATCHED_LATENT_RANK = 4
_BATCHED_LATENT_RANK = 5


STAGE_KEY = "frame_streaming"  # the encode_references stage-dict option (``H3Host.stage(options=...)``)
PRECISIONS = ("fp32", "fp16")
MIN_FRAMES_PER_PASS, MAX_FRAMES_PER_PASS = (
    1,
    17,
)  # 17 = the checkpoint's clip length: a pass never spans clips
DEFAULT_FRAMES_PER_PASS = 2
CONFIG_KEYS = frozenset({"frames_per_pass", "precision"})
# the AutoencoderKL methods this module re-states: the loaded VAE must use the pinned class methods unchanged
RESTATED_METHODS = (
    "encode_videos",
    "encode_base",
    "encode_temporal",
    "tiled_encode",
    "_adaptive_encode",
    "encode",
)


def check_sources() -> None:
    """The re-stated SGLang functions are the pinned ones, else UPSTREAM_PATCH_SOURCE_MISMATCH."""
    pins.check("vae_frame_streaming", what="frame streaming ")


def _invalid(message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(
        "FRAME_STREAMING_INVALID",
        message,
        field_path="provider_options.frame_streaming",
        **kwargs,
    )


def _unsupported(message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination("FRAME_STREAMING_UNSUPPORTED_VAE", message, **kwargs)


# ---------------------------------------------------------------------------- configuration (torch-free)
@dataclass(frozen=True)
class FrameStreamingConfig:
    """The resolved option (``phasyn_h3.config.frame_streaming_settings`` builds it from provider_options)."""

    frames_per_pass: int = DEFAULT_FRAMES_PER_PASS
    precision: str = "fp32"

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> FrameStreamingConfig:
        """Validate the settings supplied for this streaming policy."""
        if not isinstance(raw, Mapping):
            raise _invalid("frame_streaming 必須是 object")
        unknown = sorted(set(raw) - CONFIG_KEYS)
        if unknown:
            raise _invalid(f"frame_streaming 不認得的欄位 {unknown}")
        frames = raw.get("frames_per_pass", DEFAULT_FRAMES_PER_PASS)
        precision = raw.get("precision", "fp32")
        if (
            type(frames) is not int
            or not MIN_FRAMES_PER_PASS <= frames <= MAX_FRAMES_PER_PASS
        ):
            raise _invalid(
                f"frame_streaming.frames_per_pass 必須是 {MIN_FRAMES_PER_PASS}..{MAX_FRAMES_PER_PASS} 的整數",
                actual=frames,
            )
        if precision not in PRECISIONS:
            raise _invalid(
                f"frame_streaming.precision 必須是 {'／'.join(PRECISIONS)}",
                actual=precision,
            )
        return cls(frames_per_pass=int(frames), precision=str(precision))

    def as_dict(self) -> dict[str, Any]:
        """Serialize the resolved values used by the runtime."""
        return {"frames_per_pass": self.frames_per_pass, "precision": self.precision}


def stage_config(stage: Mapping[str, Any]) -> FrameStreamingConfig | None:
    """The stage's ``frame_streaming`` option, or None (absent: the production encode runs unchanged)."""
    raw = stage.get(STAGE_KEY)
    return None if raw is None else FrameStreamingConfig.from_mapping(raw)


def check_precision(config: FrameStreamingConfig | None, policy_dtype: str) -> None:
    """The streamed precision must be the video VAE's resolved compute dtype; only streaming implements fp16."""
    if config is None:
        if policy_dtype != "fp32":
            raise UnsupportedCombination(
                "VAE_FP16_ENCODE_NEEDS_FRAME_STREAMING",
                f"video_vae compute_dtype={policy_dtype} 的 encode 只有 frame_streaming 實作；其他 encode 一律 FP32",
                field_path="components.video_vae.compute_dtype",
            )
        return
    if config.precision != policy_dtype:
        raise _invalid(
            f"frame_streaming.precision={config.precision} 與 video_vae compute_dtype={policy_dtype} 不同",
            expected=policy_dtype,
            actual=config.precision,
        )


# ---------------------------------------------------------------------------- encoder structure
def _is_pointwise(module: Any) -> bool:
    return (
        tuple(module.kernel_size) == (1, 1, 1)
        and tuple(module.stride) == (1, 1, 1)
        and tuple(module.padding) == (0, 0, 0)
        and tuple(module.dilation) == (1, 1, 1)
        and int(module.groups) == 1
    )


def _is_causal_temporal(module: Any) -> bool:
    kt = int(module.kernel_size[0])
    pt = int(module.padding[0])
    return (
        bool(module.causal)
        and module.pad_mode_t == "constant"
        and pt >= 1
        and kt == 2 * pt + 1
        and tuple(module.dilation) == (1, 1, 1)
        and int(module.groups) == 1
    )


def tail_start(encoder: Any) -> int:
    """The first level of the one-shot tail: the level after the last time-strided downsample (0: none)."""
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.vae_cnn import (  # type: ignore[import-untyped]
        Downsample3D,
    )

    start = 0
    for i_level in range(encoder.num_levels):
        ds = getattr(encoder.down[i_level], "downsample", None)
        if isinstance(ds, Downsample3D) and int(ds.time_stride) > 1:
            start = i_level + 1
    return start


def check_encoder(vae: Any) -> dict[str, Any]:
    """Refuse (``FRAME_STREAMING_UNSUPPORTED_VAE``) unless the loaded VAE is the encoder this module reproduces.

    Returns the structure facts (convolution counts, the tail's first level) for the stage record.
    """
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.conv import (  # type: ignore[import-untyped]
        BaseConv3d,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import (  # type: ignore[import-untyped]
        AutoencoderKLLegacy,
        get_tile_parallel_state,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.norm import (  # type: ignore[import-untyped]
        TemporalIsolatedGroupNorm,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.vae_cnn import (
        Downsample3D,
        EncoderFCN3D,
        ResnetBlock3D,
    )
    from torch import nn

    _check_encoder_architecture(vae, AutoencoderKLLegacy, get_tile_parallel_state)
    encoder = vae.encoder
    if (
        not isinstance(encoder, EncoderFCN3D)
        or encoder.use_fused_norm
        or hasattr(encoder, "loss_info")
    ):
        raise _unsupported("串流編碼只支援非 fused norm 的 EncoderFCN3D")
    quant = vae.quant_conv
    if (
        type(quant) is not nn.Conv3d
        or not _is_pointwise(quant)
        or quant.padding_mode != "zeros"
    ):
        raise _unsupported("quant_conv 必須是 1x1x1 的 nn.Conv3d")
    allowed = (
        EncoderFCN3D,
        ResnetBlock3D,
        Downsample3D,
        BaseConv3d,
        TemporalIsolatedGroupNorm,
    )
    pointwise, temporal = _check_encoder_modules(
        _CheckEncoderModulesInputs(encoder, allowed)
    )
    return {
        "temporal_convs": temporal,
        "pointwise_convs": pointwise,
        "tail_start_level": tail_start(encoder),
    }


# ---------------------------------------------------------------------------- weight residency
class _ParkedParams:
    """The FP32 parameters of some modules, moved to host memory while a phase does not use them.

    The first :meth:`park` copies each parameter to the host and keeps that copy for the call; later parks only
    drop the device copy, :meth:`restore` copies the host copy back (exact copies both ways).  The tensors are
    made outside inference mode, so the parameters stay ordinary tensors, as loaded.
    """

    def __init__(self, modules: Iterable[Any], device: Any) -> None:
        seen: set[int] = set()
        self.params: list[Any] = []
        for module in modules:
            for param in module.parameters():
                if id(param) not in seen:
                    seen.add(id(param))
                    self.params.append(param)
        self.device = device
        self.bytes = sum(int(p.numel()) * int(p.element_size()) for p in self.params)
        self._host: dict[int, Any] = {}
        self._parked: set[int] = set()
        self.seconds = 0.0
        self.h2d_bytes = 0
        self.d2h_bytes = 0

    def park(self, params: Iterable[Any] | None = None) -> None:
        import torch

        started = time.perf_counter()
        with torch.inference_mode(mode=False), torch.no_grad():
            for param in self.params if params is None else params:
                key = id(param)
                if key in self._parked:
                    continue
                if key not in self._host:
                    self._host[key] = param.data.to("cpu", copy=True)
                    self.d2h_bytes += int(param.numel()) * int(param.element_size())
                param.data = self._host[key]
                self._parked.add(key)
        self.seconds += time.perf_counter() - started

    def restore(self) -> None:
        import torch

        if not self._parked:
            return
        started = time.perf_counter()
        with torch.inference_mode(mode=False), torch.no_grad():
            for param in self.params:
                key = id(param)
                if key in self._parked:
                    param.data = self._host[key].to(self.device)
                    self._parked.discard(key)
                    self.h2d_bytes += int(param.numel()) * int(param.element_size())
        if getattr(self.device, "type", None) == "cuda":
            torch.cuda.synchronize(self.device)
        self.seconds += time.perf_counter() - started

    def release(self) -> None:
        """Back on the device, host copies dropped (the end of a call)."""
        self.restore()
        self._host.clear()

    def facts(self) -> dict[str, Any]:
        return {
            "parked_bytes": int(self.bytes),
            "d2h_bytes": int(self.d2h_bytes),
            "h2d_bytes": int(self.h2d_bytes),
            "transfer_seconds": round(self.seconds, 6),
        }


# ---------------------------------------------------------------------------- streamed encoder
class CausalStreamEncoder:
    """``quant_conv(encoder(x))`` of one tile as a streamed head and a one-shot tail (module docstring).

    Use as a context manager around one video: on exit every FP32 weight is back on the device.  Inputs of the
    streamed head travel in one-element lists that the callee empties, so a pass tensor is freed as soon as its
    last consumer is done (a plain argument stays referenced by the caller's frame for the whole call); that only
    changes when memory is released, never a value.
    """

    def __init__(self, vae: Any, *, dtype: Any, device: Any) -> None:
        """Prepare the VAE encoder for bounded frame streaming."""
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.conv import (
            BaseConv3d,
        )
        from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.vae_cnn import (
            Downsample3D,
        )

        encoder = vae.encoder
        self.encoder = encoder
        self.quant_conv = vae.quant_conv
        self.split = tail_start(encoder)
        head = [encoder.conv_in, *(encoder.down[i] for i in range(self.split))]
        tail = [
            *(encoder.down[i] for i in range(self.split, encoder.num_levels)),
            encoder.norm_out,
            encoder.conv_out,
            vae.quant_conv,
        ]
        self._downsample_cls = Downsample3D
        self._pointwise_ids = {
            id(m)
            for m in encoder.modules()
            if isinstance(m, BaseConv3d) and _is_pointwise(m)
        } | {id(vae.quant_conv)}
        self._state: dict[int, tuple[Any, int]] = {}
        self.passes = 0
        self.dtype = dtype
        # the weights' own dtype (FP32 as loaded): the tail's weights leave the device during each clip's head phase;
        # another compute dtype (fp16): the call runs on copies in that dtype and every weight stays in host memory
        self.native = dtype == next(encoder.parameters()).dtype
        self.parking = _ParkedParams(tail if self.native else [*head, *tail], device)
        self._half: dict[int, Any] | None = None
        self.weight_copy_bytes = 0

    def __enter__(self) -> Self:
        """Enter the scope that owns the runtime resources."""
        if not self.native:
            self._half = {}
            try:
                for param in (
                    self.parking.params
                ):  # one parameter at a time: the copy, then the weight to the host
                    self._half[id(param)] = param.detach().to(self.dtype)
                    self.weight_copy_bytes += int(param.numel()) * int(
                        self._half[id(param)].element_size()
                    )
                    self.parking.park([param])
            except BaseException:  # __exit__ does not run for a failed __enter__: put every weight back here
                self._half = None
                self.parking.release()
                raise
        return self

    def __exit__(self, *exc: object) -> None:
        """Release the resources owned by this scope."""
        self._half = None
        self._state = {}
        self.parking.release()

    def head_phase(self) -> None:
        """Before the heads of a clip: the tail's weights to the host (fp16: every weight is there already)."""
        if self.native:
            self.parking.park()

    def tail_phase(self) -> None:
        """Before the tails of a clip: the tail's weights back on the device (fp16: the copies are in use)."""
        if self.native:
            self.parking.restore()

    # -- operators ------------------------------------------------------------------
    def _weights(self, module: Any) -> tuple[Any, Any]:
        if self._half is None:
            return module.weight, module.bias
        return self._half[
            id(module.weight)
        ], None if module.bias is None else self._half[id(module.bias)]

    def _call(self, module: Any, x: Any) -> Any:
        """The upstream module's own forward, with the call's weights (fp16: the FP16 copies)."""
        if self._half is None:
            return module(x)
        from torch.func import functional_call

        params = {name: self._half[id(p)] for name, p in module.named_parameters()}
        return functional_call(module, params, (x,))

    def _pointwise(self, module: Any, x: Any) -> Any:
        """``nn.Conv3d.forward`` of a 1x1x1 convolution (``BaseConv3d.forward`` with zero padding calls it)."""
        weight, bias = self._weights(module)
        return module._conv_forward(x, weight, bias)

    def _conv(self, module: Any, holder: list[Any]) -> Any:
        """``BaseConv3d.forward`` on the frames of this pass; None when a time-strided convolution emits nothing."""
        import torch
        from torch.nn import functional

        x = holder.pop()
        if id(module) in self._pointwise_ids:
            return self._pointwise(module, x)
        pt, ph, pw = (int(p) for p in module.padding)
        n_in = int(x.shape[2])
        xs = functional.pad(
            x, (pw, pw, ph, ph, 0, 0), mode=module.pad_mode
        )  # _apply_padding: space first
        del x
        pad_t = (
            2 * pt
        )  # _apply_temporal_padding (causal): 2·padding_t = kernel_t - 1 zero frames in front
        state = self._state.pop(id(module), None)
        if state is None:
            cache = xs.new_zeros(
                (xs.shape[0], xs.shape[1], pad_t, xs.shape[3], xs.shape[4])
            )
            seen = 0
        else:
            cache, seen = state
        del state
        seq = torch.cat(
            [cache, xs], dim=2
        )  # input frames seen - pad_t .. seen + n_in - 1
        del cache, xs
        end = seen + n_in
        stride_t = int(module.stride[0])
        kernel_t = int(module.kernel_size[0])
        self._state[id(module)] = (seq[:, :, -pad_t:].clone(), end)
        first = -(
            -seen // stride_t
        )  # outputs whose last input frame (o * stride_t) arrived in this pass
        last = (end - 1) // stride_t
        if last < first:
            return None
        start = first * stride_t - seen
        window = seq[:, :, start : start + (last - first) * stride_t + kernel_t]
        del seq
        weight, bias = self._weights(module)
        return functional.conv3d(
            window,
            weight,
            bias,
            stride=module.stride,
            padding=0,
            dilation=module.dilation,
        )

    def _block(self, block: Any, holder: list[Any]) -> Any:
        """``ResnetBlock3D.forward`` (``zq`` None, unfused norms): norm_silu, conv1, norm_silu, conv2, shortcut."""
        from torch.nn import functional

        x = holder.pop()
        h = self._conv(
            block.conv1, [functional.silu(self._call(block.norm1, x), inplace=True)]
        )
        hold = [functional.silu(self._call(block.norm2, h), inplace=True)]
        del h
        h = self._conv(block.conv2, hold)
        if block.in_channels != block.out_channels:
            x = self._pointwise(block.nin_shortcut, x)
        return h.add_(x)

    def _head_pass(self, x: Any) -> Any:
        """``EncoderFCN3D.forward`` up to the tail on the frames of one pass (None: no output frame yet)."""
        from torch.nn import functional

        self.passes += 1
        encoder = self.encoder
        h = self._conv(encoder.conv_in, [x])
        for i_level in range(self.split):
            down = encoder.down[i_level]
            for i_block in range(encoder.num_res_blocks[i_level]):
                if h is None:
                    return None
                hold = [h]
                del h
                h = self._block(down.block[i_block], hold)
            if hasattr(down, "downsample"):
                if h is None:
                    return None
                ds = down.downsample
                if isinstance(
                    ds, self._downsample_cls
                ):  # Downsample3D.forward: (0,1,0,1) pad for space stride 2
                    hold = [
                        functional.pad(h, (0, 1, 0, 1, 0, 0), mode=ds.pad_mode)
                        if ds.space_stride == _STRIDE_TWO
                        else h
                    ]
                    del h
                    h = self._conv(ds.conv, hold)
                else:
                    hold = [h]
                    del h
                    h = self._conv(ds, hold)
        return h

    def head(self, x: Any, frames_per_pass: int) -> Any:
        """The head output of one tile ``[1, 3, t, h, w]``: every frame of it, passes concatenated in time."""
        import torch

        self._state = {}
        outs = []
        try:
            for t0 in range(0, int(x.shape[2]), frames_per_pass):
                out = self._head_pass(x[:, :, t0 : t0 + frames_per_pass])
                if out is not None:
                    outs.append(out)
        finally:
            self._state = {}
        return torch.cat(outs, dim=2)

    def tail(self, h: Any) -> Any:
        """The rest of ``EncoderFCN3D.forward`` and ``quant_conv`` in one go, with the upstream modules."""
        from torch.nn import functional

        encoder = self.encoder
        for i_level in range(self.split, encoder.num_levels):
            down = encoder.down[i_level]
            for i_block in range(encoder.num_res_blocks[i_level]):
                h = self._call(down.block[i_block], h)
            if hasattr(down, "downsample"):
                h = self._call(down.downsample, h)
        h = functional.silu(
            self._call(encoder.norm_out, h), inplace=True
        )  # norm_silu(h, norm_out)
        h = self._call(encoder.conv_out, h)
        return self._call(self.quant_conv, h)


# ---------------------------------------------------------------------------- the reference-video recipe
def _crop_origin(
    processor: Any, height: int, width: int, new_h: int, new_w: int
) -> tuple[int, int]:
    """``VAEProcessor._crop_to_align``'s top-left corner (``crop_mode`` center or top_left)."""
    if processor.crop_mode == "center":
        return (height - new_h) // 2, (width - new_w) // 2
    return 0, 0


def _tile_grid(
    vae: Any, height: int, width: int
) -> tuple[list[Any], list[Any], list[int], list[int]]:
    """``tiled_encode``'s rows, columns and pixel overlaps (one tile when encoder tiling is off)."""
    if not vae.encoder_tiling:
        return [(0, height)], [(0, width)], [], []
    y_idx, y_len, y_overlap = vae.split_tiles(height, is_decoder=False)
    x_idx, x_len, x_overlap = vae.split_tiles(width, is_decoder=False)
    return (
        list(zip(y_idx, y_len, strict=True)),
        list(zip(x_idx, x_len, strict=True)),
        list(y_overlap),
        list(x_overlap),
    )


def stream_moments(
    vae: Any,
    frames: Any,
    config: FrameStreamingConfig,
    *,
    device: Any,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[Any, dict[str, Any]]:
    """``encode_videos`` -> ``encode_base`` -> ``encode_temporal`` moments of ``[T,H,W,3]`` uint8 host frames.

    Returns the FP32 moments ``[1, 2·latent_channels, T', H/16, W/16]`` on ``device`` (before the posterior sample)
    and the facts of the run.
    """
    np = import_module("numpy")
    import torch

    processor = vae.processor
    used = processor.get_suitable_video_length(
        int(frames.shape[0])
    )  # raises for a too-short video, like upstream
    height, width = int(frames.shape[1]), int(frames.shape[2])
    new_h, new_w = processor._align_to_total_patch_size(height, width)
    top, left = _crop_origin(processor, height, width, new_h, new_w)
    frames = frames[:used, top : top + new_h, left : left + new_w]
    rows_at, cols_at, y_overlap, x_overlap = _tile_grid(vae, new_h, new_w)
    latent_y_overlap = [o // vae.vae_ratio for o in y_overlap]
    latent_x_overlap = [o // vae.vae_ratio for o in x_overlap]
    # the encoder's compute dtype: its weights' own (FP32 as loaded) unless the call asks for fp16
    dtype = (
        torch.float16
        if config.precision == "fp16"
        else next(vae.encoder.parameters()).dtype
    )
    clip_length = int(vae.clip_length)
    pad_size = (
        -used
    ) % clip_length  # encode_temporal: offset_frame 0 (no isolated first frame)
    num_clips = (used + pad_size) // clip_length
    clip_seconds: list[float] = []
    clips = []
    streamer = CausalStreamEncoder(vae, dtype=dtype, device=device)
    with streamer:
        for i in range(num_clips):
            started = time.perf_counter()
            clip_u8 = _clip_frames(i, clip_length, frames, used, np)
            heads = _encode_tile_heads(
                _EncodeTileHeadsInputs(
                    streamer,
                    rows_at,
                    cols_at,
                    check_cancel,
                    np,
                    clip_u8,
                    processor,
                    device,
                    dtype,
                    config,
                )
            )
            streamer.tail_phase()
            grid = []
            for row in heads:
                out_row = []
                while row:
                    moments = streamer.tail(row.pop(0))
                    out_row.append(
                        moments.float() if moments.dtype == torch.float16 else moments
                    )  # blend >= FP32
                    del moments
                grid.append(out_row)
            del heads
            if not vae.encoder_tiling:
                clips.append(
                    grid[0][0]
                )  # _adaptive_encode without tiling: encode(x) itself
            else:
                clips.append(
                    vae._assemble_tiles(grid, latent_y_overlap, latent_x_overlap)
                )
            del grid
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            clip_seconds.append(round(time.perf_counter() - started, 6))
    moments = torch.cat(clips, dim=2)
    del clips
    if vae.token_drop > 0:
        moments = moments[:, :, : -vae.token_drop]
    if not bool(torch.isfinite(moments).all()):
        raise UnsupportedCombination(
            "FRAME_STREAMING_NONFINITE",
            f"串流編碼的 moments 含有非有限值（precision={config.precision}）；不輸出",
            field_path="provider_options.frame_streaming.precision",
        )
    facts = {
        **config.as_dict(),
        "frames": int(used),
        "crop": [int(top), int(left), int(new_h), int(new_w)],
        "clips": int(num_clips),
        "tiles_per_clip": len(rows_at) * len(cols_at),
        "head_passes": int(streamer.passes),
        "clip_seconds": clip_seconds,
        "input_conversion": "per tile on the device (uint8 frames stay on the host)",
        "fp16_weight_copy_bytes": int(streamer.weight_copy_bytes),
        "weights_in_host_memory": streamer.parking.facts(),
    }
    return moments, facts


def stream_reference_video_rows(
    video_vae: Any,
    frames: Any,
    arch_config: Any,
    config: FrameStreamingConfig,
    *,
    check_cancel: Callable[[], None] | None = None,
) -> tuple[Any, int, int, int, dict[str, Any]]:
    """``minimax_h3_encode_reference_video_rows`` with the streamed moments (module docstring).

    Returns (rows ``[n, 96]`` FP32 CPU, latent_t, latent_h, latent_w, facts).
    """
    np = import_module("numpy")
    import torch
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import (
        DiagonalGaussianDistribution,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.keyframe_encoding import (  # type: ignore[import-untyped]
        _cached_latent_mean_std,
        minimax_h3_scoped_encode_rng,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (  # type: ignore[import-untyped]
        minimax_h3_patchify_video_latent,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (  # type: ignore[import-untyped]
        MINIMAX_H3_REFERENCE_VIDEO_ENCODE_SEED,
        MINIMAX_H3_REFERENCE_VIDEO_PATCH_SIZE,
    )

    check_sources()
    structure = check_encoder(video_vae)
    frames = np.asarray(frames)
    if (
        frames.ndim != _FRAME_RANK
        or int(frames.shape[-1]) != _RGB_CHANNELS
        or frames.dtype != np.uint8
        or int(frames.shape[0]) <= 0
    ):
        raise ValueError(
            "reference-video frames must be non-empty [T,H,W,3] uint8, got "
            f"shape={list(frames.shape)}, dtype={frames.dtype}"
        )
    parameter = next(video_vae.parameters())
    if (
        parameter.dtype != torch.float32
    ):  # the stage runs inside minimax_h3_scoped_encode_fp32
        raise _unsupported(
            f"video VAE 權重是 {parameter.dtype}；串流編碼需要 FP32 常駐權重"
        )
    device = parameter.device
    if config.precision == "fp16" and device.type != "cuda":
        raise _invalid(
            "frame_streaming fp16 只在 CUDA 上（CPU 不跑 FP16 卷積）",
            actual=device.type,
        )
    with (
        torch.inference_mode(),
        minimax_h3_scoped_encode_rng(MINIMAX_H3_REFERENCE_VIDEO_ENCODE_SEED, device),
    ):
        moments, facts = stream_moments(
            video_vae, frames, config, device=device, check_cancel=check_cancel
        )
        z = DiagonalGaussianDistribution(
            moments
        ).sample()  # the posterior sample, same seed-42 CPU draw
        del moments
        z = (
            z.squeeze(0).contiguous().to(torch.float16)
        )  # encode_videos: one video, use_fp16_latent
    z = z.cpu().float()
    if z.dim() == _UNBATCHED_LATENT_RANK:
        z = z[None]
    latent_channels = arch_config.latent_channels
    if z.dim() != _BATCHED_LATENT_RANK or int(z.shape[1]) != latent_channels:
        raise ValueError(f"unexpected reference video latent shape {list(z.shape)}")
    latent_t, latent_h, latent_w = int(z.shape[2]), int(z.shape[3]), int(z.shape[4])
    mean, std = _cached_latent_mean_std(
        tuple(arch_config.latents_mean),
        tuple(arch_config.latents_std),
        (1, latent_channels, 1, 1, 1),
    )
    z.sub_(mean).div_(std)
    rows = minimax_h3_patchify_video_latent(
        z, patch_size=list(MINIMAX_H3_REFERENCE_VIDEO_PATCH_SIZE)
    )
    facts.update(structure)
    facts["cudnn_allow_tf32"] = bool(torch.backends.cudnn.allow_tf32)
    return rows.to(torch.float32), latent_t, latent_h, latent_w, facts


__all__ = [
    "DEFAULT_FRAMES_PER_PASS",
    "MAX_FRAMES_PER_PASS",
    "MIN_FRAMES_PER_PASS",
    "PRECISIONS",
    "STAGE_KEY",
    "CausalStreamEncoder",
    "FrameStreamingConfig",
    "check_encoder",
    "check_precision",
    "check_sources",
    "stage_config",
    "stream_moments",
    "stream_reference_video_rows",
    "tail_start",
]


def _check_encoder_architecture(
    vae: Any, autoencoder_cls: Any, get_tile_parallel_state: Any
) -> None:
    if not isinstance(vae, autoencoder_cls):
        raise _unsupported(
            f"video VAE 是 {type(vae).__name__}，不是釘版的 AutoencoderKLLegacy"
        )
    for name in RESTATED_METHODS:
        if name in vars(vae) or getattr(type(vae), name) is not getattr(
            autoencoder_cls, name
        ):
            raise _unsupported(
                f"video VAE 的 {name} 被覆寫；串流編碼只重述釘版的 {name}"
            )
    if vae.training or not vae.use_3d_conv:
        raise _unsupported("串流編碼需要 eval 模式、use_3d_conv 的 video VAE")
    if vae.isolated_first_frame or vae.isolated_key_frame or vae.isolated_last_frame:
        raise _unsupported(
            "串流編碼不支援 isolated first／key／last frame 的 encode_temporal"
        )
    if vae.stack_tiling or tuple(get_tile_parallel_state()) != (0, 1):
        raise _unsupported(
            "串流編碼只重述逐 tile、單一 rank 的 tiled_encode（stack_tiling／parallel tile 不支援）"
        )
    if int(vae.clip_length) == _TRIPLET_LENGTH:
        raise _unsupported("clip_length=3 時 transform_tensor 會轉置 [T,C,H,W]；不支援")


class _CheckEncoderModulesInputs(NamedTuple):
    encoder: Any
    allowed: Any


def _check_encoder_modules(inputs: _CheckEncoderModulesInputs) -> tuple[Any, Any]:
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.conv import (
        BaseConv3d,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.norm import (
        TemporalIsolatedGroupNorm,
    )
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.vae_cnn import (
        ResnetBlock3D,
    )
    from torch import nn

    encoder, allowed = inputs
    pointwise = temporal = 0
    for module in encoder.modules():
        if type(module) is nn.Module or isinstance(module, nn.ModuleList):
            continue  # the per-level ``down`` containers and their block lists
        if not isinstance(module, allowed):
            raise _unsupported(
                f"encoder 含有串流編碼不重述的模組 {type(module).__name__}"
            )
        _check_residual_norm(module, ResnetBlock3D, TemporalIsolatedGroupNorm)
        if isinstance(module, BaseConv3d):
            if _is_pointwise(module):
                pointwise += 1
            elif _is_causal_temporal(module):
                temporal += 1
            else:
                raise _unsupported(
                    "encoder 的 BaseConv3d 不是 1x1x1，也不是因果時間卷積（kernel_t=2·padding_t+1、constant）",
                    actual=f"kernel={tuple(module.kernel_size)} padding={tuple(module.padding)}",
                )
    if type(encoder.norm_out) is not TemporalIsolatedGroupNorm:
        raise _unsupported("norm_out 不是逐格的 TemporalIsolatedGroupNorm")
    return pointwise, temporal


def _clip_frames(i: Any, clip_length: Any, frames: Any, used: Any, np: Any) -> Any:
    start, end = i * clip_length, (i + 1) * clip_length
    clip_u8 = frames[start : min(end, used)]
    if (
        end > used
    ):  # the last clip repeats the last frame (encode_temporal's expand + cat)
        clip_u8 = np.concatenate(
            [clip_u8, np.repeat(frames[used - 1 : used], end - used, axis=0)],
            axis=0,
        )
    return clip_u8


class _EncodeTileHeadsInputs(NamedTuple):
    streamer: Any
    rows_at: Any
    cols_at: Any
    check_cancel: Callable[[], None] | None
    np: Any
    clip_u8: Any
    processor: Any
    device: Any
    dtype: Any
    config: FrameStreamingConfig


def _encode_tile_heads(inputs: _EncodeTileHeadsInputs) -> Any:
    (
        streamer,
        rows_at,
        cols_at,
        check_cancel,
        np,
        clip_u8,
        processor,
        device,
        dtype,
        config,
    ) = inputs
    streamer.head_phase()
    heads = []
    for i_pos, i_len in rows_at:
        row = []
        for j_pos, j_len in cols_at:
            if check_cancel is not None:
                check_cancel()
            tile_u8 = np.ascontiguousarray(
                clip_u8[:, i_pos : i_pos + i_len, j_pos : j_pos + j_len]
            )
            x = processor.convert_numpy_to_tensor(
                tile_u8, device
            )  # uint8 to the device, then FP32 / 255
            x = processor.transform_tensor(
                x, runtime_owned=True
            )  # the imagenet Normalize
            x = x.transpose(0, 1).unsqueeze(0)  # encode_videos' [1, 3, t, h, w]
            if (
                x.dtype != dtype
            ):  # fp16 (production converts to the FP32 the weights have)
                x = x.to(dtype)
            row.append(streamer.head(x, config.frames_per_pass))
            del x
        heads.append(row)
    return heads


def _check_residual_norm(
    module: Any, residual_block_cls: Any, temporal_group_norm_cls: Any
) -> None:
    if isinstance(module, residual_block_cls):
        if module.use_fused_norm:
            raise _unsupported(
                "ResnetBlock3D 用了 fused norm；串流編碼只重述 norm_silu 路徑"
            )
        for norm in (module.norm1, module.norm2):
            if type(norm) is not temporal_group_norm_cls:
                raise _unsupported(
                    "ResnetBlock3D 的 norm 不是逐格的 TemporalIsolatedGroupNorm"
                )
