"""Packed-sequence layout shared by ``assemble_inputs`` and ``denoise_av``.

The layout is a pure function of (task, text_len, latent dims, condition blocks)
built with the pinned upstream builders (``S/packed_sequence.py:118-239`` and the
ref2va block variant) — ``assemble_inputs`` records its digest and
``denoise_av`` must rebuild the identical layout.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, TypedDict, Unpack, cast

from .._arguments import validate_keywords
from ..errors import IntegrityMismatch, InvalidStageInput
from .tensor_io import tensor_bytes


class _PackedPositions(TypedDict, total=False):
    include_video_pos: bool


_VIDEO_RANK = 5
_VIDEO_CHANNELS = 24
_AUDIO_RANK = 4
_AUDIO_CHANNELS = 2
_AUDIO_BINS = 32


@dataclass(frozen=True)
class LatentDims:
    """Describe the dimensions of the packed audio and video latents."""

    latent_t: int
    latent_h: int
    latent_w: int
    audio_t: int


def latent_dims(geometry: Mapping[str, Any]) -> LatentDims:
    """Resolve the latent dimensions from the job geometry."""
    video = list(geometry.get("video_latent_shape") or [])
    audio = list(geometry.get("audio_latent_shape") or [])
    if len(video) != _VIDEO_RANK or video[0] != 1 or video[1] != _VIDEO_CHANNELS:
        raise InvalidStageInput(
            "VIDEO_LATENT_SHAPE",
            f"geometry.video_latent_shape 必須是 [1,24,T,H/16,W/16]，收到 {video}",
        )
    if (
        len(audio) != _AUDIO_RANK
        or audio[0] != 1
        or audio[1] != _AUDIO_CHANNELS
        or audio[3] != _AUDIO_BINS
    ):
        raise InvalidStageInput(
            "AUDIO_LATENT_SHAPE",
            f"geometry.audio_latent_shape 必須是 [1,2,T,32]，收到 {audio}",
        )
    if video[3] % 2 or video[4] % 2:
        raise InvalidStageInput(
            "LATENT_PATCH_ALIGN", "latent H/W 必須可被 DiT patch 2 整除"
        )
    return LatentDims(
        latent_t=int(video[2]),
        latent_h=int(video[3]),
        latent_w=int(video[4]),
        audio_t=int(audio[2]),
    )


def ordered_condition_blocks(
    task: str, references: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Upstream block order (``S/stages/denoising.py:250-323``) from frozen metadata.

    ``references`` is the reference-latent bundle metadata (blocks + request-ordered
    materials).  Returns ``{"keyframes", "ref2va_blocks", "visual_tensors",
    "audio_tensors"}``; the tensor lists give the concatenation order of the visual
    condition rows and the reference-audio rows.
    """
    materials = list((references or {}).get("materials") or [])
    blocks = list((references or {}).get("blocks") or [])
    by_material: dict[int, list[Mapping[str, Any]]] = {}
    for block in blocks:
        by_material.setdefault(int(block["material_index"]), []).append(block)
    out: dict[str, Any] = {
        "keyframes": [],
        "ref2va_blocks": [],
        "visual_tensors": [],
        "audio_tensors": [],
    }
    if task == "t2va":
        if blocks:
            raise InvalidStageInput("T2VA_REFERENCES", "t2va 不應有 reference latents")
        return out
    if task == "fl2va":
        keyframes = [b for b in blocks if b["kind"] == "keyframe"]
        if not keyframes or len(keyframes) != len(blocks):
            raise InvalidStageInput(
                "FL2VA_REFERENCES", "fl2va 需要且只接受 keyframe latents"
            )
        keyframes.sort(
            key=lambda b: (int(b["frame_index"]) == -1, int(b["frame_index"]))
        )
        out["keyframes"] = keyframes
        out["visual_tensors"] = [b["tensor"] for b in keyframes]
        return out
    for material in materials:
        _append_condition_material(out, material, by_material)
    return out


