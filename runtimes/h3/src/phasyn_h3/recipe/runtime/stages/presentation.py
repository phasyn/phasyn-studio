# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/stages/text_encoding.py (fl2va/ref2va presentation branches)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: presentation frozen into the prepared-media payload.
"""Qwen3-VL presentation (tokenizer + processor) of an H3 request, frozen into the prepared payload.

``prepare_media`` (PC assist actor) builds it right after freezing the media, with the H3
snapshot's own tokenizer/processor; ``encode_conditioning`` (encoder node) only runs the encoder
forward on the frozen tensors.  The producer is the pinned upstream one
(``S/presentation.py``, ``S/stages/text_encoding.py:238-587``), unchanged:

* ``input_ids`` I64 [S], ``text_token_tags`` I64 [S] (text=1, vision block=0) and
  ``text_video_token_mask`` BOOL [S] (only ``<|video_pad|>`` rows; always produced);
* vision inputs of ``MiniMaxH3Qwen3VLEncoder.encode_ids`` (``minimax_h3_qwen3vl.py:328-392``):
  ``pixel_values`` / ``pixel_values_videos`` and their ``image_grid_thw`` / ``video_grid_thw``.
  The encoder casts pixel values to BF16 before its first use (``:368-375``,
  ``pixel_values.to(device, torch.bfloat16)``), so they travel as BF16 — bit-identical encoder input
  at half the bytes of the processor's FP32 output (FP32→BF16 rounding is round-to-nearest-even on
  CPU and GPU alike).

The presentation digest is the one ``encode_conditioning`` always recorded (sha256 of ids, tags and
mask + the presentation facts), so conditioning cache keys do not move; ``tokenizer_digest`` /
``processor_digest`` hash the component files on the node that tokenized.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest, sha256_hex

from ..bundles import TensorDecl
from ..errors import IntegrityMismatch, InvalidStageInput
from .common import StageRun, contributes_audio

PRESENTATION_KIND = "h3_presentation_v1"
TOKEN_TENSORS = ("input_ids", "text_token_tags", "text_video_token_mask")
# encode_ids keyword -> (wire dtype, layout)
VISION_TENSORS: Mapping[str, tuple[str, str]] = {
    "pixel_values": ("BF16", "P,D"),
    "image_grid_thw": ("I64", "N,THW"),
    "pixel_values_videos": ("BF16", "P,D"),
    "video_grid_thw": ("I64", "N,THW"),
}
PIXEL_KEYS = ("pixel_values", "pixel_values_videos")


def component_digest(run: StageRun, kind: str) -> str:
    """Digest of a processor/tokenizer component: manifest identity + file contents."""
    from ..loaders import locate_component

    location = locate_component(run.plan.get("model") or {}, kind)
    entry = next(c for c in (run.plan.get("model") or {}).get("components", []) if c.get("kind") == kind)
    files = []
    root = location.path
    for path in sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else [root]:
        files.append(
            {
                "name": str(path.relative_to(root)) if root.is_dir() else path.name,
                "sha256": sha256_hex(path.read_bytes()),
            }
        )
    return canonical_digest(
        {
            "component_id": entry.get("component_id"),
            "config_digest": entry.get("config_digest"),
            "file_manifest": entry.get("file_manifest"),
            "files": files,
        }
    )


def build_presentation(
    task: str,
    prompt: str,
    materials: Sequence[Mapping[str, Any]],
    tensors: Mapping[str, Any],
    tokenizer: Any,
    processor: Any,
) -> tuple[Any, Any, Any, dict[str, Any], dict[str, Any]]:
    """Return (ids[S] long, tags[S] long, video_mask[S] bool, vision kwargs, facts)."""
    import torch
    from PIL import Image
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.presentation import (
        minimax_h3_multi_image_presentation,
        minimax_h3_ref2va_video_presentation,
        minimax_h3_text_only_ids,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        minimax_h3_sample_reference_video_frames,
    )

    vision: dict[str, Any] = {}
    facts: dict[str, Any] = {"task": task}
    if task == "t2va":
        ids = minimax_h3_text_only_ids(tokenizer, prompt)  # S/stages/text_encoding.py:305-315
        tags = torch.ones(int(ids.shape[0]), dtype=torch.long)
        mask = torch.zeros(int(ids.shape[0]), dtype=torch.bool)
        return ids, tags, mask, vision, facts
    if task == "fl2va":
        keyframes = [m for m in materials if m["material_chain"] == "image.target_canvas"]
        images = [Image.fromarray(_numpy(tensors[m["tensor"]])) for m in keyframes]
        frame_indices = tuple(int(m["frame_index"]) for m in keyframes)
        if frame_indices not in ((0,), (-1,), (0, -1)):
            raise InvalidStageInput("KEYFRAME_SIGNATURE", f"fl2va keyframe signature {frame_indices} 不合法")
        out = processor.image_processor(images=images, return_tensors="pt")  # :347-349
        grid = out["image_grid_thw"]
        merge = int(processor.image_processor.merge_size) ** 2
        counts = [int(grid[i].prod().item()) // merge for i in range(len(images))]
        ids, tags = minimax_h3_multi_image_presentation(tokenizer, prompt=prompt, image_token_counts=counts)
        mask = torch.zeros(int(ids.shape[0]), dtype=torch.bool)  # only IMAGE_PAD blocks: no video tokens
        vision = {"pixel_values": out["pixel_values"], "image_grid_thw": grid}
        facts["image_token_counts"] = counts
        return ids, tags, mask, vision, facts
    # ref2va — S/stages/text_encoding.py:376-587 with the frozen prepared assets
    labels: list[tuple[str, int]] = []
    counters = {"image": 0, "audio": 0, "video": 0}
    images, videos, sampled = [], [], []
    for m in materials:
        chain = m["material_chain"]
        if chain == "image.reference_preserve":
            counters["image"] += 1
            labels.append(("image", counters["image"]))
            images.append(Image.fromarray(_numpy(tensors[m["tensor"]])))
        elif chain == "audio":
            counters["audio"] += 1
            labels.append(("audio", counters["audio"]))
        elif chain in ("video.reference_preserve", "video_audio.reference_preserve"):
            if contributes_audio(m):  # upstream's input_has_audio rule, less a soundtrack dropped on request
                counters["audio"] += 1
                labels.append(("audio", counters["audio"]))
            counters["video"] += 1
            labels.append(("video", counters["video"]))
            s = minimax_h3_sample_reference_video_frames(_numpy(tensors[m["tensor"]]))
            sampled.append(s)
            videos.append(torch.from_numpy(s["frames"]).permute(0, 3, 1, 2))
        else:
            raise InvalidStageInput("REF2VA_CHAIN", f"ref2va 不支援 {chain}")
    image_tokens: Any = None
    if images:
        out = processor.image_processor(images=images, return_tensors="pt")
        grid = out["image_grid_thw"]
        merge = int(processor.image_processor.merge_size) ** 2
        counts = [int(grid[i].prod().item()) // merge for i in range(len(images))]
        image_tokens = counts[0] if len(counts) == 1 else counts
        vision.update({"pixel_values": out["pixel_values"], "image_grid_thw": grid})
        facts["image_token_counts"] = counts
    block_counts = block_ts = None
    if videos:
        vout = processor.video_processor(
            videos=videos, do_sample_frames=False, input_data_format="channels_first", return_tensors="pt"
        )
        vgrid = vout["video_grid_thw"]
        merge = int(processor.image_processor.merge_size) ** 2
        block_counts, block_ts = [], []
        for i, s in enumerate(sampled):
            n_blocks = int(vgrid[i, 0])
            per_block = int(vgrid[i, 1]) * int(vgrid[i, 2]) // merge
            ts = [float(t) for t in s["block_timestamps"]]
            if len(ts) != n_blocks:
                raise InvalidStageInput(
                    "VIDEO_BLOCKS", f"video {i}: processor {n_blocks} blocks vs timestamps {len(ts)}"
                )
            block_counts.append([per_block] * n_blocks)
            block_ts.append(ts)
        vision.update({"pixel_values_videos": vout["pixel_values_videos"], "video_grid_thw": vgrid})
    ids, tags, mask = minimax_h3_ref2va_video_presentation(
        tokenizer,
        prompt=prompt,
        condition_labels=labels,
        image_token_count=image_tokens,
        video_block_token_counts=block_counts,
        video_block_timestamps=block_ts,
        return_video_mask=True,
    )
    facts["condition_labels"] = labels
    return ids, tags, mask, vision, facts


def _numpy(tensor: Any) -> Any:
    return tensor.numpy() if hasattr(tensor, "numpy") else tensor


def json_facts(facts: Mapping[str, Any]) -> dict[str, Any]:
    """The facts as they read back from the prepared document (tuples become lists)."""
    return json.loads(json.dumps(dict(facts), ensure_ascii=False, sort_keys=True, default=str))


def presentation_digest(ids: Any, tags: Any, mask: Any, facts: Mapping[str, Any]) -> tuple[str, dict[str, str]]:
    """(digest, the three sha256) — the conditioning bundle's ``presentation_digest``."""
    import torch

    from .tensor_io import tensor_bytes

    hashes = {
        "ids_sha256": sha256_hex(tensor_bytes(ids.to(torch.long))),
        "tags_sha256": sha256_hex(tensor_bytes(tags.to(torch.long))),
        "mask_sha256": sha256_hex(tensor_bytes(mask.to(torch.bool))),
    }
    return canonical_digest({**hashes, "facts": json_facts(facts)}), hashes


