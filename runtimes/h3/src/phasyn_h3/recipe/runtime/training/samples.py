# SPDX-License-Identifier: Apache-2.0
# Uses the pinned SGLang Ref2VA layout builder and denoise branch (de487f8039e06853b5f376fd5f068ea9d7c400bb,
# .../stages/model_specific_stages/minimax_h3/{packed_sequence,denoise_loop,condition_noise,packed_tokens}.py),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
"""Training samples: the DiT inputs a Ref2VA render of the clip would see, and the clip's latents as target.

A sample is one safetensors file: ``text_hidden`` / ``text_tags`` from the conditioning bundle, the reference
latents in the upstream condition order, ``target_video`` (the clip, encoded), ``target_audio`` (encoded
silence), an optional ``target_video_token_weight`` loss mask, and the packed-layout metadata. A window of
``k`` latent frames is drawn per step; it keeps the positions those frames have in the full clip, so the window
sees exactly the RoPE of its frames.
"""

from __future__ import annotations

import json
import types
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from phasyn_h3.recipe.adapter.training_rules import audio_window, token_mask

from ..bundles import load_bundle_manifest, read_bundle_metadata, resolve_payload
from ..stages.layout import ordered_condition_blocks
from ..stages.tensor_io import load_tensors


SAMPLE_KEY = "phasyn_lora_sample"
IMGVID_COND_T, AUDIO_REF_COND_T = 0.999, 1.0
_PATCH = [1, 2, 2]


def assemble(  # noqa: PLR0913 - every input of one sample
    *,
    name: str,
    conditioning: tuple[Path, Path],
    references: tuple[Path, Path, str],
    target_video: Any,
    target_audio: Any,
    loss_masks: Sequence[Mapping[str, Any]],
    out: Path,
) -> dict[str, Any]:
    """Write one sample file and return its metadata.

    ``conditioning`` is (manifest, payload) of the h3.conditioning bundle; ``references`` is (manifest,
    payload, artifact id) of the merged Ref2VA reference bundle.
    """
    import torch
    from safetensors.torch import save_file

    cond_manifest = load_bundle_manifest(conditioning[0], conditioning=True)
    cond_payload = resolve_payload(
        cond_manifest, {cond_manifest["payload"]["artifact_id"]: conditioning[1]}
    )
    cond = load_tensors(cond_payload)
    ref_manifest = load_bundle_manifest(references[0])
    ref_payload = resolve_payload(ref_manifest, {references[2]: references[1]})
    ref_meta = read_bundle_metadata(ref_payload, ref_manifest)
    ref = load_tensors(ref_payload)
    blocks = ordered_condition_blocks("ref2va", ref_meta)
    _, _, t, h, w = (int(v) for v in target_video.shape)
    tensors = {
        "text_hidden": cond["hidden_states"].contiguous(),
        "text_tags": cond["text_token_tags"].to(torch.long).contiguous(),
        "target_video": target_video.float().contiguous(),
        "target_audio": target_audio.float().contiguous(),
    }
    for i, tensor in enumerate(blocks["visual_tensors"]):
        tensors[f"ref_visual_{i}"] = ref[tensor].float().contiguous()
    mask = token_mask(loss_masks, latent_t=t, latent_h=h, latent_w=w)
    if mask is not None:
        tensors["target_video_token_weight"] = torch.tensor(mask, dtype=torch.float32)
    meta = {
        "name": name,
        "task": "ref2va",
        "text_len": int(cond_manifest["text_len"]),
        "latent": {"t": t, "h": h, "w": w, "audio_t": int(target_audio.shape[2])},
        "ref2va_blocks": blocks["ref2va_blocks"],
        "loss_masks": [dict(m) for m in loss_masks],
        "conditioning_payload_sha256": cond_manifest["payload"]["sha256"],
    }
    tmp = out.with_suffix(".part")
    save_file(
        tensors, str(tmp), metadata={SAMPLE_KEY: json.dumps(meta, ensure_ascii=False)}
    )
    tmp.replace(out)
    return meta


def read_meta(path: Path) -> dict[str, Any]:
    """The metadata of a sample file without reading its tensors."""
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as h:
        return dict(json.loads(h.metadata()[SAMPLE_KEY]))


def load(path: Path) -> dict[str, Any]:
    """Tensors and metadata of a sample file (CPU)."""
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as h:
        tensors = {k: h.get_tensor(k) for k in h.keys()}  # noqa: SIM118 - safe_open is not a mapping
        meta = json.loads(h.metadata()[SAMPLE_KEY])
    return {"tensors": tensors, "meta": meta, "path": str(path)}


