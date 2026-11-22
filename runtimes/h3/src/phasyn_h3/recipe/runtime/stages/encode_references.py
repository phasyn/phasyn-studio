# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/stages/model_specific_stages/minimax_h3/reference_encoding.py (minimax_h3_encode_reference_audio_rows, in the audio branch)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: split into visual/audio scopes.
"""encode_references: VideoVAE/AudioVAE condition latents → ``reference_latents`` bundle.

Recipes:

* keyframes & reference images — ``minimax_h3_encode_keyframe_cond_rows``
  (fp32 VAE, seed-42 scoped posterior *sample*, normalize, [1,2,2] patchify;
  ``S/keyframe_encoding.py:114-152``) under ``minimax_h3_scoped_encode_fp32``;
* reference videos — ``minimax_h3_encode_reference_video_rows``
  (``S/reference_encoding.py:622-690``);
* reference audio — the remainder of ``minimax_h3_encode_reference_audio_rows``
  (``:294-362``) applied to the waveform frozen by ``prepare_media``: single
  torchaudio resample to 32 kHz, L and R encoded as a batch of two mono signals,
  posterior mean, normalize, channel-major.

Wire layouts (CONTRACTS): video-like latents ``[1,24,T,H/16,W/16]`` F32 and audio
``[1,2,T,32]`` F32, both in the DiT's normalized latent space.

Orchestration option (Phasyn Studio; no numeric change): the stage dict may carry
``reference_scope`` = ``all`` (default, the combined stage) | ``visual`` | ``audio``.  A scope
keeps one of the two encode loops below and runs it exactly as the combined stage does —
same functions, same per-item order (material order), same seeds (every visual encode
seeds its own scoped RNG fork; the audio encode takes the posterior mean under
``_AudioVAEDeterminismContext``) — and names its tensors the way the combined bundle
names them (the audio scope numbers its blocks after the visual blocks the combined
stage writes first).  A partial bundle carries ``reference_scope``, ``scope_sources`` and
``prepared_payload_sha256`` in its metadata, so it can never pass for a combined bundle;
merging a visual and an audio partial (``blocks`` visual then audio, the combined metadata
keys, :func:`write_reference_bundle`) rebuilds the combined payload byte for byte.

Orchestration option ``frame_streaming`` (``h3.video_encode`` ``provider_options.frame_streaming``,
opt-in; absent: every encode above runs unchanged): the reference *videos* go through
``vae_frame_streaming.stream_reference_video_rows`` — the same recipe with the frames kept on the
host and the causal encoder run a few frames per pass (FP32: the production values up to the
convolutions' accumulation order); keyframes and reference images keep the FP32 recipe above.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, NamedTuple

from phasyn_h3.recipe.abi.stage import OutputFile, StageResult

from .. import SGLANG_SOURCE_REVISION
from ..bundles import (
    BundleIdentity,
    SafetensorsStreamWriter,
    TensorDecl,
    finalize_tensor_bundle,
    payload_metadata,
)
from ..errors import InvalidStageInput
from ..policy import component_policy_for
from . import vae_frame_streaming
from .common import StageRun, contributes_audio, task_of
from .normalization import ensure_vae_arch, normalization_digest
from .tensor_io import load_tensors, tensor_bytes, verified_payload


_WAVEFORM_RANK = 2
_STEREO_CHANNELS = 2


REFERENCE_SCOPES = ("all", "visual", "audio")
SCOPE_KEY = "reference_scope"
ENCODE_SEED = 42  # the visual recipes' scoped seed (S/keyframe_encoding.py, S/reference_encoding.py)


def stage_scope(stage: Mapping[str, Any]) -> str:
    """The stage's ``reference_scope`` (orchestration option; default the combined stage)."""
    scope = str(stage.get(SCOPE_KEY) or "all")
    if scope not in REFERENCE_SCOPES:
        raise InvalidStageInput(
            "REFERENCE_SCOPE",
            f"reference_scope={scope!r} 不合法（all／visual／audio）",
            field_path=SCOPE_KEY,
        )
    return scope


def scoped_sources(
    materials: Sequence[Mapping[str, Any]], scope: str
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]], int]:
    """(visual items, audio items, index of the first audio block) of one scope, in material order.

    The combined stage encodes every visual material first (one block each), then every audio
    source (a reference audio, or a reference video's soundtrack).  A scope keeps one list
    unchanged; the audio scope's blocks start after the visual blocks of the combined bundle.
    A reference video whose soundtrack was dropped on request is a visual source only
    (:func:`~.common.contributes_audio`).
    """
    visual = [m for m in materials if m["material_chain"] != "audio"]
    audio = [m for m in materials if contributes_audio(m)]
    if scope == "visual":
        return visual, [], 0
    if scope == "audio":
        return [], audio, len(visual)
    return visual, audio, 0