def payload_tensors(ids: Any, tags: Any, mask: Any, vision: Mapping[str, Any]) -> list[tuple[TensorDecl, bytes, Any]]:
    """(decl, bytes, tensor) of the presentation tensors for the prepared payload."""
    import torch

    from .tensor_io import tensor_bytes

    seq = int(ids.shape[0])
    items: list[tuple[TensorDecl, Any]] = [
        (TensorDecl("input_ids", "I64", (seq,), "S"), ids.to(torch.long)),
        (TensorDecl("text_token_tags", "I64", (seq,), "S"), tags.to(torch.long)),
        (TensorDecl("text_video_token_mask", "BOOL", (seq,), "S"), mask.to(torch.bool)),
    ]
    for key, value in vision.items():
        if key not in VISION_TENSORS:
            raise InvalidStageInput("PRESENTATION_VISION_KEY", f"processor 輸出未知的 vision 欄位 {key}")
        dtype, layout = VISION_TENSORS[key]
        tensor = value.to(torch.bfloat16) if dtype == "BF16" else value.to(torch.long)
        items.append((TensorDecl(key, dtype, tuple(int(d) for d in tensor.shape), layout), tensor.contiguous()))
    return [(decl, tensor_bytes(tensor), tensor) for decl, tensor in items]


def load_presentation(document: Mapping[str, Any], tensors: Mapping[str, Any]) -> tuple[Any, Any, Any, dict[str, Any]]:
    """Frozen (ids, tags, mask, vision kwargs) from a prepared payload, checked against the document."""
    import torch

    section = document.get("presentation")
    if not isinstance(section, Mapping) or section.get("kind") != PRESENTATION_KIND:
        raise InvalidStageInput(
            "PRESENTATION_MISSING",
            "prepared 文件沒有 presentation（tokenizer／processor 在 prepare_media 執行）；"
            "請以目前版本重跑 prepare_media，encoder 節點不再自行 tokenize",
        )
    missing = [name for name in (*TOKEN_TENSORS, *section.get("vision", {}).values()) if name not in tensors]
    if missing:
        raise InvalidStageInput("PRESENTATION_TENSOR_MISSING", f"prepared payload 缺少 {missing}")
    ids, tags, mask = (tensors[name] for name in TOKEN_TENSORS)
    seq = int(section.get("text_len", -1))
    for name, tensor, dtype in (
        ("input_ids", ids, torch.long),
        ("text_token_tags", tags, torch.long),
        ("text_video_token_mask", mask, torch.bool),
    ):
        if tensor.dtype != dtype or list(tensor.shape) != [seq]:
            raise InvalidStageInput(
                "PRESENTATION_TENSOR_SHAPE", f"{name} 為 {tensor.dtype} {list(tensor.shape)}，預期 {dtype} [{seq}]"
            )
    digest, hashes = presentation_digest(ids, tags, mask, section.get("facts") or {})
    for key, value in hashes.items():
        if section.get(key) != value:
            raise IntegrityMismatch(
                "PRESENTATION_DIGEST", f"presentation {key} 與 payload 不符", expected=section.get(key), actual=value
            )
    if section.get("digest") != digest:
        raise IntegrityMismatch(
            "PRESENTATION_DIGEST", "presentation digest 與 payload 不符", expected=section.get("digest"), actual=digest
        )
    vision: dict[str, Any] = {}
    for key, name in sorted((section.get("vision") or {}).items()):
        if key not in VISION_TENSORS:
            raise InvalidStageInput("PRESENTATION_VISION_KEY", f"presentation.vision 有未知欄位 {key}")
        want = torch.bfloat16 if VISION_TENSORS[key][0] == "BF16" else torch.long
        if tensors[name].dtype != want:
            raise InvalidStageInput("PRESENTATION_TENSOR_SHAPE", f"{name} 為 {tensors[name].dtype}，預期 {want}")
        vision[key] = tensors[name]
    return ids, tags, mask, vision


__all__ = [
    "PIXEL_KEYS",
    "PRESENTATION_KIND",
    "TOKEN_TENSORS",
    "VISION_TENSORS",
    "build_presentation",
    "component_digest",
    "json_facts",
    "load_presentation",
    "payload_tensors",
    "presentation_digest",
]