def window(sample: dict[str, Any], w0: int, k: int) -> dict[str, Any]:
    """A shallow copy whose targets start at the window (the preparation keeps their first ``k`` frames)."""
    t_all, meta = sample["tensors"], sample["meta"]
    lt, at = int(meta["latent"]["t"]), int(meta["latent"]["audio_t"])
    a0, ak = audio_window(w0, k, lt, at)
    t2 = dict(t_all)
    t2["target_video"] = t_all["target_video"][:, :, w0 : w0 + k]
    t2["target_audio"] = t_all["target_audio"][:, :, a0 : a0 + ak]
    if "target_video_token_weight" in t_all:
        t2["target_video_token_weight"] = t_all["target_video_token_weight"][
            w0 : w0 + k
        ]
    return {"tensors": t2, "meta": meta, "path": sample["path"], "w0": w0, "k": k}


def _positioned_builder(
    rt: types.SimpleNamespace, *, w0: int, k: int, latent_t: int, audio_t: int
) -> Any:
    """The packed-layout builder for a window, with the target rows' positions of the full clip."""
    orig = rt.ps.minimax_h3_packed_sequence_ref2va_blocks
    a0, ak = audio_window(w0, k, latent_t, audio_t)
    torch = rt.torch

    def build(**kw: Any) -> Any:
        win = orig(**kw)
        full = orig(**{**kw, "latent_t": latent_t, "audio_t": audio_t})
        gw, gf = win["img_position_ids"], full["img_position_ids"]
        wv = win["img_pos"][win["update_mask"]]
        fv = full["img_pos"][full["update_mask"]]
        rows = int(wv.shape[0]) // k
        if int(fv.shape[0]) != rows * latent_t:
            raise ValueError("full layout target rows do not match the window")
        wa = win["audio_pos"][win["audio_update_mask"]]
        fa = full["audio_pos"][full["audio_update_mask"]]
        channels = int(wa.shape[0]) // max(ak, 1)
        fa_sel = fa.view(channels, audio_t)[:, a0 : a0 + ak].reshape(-1)
        prefix = int(min(wv.min(), wa.min()))
        if not bool(torch.equal(gw[:prefix], gf[:prefix])):
            raise ValueError(
                "text and reference positions differ between the window and the full layout"
            )
        gw = gw.clone()
        gw[wv] = gf[fv[w0 * rows : (w0 + k) * rows]]
        gw[wa] = gf[fa_sel]
        return {**win, "img_position_ids": gw}

    return build


def _reference_rows(
    rt: types.SimpleNamespace, tensors: Mapping[str, Any], meta: Mapping[str, Any]
) -> tuple[list[Any], list[Any], list[Any]]:
    blocks, shapes, rows = [], [], []
    for vi, raw in enumerate(meta["ref2va_blocks"]):
        b = dict(raw)
        if b["kind"] != "image":
            raise ValueError("training samples carry only image references")
        x = tensors[f"ref_visual_{vi}"]
        shapes.append((1, b["latent_h"], b["latent_w"]))
        rows.append(
            rt.ptok.minimax_h3_patchify_video_latent(x.float(), patch_size=_PATCH)
        )
        blocks.append(b)
    return blocks, shapes, rows


