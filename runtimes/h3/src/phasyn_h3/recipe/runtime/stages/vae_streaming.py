# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/models/vaes/minimax_h3_video_vae/klvae.py, AutoencoderKL._decode_temporal_streaming),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Upstream origin: the SGLang code above is itself derived from the MiniMax-H3 video VAE published by MiniMax
# (https://huggingface.co/MiniMaxAI/MiniMax-H3, revision 42ed227ee7df40d41602854ae760620d6eb651fe), whose source
# files carry "SPDX-License-Identifier: Apache-2.0" and are used here under that licence:
#   Ref2VA/video_vae/klvae.py:571 AutoencoderKL._decode_temporal_streaming. Original work by MiniMax.
# Modified by the Phasyn Studio authors: callback-only output: decoded chunks go to a sink instead of one full-size output buffer.
"""Callback-only temporal VAE decode, bounded to the current clip and overlap.

The pinned upstream streaming path still allocates the complete FP32 video.
Our stage consumes each final chunk synchronously and discards decode_base's
return value. Keep the same clip order, blend operations and frame-plan checks,
but skip that redundant allocation. All wrappers are instance-local, source
pinned and restored on success, cancellation or failure. Tensor-returning calls
without a callback retain the original behavior.

``release_clip_outputs`` (on for the weight-streaming decode only): the view of the
last temporal split (``clip_dec_chunk``) keeps the whole decoded clip alive while
the next clip decodes, i.e. two clip outputs at once (+302 MiB FP32 at 1280x736);
with the flag that last reference is dropped at the end of each clip. Nothing reads
it again, so only memory changes, never a value.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from .. import pins


def check_sources(vae: Any) -> None:
    """The loaded VAE's own methods are the pinned ones (``pins.py``), else UPSTREAM_PATCH_SOURCE_MISMATCH."""
    pins.check("vae_callback_decode", what="callback-only decode ", owner=vae)


@contextlib.contextmanager
def streaming_decode_scope(vae: Any, *, release_clip_outputs: bool = False) -> Iterator[dict[str, Any]]:
    """Use bounded output only when decode_base is called with a synchronous sink.

    ``release_clip_outputs``: drop each clip's decoded output before the next clip decodes (module docstring)."""
    from sglang.multimodal_gen.runtime.models.vaes.minimax_h3_video_vae.klvae import _resolve_temporal_stream_cat

    if vae.training or not _resolve_temporal_stream_cat():
        # Preserve upstream's supported full-cat fallback and its rollback switch.
        yield {"output_buffer": "upstream", "callback_only_enabled": False}
        return
    check_sources(vae)
    names = ("decode_base", "_decode_temporal_streaming")
    saved = {name: vae.__dict__[name] for name in names if name in vae.__dict__}
    original_base = vae.decode_base
    original_stream = vae._decode_temporal_streaming

    def decode_base(z, frame_num=None, process_image=False, on_frames=None):
        if on_frames is None:
            return original_base(z, frame_num=frame_num, process_image=process_image)
        if process_image or not vae.use_3d_conv or frame_num is not None:
            raise ValueError("on_frames needs an untrimmed temporal video decode")
        # Upstream trim_output(recon, recon.shape[2]) is a no-op for this branch.
        return vae.decode_temporal(z, on_frames=on_frames)

    def stream(z, z_head, z_tail, num_chunks, pad_tokens, temporal_cat_dtype, on_frames):
        if on_frames is None:
            return original_stream(z, z_head, z_tail, num_chunks, pad_tokens, temporal_cat_dtype, None)
        return _stream_to_sink(
            vae,
            z,
            z_head,
            z_tail,
            num_chunks,
            pad_tokens,
            temporal_cat_dtype,
            on_frames,
            release_clip_outputs=release_clip_outputs,
        )

    facts: dict[str, Any] = {"output_buffer": "callback_only", "full_video_buffer_allocated": False}
    if release_clip_outputs:
        facts["clip_output_released_before_next_clip"] = True
    try:
        vae.decode_base = decode_base
        vae._decode_temporal_streaming = stream
        yield facts
    finally:
        for name in names:
            if name in saved:
                setattr(vae, name, saved[name])
            else:
                delattr(vae, name)