def image_block(
    m: Mapping[str, Any], *, index: int, kind: str, latent_h: int, latent_w: int
) -> dict[str, Any]:
    """Block of a keyframe (``image.target_canvas``) or a reference image."""
    return {
        "kind": kind,
        "tensor": f"{kind}_{index:02d}",
        "material_index": m["material_index"],
        "latent_t": 1,
        "latent_h": latent_h,
        "latent_w": latent_w,
        **(
            {
                "frame_index": m["frame_index"],
                "resolved_frame_index": m["resolved_frame_index"],
            }
            if kind == "keyframe"
            else {}
        ),
    }


def video_block(
    m: Mapping[str, Any], *, index: int, latent_t: int, latent_h: int, latent_w: int
) -> dict[str, Any]:
    """Build a conditioning block from the encoded video reference."""
    return {
        "kind": "video",
        "tensor": f"video_{index:02d}",
        "material_index": m["material_index"],
        "latent_t": int(latent_t),
        "latent_h": int(latent_h),
        "latent_w": int(latent_w),
        "input_has_audio": bool(m.get("input_has_audio")),
    }


def audio_block(
    m: Mapping[str, Any], *, index: int, ref_audio_t: int, duration_seconds: float
) -> dict[str, Any]:
    """Build a conditioning block from the encoded audio reference."""
    return {
        "kind": "audio",
        "tensor": f"audio_{index:02d}",
        "material_index": m["material_index"],
        "ref_audio_t": ref_audio_t,
        "duration_seconds": duration_seconds,
        "source_chain": m["material_chain"],
    }


def reference_metadata(
    blocks: Sequence[Mapping[str, Any]],
    materials: Sequence[Mapping[str, Any]],
    task: str,
    *,
    scope: str = "all",
    prepared_payload_sha256: str | None = None,
) -> dict[str, Any]:
    """The bundle's typed facts.  ``scope='all'`` is the combined stage's metadata (unchanged)."""
    metadata: dict[str, Any] = {
        "blocks": [dict(b) for b in blocks],
        # request order + chains: the DiT layout needs them (S/stages/denoising.py:250-323)
        "materials": [
            {
                "material_index": m["material_index"],
                "material_chain": m["material_chain"],
                "role": m["role"],
            }
            for m in materials
        ],
        "task": task,
        "normalized": True,
        "encode_seed": ENCODE_SEED,
        "sglang": SGLANG_SOURCE_REVISION,
    }
    if scope != "all":
        visual, audio, _ = scoped_sources(materials, "all")
        metadata[SCOPE_KEY] = scope
        metadata["scope_sources"] = {
            "visual": [int(m["material_index"]) for m in visual],
            "audio": [int(m["material_index"]) for m in audio],
        }
        metadata["prepared_payload_sha256"] = prepared_payload_sha256
    return metadata


def write_reference_bundle(
    output_dir: Path,
    items: Sequence[tuple[TensorDecl, Any]],
    metadata: Mapping[str, Any],
    identity: BundleIdentity,
    *,
    to_bytes: Callable[[Any], bytes | memoryview] = tensor_bytes,
) -> tuple[list[OutputFile], dict[str, Any]]:
    """``references.payload.safetensors`` (tensors in name order) + its verified manifest."""
    decls = [d for d, _ in items]
    payload_path = output_dir / "references.payload.safetensors"
    with SafetensorsStreamWriter(
        payload_path, decls, metadata=payload_metadata(metadata)
    ) as writer:
        for decl, tensor in sorted(items, key=lambda item: item[0].name):
            writer.write(decl.name, to_bytes(tensor))
    return finalize_tensor_bundle(
        output_dir,
        "references",
        payload_path,
        decls,
        kind="reference_latents",
        identity=identity,
        metadata=metadata,
    )