def prepare(  # noqa: PLR0913 - one sample window and its precomputed text rows
    rt: types.SimpleNamespace,
    sample: dict[str, Any],
    model: Any,
    *,
    w0: int,
    k: int,
    refined_prompt: Any = None,
) -> types.SimpleNamespace:
    """Packed layout, denoise branch, pinned condition rows and clean target rows of one window."""
    torch = rt.torch
    device = rt.device
    meta = sample["meta"]
    lt_full, at_full = int(meta["latent"]["t"]), int(meta["latent"]["audio_t"])
    win = window(sample, w0, k)
    tensors = win["tensors"]
    _, ak = audio_window(w0, k, lt_full, at_full)
    blocks, shapes, vis_rows = _reference_rows(rt, tensors, meta)
    build = _positioned_builder(rt, w0=w0, k=k, latent_t=lt_full, audio_t=at_full)
    packed = build(
        text_len=int(meta["text_len"]),
        latent_t=k,
        latent_h=meta["latent"]["h"],
        latent_w=meta["latent"]["w"],
        audio_t=ak,
        ref_blocks=blocks,
    )
    tags = packed["token_tags"].clone()
    tags[packed["text_pos"].view(-1)] = tensors["text_tags"].view(-1).to(torch.long)
    branch = rt.dl.MiniMaxH3DenoiseBranch(
        packed=packed,
        text_embeddings=tensors["text_hidden"],
        token_tags=tags,
        device=device,
    )
    kw = branch.static_kwargs
    if refined_prompt is None:
        rt.precompute_refined(model, branch, device=device, shared_conditioning=None)
    else:
        kw["prompt_embeds"] = refined_prompt
        kw["refined_prompt_embeds_length"] = int(refined_prompt.shape[0])
    rt.precompute_rope(model, branch, device=device)
    kw["prompt_embeds"] = kw["prompt_embeds"].clone()
    kw["rope_cache"] = tuple(t.clone() for t in kw["rope_cache"])
    cond = rt.cn.minimax_h3_imgvid_cond_noise_aug_rows(
        torch.cat(vis_rows, dim=0),
        condition_shapes=shapes,
        target_latent_t=k,
        imgvid_cond_num_frames=len(shapes),
        seed=0,
        noise_aug=IMGVID_COND_T,
    )
    x0_v = rt.ptok.minimax_h3_patchify_video_latent(
        tensors["target_video"][:, :, :k].float(), patch_size=_PATCH
    )
    x0_a = tensors["target_audio"][0, :, :ak].reshape(-1, 32).float()
    w_v = None
    if "target_video_token_weight" in tensors:
        w_v = tensors["target_video_token_weight"][:k].reshape(-1).float().to(device)
    if int(x0_v.shape[0]) != int(branch.update_mask.sum()) or int(x0_a.shape[0]) != int(
        branch.audio_update_mask.sum()
    ):
        raise ValueError(
            f"sample {meta['name']}: target rows do not match the packed layout"
        )
    video_base = torch.zeros(int(branch.img_pos.shape[0]), 96, dtype=torch.float32)
    video_base[branch.cond_row_idx.cpu()] = cond
    audio_base = torch.zeros(int(branch.audio_pos.shape[0]), 32, dtype=torch.float32)
    return types.SimpleNamespace(
        name=meta["name"],
        branch=branch,
        video_base=video_base.to(device),
        audio_base=audio_base.to(device),
        x0_v=x0_v.to(device),
        x0_a=x0_a.to(device),
        w_v=w_v,
        seq_len=int(packed["seq_len"]),
    )


def timestep_plans(
    prep: types.SimpleNamespace, grid: Sequence[Mapping[str, float]]
) -> Any:
    """Per grid point (unique timesteps, inverse indices, block combination) of this window, as the loop builds."""
    return prep.branch.prepare_timestep_plan(
        video_timesteps=[1.0 - g["sigma_v"] for g in grid],
        audio_timesteps=[1.0 - g["sigma_a"] for g in grid],
        imgvid_cond_noise_aug=IMGVID_COND_T,
        audio_ref_cond_noise_aug=AUDIO_REF_COND_T,
    )


def flow_loss(  # noqa: PLR0913, PLR0917 - one training forward
    rt: types.SimpleNamespace,
    model: Any,
    prep: types.SimpleNamespace,
    plan: Any,
    slot: Any,
    sigma: tuple[float, float],
    gen: Any,
    audio_weight: float,
) -> tuple[Any, dict[str, float]]:
    """Velocity regression on the noised target rows; masked video tokens weigh zero."""
    torch = rt.torch
    F = torch.nn.functional  # noqa: N806 - the conventional name
    sv, sa = sigma
    eps_v = torch.randn(
        prep.x0_v.shape, generator=gen, device=prep.x0_v.device, dtype=torch.float32
    )
    eps_a = torch.randn(
        prep.x0_a.shape, generator=gen, device=prep.x0_a.device, dtype=torch.float32
    )
    video = prep.video_base.clone()
    audio = prep.audio_base.clone()
    video[prep.branch.video_target_slice] = (1.0 - sv) * prep.x0_v + sv * eps_v
    audio[prep.branch.audio_target_slice] = (1.0 - sa) * prep.x0_a + sa * eps_a
    kw = prep.branch.forward_kwargs(
        video_rows=video, audio_rows=audio, step_timesteps=plan, adaln_slot=slot
    )
    v_video, v_audio = model(**kw)
    v_audio = v_audio[prep.branch.audio_target_slice]
    tgt_v, tgt_a = prep.x0_v - eps_v, prep.x0_a - eps_a
    if prep.w_v is None:
        loss_v = F.mse_loss(v_video.float(), tgt_v)
    else:
        loss_v = (
            (v_video.float() - tgt_v).pow(2).mean(dim=-1) * prep.w_v
        ).sum() / prep.w_v.sum().clamp_min(1.0)
    loss_a = F.mse_loss(v_audio.float(), tgt_a)
    stats = {
        "loss_v": float(loss_v.detach()),
        "loss_a": float(loss_a.detach()),
        "v_zero_loss": float(tgt_v.pow(2).mean()),
    }
    return loss_v + audio_weight * loss_a, stats


__all__ = [
    "assemble",
    "flow_loss",
    "load",
    "prepare",
    "read_meta",
    "timestep_plans",
    "window",
]