def build_packed(
    task: str,
    text_len: int,
    dims: LatentDims,
    blocks: Mapping[str, Any],
    frame_count: int,
    **arguments: Unpack[_PackedPositions],
) -> dict[str, Any]:
    """Upstream packed layout; ``include_video_pos`` adds the SubBlock-eligible ``video_pos`` rows only (not part of ``layout_digest``)."""
    validate_keywords(arguments, _PackedPositions)
    include_video_pos = arguments.get("include_video_pos", False)
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_sequence import (  # type: ignore[import-untyped]
        minimax_h3_packed_sequence,
        minimax_h3_packed_sequence_ref2va_blocks,
    )

    if task == "ref2va":
        return cast(
            "dict[str, Any]",
            minimax_h3_packed_sequence_ref2va_blocks(
                text_len=int(text_len),
                latent_t=dims.latent_t,
                latent_h=dims.latent_h,
                latent_w=dims.latent_w,
                audio_t=dims.audio_t,
                ref_blocks=list(blocks["ref2va_blocks"]),
                keyframe_frame_indices=None,
                frame_count=None,
                include_video_pos=include_video_pos,
            ),
        )
    keyframes = list(blocks["keyframes"])
    include = bool(keyframes)
    return cast(
        "dict[str, Any]",
        minimax_h3_packed_sequence(
            text_len=int(text_len),
            latent_t=dims.latent_t,
            latent_h=dims.latent_h,
            latent_w=dims.latent_w,
            audio_t=dims.audio_t,
            include_keyframe_cond=include,
            keyframe_frame_indices=[int(b["frame_index"]) for b in keyframes]
            if include
            else None,
            frame_count=int(frame_count) if include else None,
            include_video_pos=include_video_pos,
        ),
    )


def tagged(packed: Mapping[str, Any], text_token_tags: Any) -> Any:
    """Token tags with the conditioning tags written over the text rows (denoising.py:708-711)."""
    import torch

    tags = packed["token_tags"].clone()
    tags[packed["text_pos"].view(-1)] = text_token_tags.view(-1).to(torch.long)
    return tags


_DIGEST_FIELDS: Sequence[str] = (
    "img_pos",
    "audio_pos",
    "text_pos",
    "update_mask",
    "audio_update_mask",
    "img_position_ids",
    "cu_seqlens",
)


def layout_digest(packed: Mapping[str, Any], tags: Any) -> str:
    """Identify the packed token layout."""
    h = hashlib.sha256()
    h.update(f"seq_len={int(packed['seq_len'])};".encode())
    for name in _DIGEST_FIELDS:
        value = packed.get(name)
        if value is None:
            h.update(f"{name}=absent;".encode())
            continue
        h.update(f"{name}:{value.dtype}:{list(value.shape)};".encode())
        h.update(tensor_bytes(value))
    h.update(b"token_tags;")
    h.update(tensor_bytes(tags))
    return h.hexdigest()


def check_layout(expected: str, actual: str) -> None:
    """Validate the shape and ordering of the packed inputs."""
    if expected != actual:
        raise IntegrityMismatch(
            "PACKED_LAYOUT_MISMATCH",
            "denoise_av 重建的 packed layout 與 assemble_inputs 記錄不同",
            expected=expected,
            actual=actual,
        )


__all__ = [
    "LatentDims",
    "build_packed",
    "check_layout",
    "latent_dims",
    "layout_digest",
    "ordered_condition_blocks",
    "tagged",
]


def _append_condition_material(
    out: dict[str, Any],
    material: Mapping[str, Any],
    by_material: dict[int, list[Mapping[str, Any]]],
) -> None:
    index = int(material["material_index"])
    chain = material["material_chain"]
    mine = by_material.get(index, [])
    visual = [b for b in mine if b["kind"] in ("image", "video")]
    audio = [b for b in mine if b["kind"] == "audio"]
    if chain == "image.reference_preserve":
        (block,) = visual
        out["ref2va_blocks"].append(
            {
                "kind": "image",
                "latent_h": int(block["latent_h"]),
                "latent_w": int(block["latent_w"]),
            }
        )
        out["visual_tensors"].append(block["tensor"])
    elif chain == "audio":
        (block,) = audio
        t = int(block["ref_audio_t"])
        out["ref2va_blocks"].append({"kind": "audio", "ref_audio_t": t})
        if t > 0:
            out["audio_tensors"].append(block["tensor"])
    elif chain in ("video.reference_preserve", "video_audio.reference_preserve"):
        (vblock,) = visual
        t = int(audio[0]["ref_audio_t"]) if audio else 0
        out["ref2va_blocks"].append(
            {
                "kind": "video_audio"
                if chain == "video_audio.reference_preserve"
                else "video",
                "ref_audio_t": t,
                "latent_t": int(vblock["latent_t"]),
                "latent_h": int(vblock["latent_h"]),
                "latent_w": int(vblock["latent_w"]),
            }
        )
        out["visual_tensors"].append(vblock["tensor"])
        if t > 0:
            out["audio_tensors"].append(audio[0]["tensor"])
    else:
        raise InvalidStageInput("REF2VA_CHAIN", f"ref2va 不支援 {chain}")