def run(run: StageRun) -> StageResult:
    """Encode the requested audio and video references."""
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.packed_tokens import (  # type: ignore[import-untyped]
        minimax_h3_unpatchify_video_tokens,
    )

    scope = stage_scope(run.stage)
    streaming = vae_frame_streaming.stage_config(
        run.stage
    )  # None: the production video encode (default)
    task = task_of(run.plan)
    prepared = run.read_json_input("prepared")
    if prepared is None:
        raise RuntimeError("prepared is unavailable in this stage")
    materials = prepared.get("materials") or []
    if task == "t2va" or not materials:
        raise InvalidStageInput(
            "NO_REFERENCES",
            "t2va／無素材時 encode_references 應由 plan 省略（omitted），不偽造輸出",
        )
    visual, audio_sources, audio_index_base = scoped_sources(materials, scope)
    if not visual and not audio_sources:
        raise InvalidStageInput(
            "REFERENCE_SCOPE_EMPTY",
            f"reference_scope={scope}：素材中沒有這個範圍要編碼的項目；不寫空 bundle",
            field_path=SCOPE_KEY,
        )
    # only the frozen media: the payload also carries the Qwen presentation (encode_conditioning's)
    names = _reference_names(scope, materials, visual, audio_sources)
    tensors = load_tensors(verified_payload(prepared, run.ctx.attachments), names)
    blocks: list[dict[str, Any]] = []
    out: list[tuple[TensorDecl, Any]] = []
    total = len(visual) + len(audio_sources)
    done = 0

    def to_wire(rows: Any, t: int, h: int, w: int) -> Any:
        return minimax_h3_unpatchify_video_tokens(
            rows, latent_shape=[t, h // 2, w // 2, 24], patch_size=[1, 2, 2]
        )

    timings = {"visual_seconds": 0.0, "audio_seconds": 0.0}
    done = _encode_visual_materials(
        _EncodeVisualMaterialsInputs(
            visual, run, streaming, tensors, to_wire, blocks, out, total, timings
        )
    )

    _encode_audio_materials(
        done,
        _EncodeAudioMaterialsInputs(
            audio_sources, run, tensors, blocks, audio_index_base, out, total, timings
        ),
    )

    metadata = reference_metadata(
        blocks,
        materials,
        task,
        scope=scope,
        prepared_payload_sha256=str(
            (prepared.get("payload") or {}).get("sha256") or ""
        ),
    )
    outputs, _ = write_reference_bundle(
        run.output_dir,
        out,
        metadata,
        run.bundle_identity(normalization_digest(run.plan)),
    )
    run.outputs.extend(outputs)
    run.measure(
        compute_seconds=timings["visual_seconds"] + timings["audio_seconds"],
        visual_seconds=round(timings["visual_seconds"], 6),
        audio_seconds=round(timings["audio_seconds"], 6),
    )
    run.fact(
        "REFERENCE_BLOCKS",
        {
            "scope": scope,
            "blocks": [{k: b[k] for k in ("kind", "tensor")} for b in blocks],
        },
    )
    return run.result()


__all__ = [
    "ENCODE_SEED",
    "REFERENCE_SCOPES",
    "SCOPE_KEY",
    "audio_block",
    "image_block",
    "reference_metadata",
    "run",
    "scoped_sources",
    "stage_scope",
    "video_block",
    "write_reference_bundle",
]


def _reference_names(
    scope: str, materials: Any, visual: Any, audio_sources: Any
) -> list[str]:
    if scope == "all":
        names = sorted(
            {m["tensor"] for m in materials}
            | {m["audio"]["tensor"] for m in materials if m.get("audio")}
        )
    else:  # a partial run reads only the media it encodes
        names = sorted(
            {m["tensor"] for m in visual}
            | {
                m["tensor"] if m["material_chain"] == "audio" else m["audio"]["tensor"]
                for m in audio_sources
            }
        )
    return names


class _EncodeVisualReferenceInputs(NamedTuple):
    chain: Any
    tensors: Any
    m: Any
    video_vae: Any
    arch: Any
    to_wire: Any
    blocks: list[dict[str, Any]]
    streaming: Any
    run: StageRun


def _encode_visual_reference(
    inputs: _EncodeVisualReferenceInputs,
) -> tuple[Any, tuple[str, int, str, dict[str, int]]]:
    from PIL import Image
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.keyframe_encoding import (  # type: ignore[import-untyped]
        minimax_h3_encode_keyframe_cond_rows,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (  # type: ignore[import-untyped]
        minimax_h3_encode_reference_video_rows,
    )

    chain, tensors, m, video_vae, arch, to_wire, blocks, streaming, run = inputs
    if chain in ("image.target_canvas", "image.reference_preserve"):
        image = Image.fromarray(tensors[m["tensor"]].numpy())
        rows = minimax_h3_encode_keyframe_cond_rows(video_vae, image, arch)
        lh, lw = image.size[1] // 16, image.size[0] // 16
        wire = to_wire(rows, 1, lh, lw)
        kind = "keyframe" if chain == "image.target_canvas" else "image"
        blocks.append(
            image_block(
                m,
                index=len(blocks),
                kind=kind,
                latent_h=lh,
                latent_w=lw,
            )
        )
        cost: tuple[str, int, str, dict[str, int]] = (
            f"encode_{kind}",
            image.size[0] * image.size[1],
            "pixel",
            {},
        )
    else:
        frames = tensors[m["tensor"]].numpy()
        if streaming is None:
            rows, lt, lh, lw = minimax_h3_encode_reference_video_rows(
                video_vae, frames, arch
            )
        else:
            rows, lt, lh, lw, streamed = (
                vae_frame_streaming.stream_reference_video_rows(
                    video_vae,
                    frames,
                    arch,
                    streaming,
                    check_cancel=run.check_cancel,
                )
            )
            run.fact(
                "FRAME_STREAMING",
                {"material_index": m["material_index"], **streamed},
            )
        wire = to_wire(rows, int(lt), int(lh), int(lw))
        blocks.append(
            video_block(
                m,
                index=len(blocks),
                latent_t=lt,
                latent_h=lh,
                latent_w=lw,
            )
        )
        t, h, w = (int(d) for d in frames.shape[:3])  # [T,H,W,3] uint8
        cost = ("encode_video", t * h * w, "pixel_frame", {"frames": t})
    return wire, cost


class _EncodeAudioWaveformInputs(NamedTuple):
    m: Any
    tensors: Any
    device: Any
    audio_vae: Any
    arch: Any
    mean: Any
    std: Any


def _encode_audio_waveform(inputs: _EncodeAudioWaveformInputs) -> tuple[Any, Any]:
    import torch
    from sglang.multimodal_gen.runtime.managers.forward_context import (  # type: ignore[import-untyped]
        set_forward_context,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        MINIMAX_H3_AUDIO_SAMPLE_RATE,
        _audio_resampler,
    )

    m, tensors, device, audio_vae, arch, mean, std = inputs
    name = m["tensor"] if m["material_chain"] == "audio" else m["audio"]["tensor"]
    rate = int(m.get("source_sample_rate") or m["audio"]["source_sample_rate"])
    waveform = tensors[name].to(torch.float32)
    if waveform.ndim != _WAVEFORM_RANK or int(waveform.shape[0]) != _STEREO_CHANNELS:
        raise InvalidStageInput("AUDIO_WAVEFORM_SHAPE", f"{name} 必須是 [2,N]（L,R）")
    if rate != MINIMAX_H3_AUDIO_SAMPLE_RATE:
        waveform = _audio_resampler(rate)(waveform)
    waveform = waveform.to(device)
    with set_forward_context(current_timestep=0, attn_metadata=None):
        audio_data = audio_vae.preprocess(
            waveform.unsqueeze(1), MINIMAX_H3_AUDIO_SAMPLE_RATE
        )
        z = audio_vae.encoder(audio_data)
        if bool(getattr(audio_vae, "attn_proj", False)):
            z = audio_vae.pre_block(z.transpose(1, 2)).transpose(1, 2)
        latent = audio_vae.mean_proj(z).float()
    if int(latent.shape[-1]) != int(arch.latent_channels):
        latent = latent.transpose(1, 2).contiguous()  # -> [2, T, 32]
    latent = (latent.cpu() - mean) / std
    return waveform, latent


class _EncodeVisualMaterialsInputs(NamedTuple):
    visual: Any
    run: StageRun
    streaming: Any
    tensors: Any
    to_wire: Any
    blocks: list[dict[str, Any]]
    out: list[tuple[TensorDecl, Any]]
    total: Any
    timings: Any


def _encode_visual_materials(inputs: _EncodeVisualMaterialsInputs) -> Any:
    import torch
    from sglang.multimodal_gen.runtime.managers.forward_context import (
        set_forward_context,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.keyframe_encoding import (
        minimax_h3_scoped_encode_fp32,
    )

    visual, run, streaming, tensors, to_wire, blocks, out, total, timings = inputs
    done = 0
    if visual:
        video_policy = run.policy.components.get("video_vae")
        vae_frame_streaming.check_precision(
            streaming, video_policy.compute_dtype if video_policy else "fp32"
        )
        with run.provider.use_component(run, "video_vae") as video_vae:
            arch = ensure_vae_arch(
                run.plan, "video_vae", run.provider.pipeline_config().vae_config
            )
            started = time.perf_counter()
            with (
                minimax_h3_scoped_encode_fp32(video_vae),
                set_forward_context(current_timestep=0, attn_metadata=None),
            ):
                for m in visual:
                    run.check_cancel()
                    item_started = (
                        time.perf_counter()
                    )  # the encoders return CPU rows: each item ends synchronized
                    chain = m["material_chain"]
                    wire, cost = _encode_visual_reference(
                        _EncodeVisualReferenceInputs(
                            chain,
                            tensors,
                            m,
                            video_vae,
                            arch,
                            to_wire,
                            blocks,
                            streaming,
                            run,
                        )
                    )
                    wire = wire.to(torch.float32).contiguous()
                    out.append(
                        (
                            TensorDecl(
                                blocks[-1]["tensor"],
                                "F32",
                                tuple(int(d) for d in wire.shape),
                                "B,C,T,H,W",
                            ),
                            wire,
                        )
                    )
                    name, work, unit, shape = cost
                    run.cost(
                        name,
                        work=work,
                        unit=unit,
                        seconds=time.perf_counter() - item_started,
                        **shape,
                    )
                    done += 1
                    run.progress("encode_references", "items", done, total)
            run.provider.backend.synchronize()
            timings["visual_seconds"] = time.perf_counter() - started
    return done


class _EncodeAudioMaterialsInputs(NamedTuple):
    audio_sources: Any
    run: StageRun
    tensors: Any
    blocks: list[dict[str, Any]]
    audio_index_base: Any
    out: list[tuple[TensorDecl, Any]]
    total: Any
    timings: Any


def _encode_audio_materials(
    initial_done: int, inputs: _EncodeAudioMaterialsInputs
) -> None:
    import torch
    from sglang.multimodal_gen.runtime.pipelines_core.stages.model_specific_stages.minimax_h3.reference_encoding import (
        MINIMAX_H3_AUDIO_SAMPLE_RATE,
        _AudioVAEDeterminismContext,
    )

    audio_sources, run, tensors, blocks, audio_index_base, out, total, timings = inputs
    done = initial_done
    if audio_sources:
        # validated only now (the stage's own component is the video VAE); the
        # residency extension applies to it like to any other use
        comp = component_policy_for(run.policy, "audio_vae")
        run.fact("AUDIO_VAE_POLICY", comp.as_dict())
        with run.provider.use_component(
            run, "audio_vae", policy_override=comp
        ) as audio_vae:
            arch = ensure_vae_arch(
                run.plan, "audio_vae", run.provider.pipeline_config().audio_vae_config
            )
            device = next(audio_vae.parameters()).device
            mean = torch.tensor(list(arch.latents_mean), dtype=torch.float32).view(
                1, 1, -1
            )
            std = torch.tensor(list(arch.latents_std), dtype=torch.float32).view(
                1, 1, -1
            )
            started = time.perf_counter()
            with _AudioVAEDeterminismContext(), torch.inference_mode():
                for m in audio_sources:
                    run.check_cancel()
                    item_started = (
                        time.perf_counter()
                    )  # ends with the latent copied to the CPU
                    waveform, latent = _encode_audio_waveform(
                        _EncodeAudioWaveformInputs(
                            m, tensors, device, audio_vae, arch, mean, std
                        )
                    )
                    t = int(latent.shape[1])
                    wire = latent.reshape(
                        1, 2, t, int(arch.latent_channels)
                    ).contiguous()
                    blocks.append(
                        audio_block(
                            m,
                            index=audio_index_base + len(blocks),
                            ref_audio_t=t,
                            duration_seconds=float(waveform.shape[-1])
                            / MINIMAX_H3_AUDIO_SAMPLE_RATE,
                        )
                    )
                    tensor_name = blocks[-1]["tensor"]
                    out.append(
                        (
                            TensorDecl(
                                tensor_name,
                                "F32",
                                tuple(int(d) for d in wire.shape),
                                "B,C,T,D",
                            ),
                            wire,
                        )
                    )
                    run.cost(
                        "encode_audio",
                        work=float(waveform.shape[-1]) / MINIMAX_H3_AUDIO_SAMPLE_RATE,
                        unit="second",
                        seconds=time.perf_counter() - item_started,
                    )
                    done += 1
                    run.progress("encode_references", "items", done, total)
            run.provider.backend.synchronize()
            timings["audio_seconds"] = time.perf_counter() - started