def _stream_to_sink(
    self, z, z_head, z_tail, num_chunks, pad_tokens, temporal_cat_dtype, on_frames, *, release_clip_outputs=False
):
    import torch

    total_frames, pad_frames, output_frames = self._decode_temporal_output_frame_plan(
        z, z_head, z_tail, num_chunks, pad_tokens
    )
    if output_frames <= 0:
        raise ValueError(
            f"decode_temporal streaming planned non-positive output_frames={output_frames} "
            f"total_frames={total_frames} pad_frames={pad_frames}"
        )

    chunk_dec = self.tokens_chunk_size * self.vae_ratio_t
    split_count = int(self.token_drop > 0) + 1
    dec_overlap = None
    write_pos = 0
    logical_frames = 0
    dropped_frames = 0

    def write_part(part):
        nonlocal write_pos, logical_frames, dropped_frames
        part_frames = int(part.shape[2])
        if part_frames <= 0:
            return
        logical_frames += part_frames
        remaining = output_frames - write_pos
        copy_frames = min(part_frames, max(0, remaining))
        if copy_frames > 0:
            # The sink consumes this view synchronously before the next clip.
            # No full-video allocation or extra GPU copy is needed.
            on_frames(part[:, :, :copy_frames, :, :])
            write_pos += copy_frames
        dropped_frames += part_frames - copy_frames

    for i in range(num_chunks):
        t_start_idx = i * self.tokens_chunk_size
        t_end_idx = t_start_idx + self.tokens_chunk_size + self.token_overlap
        clip_z = z[:, :, t_start_idx:t_end_idx, :, :]

        if i == 0 and z_head is not None:
            clip_z = torch.cat([z_head, clip_z], dim=2)

        if i == num_chunks - 1 and z_tail is not None:
            clip_z = torch.cat([clip_z, z_tail], dim=2)

        clip_dec = self._adaptive_decode(clip_z)
        if temporal_cat_dtype is not None and clip_dec.dtype != temporal_cat_dtype:
            clip_dec = clip_dec.to(temporal_cat_dtype)
        if clip_dec.device != z.device:
            clip_dec = clip_dec.to(z.device)

        dec_tail = None
        if i == 0 and z_head is not None:
            write_part(clip_dec[:, :, self.vae_ratio_t - 1 : self.vae_ratio_t, :, :])
            clip_dec = clip_dec[:, :, self.vae_ratio_t :, :, :]

        if i == num_chunks - 1 and z_tail is not None:
            dec_tail = clip_dec[:, :, -1:, :, :]
            clip_dec = clip_dec[:, :, : -self.vae_ratio_t, :, :]

        for j in range(split_count):
            f_start_idx = j * chunk_dec
            f_end_idx = min(f_start_idx + chunk_dec, clip_dec.shape[2])
            clip_dec_chunk = clip_dec[:, :, f_start_idx:f_end_idx, :, :]
            clip_dec_chunk = clip_dec_chunk[:, :, self.frame_pre_padding :, :, :]

            if j == 0:
                if dec_overlap is not None:
                    clip_dec_chunk = self.blend(dec_overlap, clip_dec_chunk, self.frame_overlap, dim=-3)
                    dec_overlap = None
                write_part(clip_dec_chunk)
            else:
                # Break the view's reference to the full decoded clip so earlier
                # temporal chunks can be released before the final output exists.
                dec_overlap = clip_dec_chunk.contiguous()

        if i == num_chunks - 1:
            if dec_overlap is not None:
                write_part(dec_overlap)
                dec_overlap = None
            if dec_tail is not None:
                write_part(dec_tail)

        del clip_dec, clip_z
        if release_clip_outputs:
            # the last split's view still points into this clip's decoded output (module docstring)
            del clip_dec_chunk

    if write_pos == 0:
        raise RuntimeError("decode_temporal streaming produced no output frames")
    if logical_frames != total_frames or dropped_frames != pad_frames or write_pos != output_frames:
        raise RuntimeError(
            "decode_temporal streaming frame plan mismatch: "
            f"logical_frames={logical_frames} total_frames={total_frames} "
            f"dropped_frames={dropped_frames} pad_frames={pad_frames} "
            f"write_pos={write_pos} output_frames={output_frames}"
        )
