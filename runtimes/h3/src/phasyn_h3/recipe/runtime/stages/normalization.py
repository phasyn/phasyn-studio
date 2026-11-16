"""Latent normalization identity (``normalization_config_digest``), torch-free.

Every H3 latent on the wire lives in the DiT's normalized space
(``(z - mean) / std`` with the VAE ``latents_mean``/``latents_std``;
``S/keyframe_encoding.py:143-148``, ``S/stages/decoding.py:108-142``).  The digest
binds a bundle to the exact stats: the component's own VAE ``config.json`` under the
model root, else the pinned upstream config of the user's MiniMax-H3 snapshot
(``checkpoint_inspect.reference_json``, SHA-256 verified).
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest

from ..checkpoint_inspect import reference_json
from ..errors import IntegrityMismatch, ShimError
from ..model_root import model_root


def _stats(config: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "latent_channels": config.get("latent_channels"),
        "latents_mean": list(config.get("latents_mean") or []),
        "latents_std": list(config.get("latents_std") or []),
    }


def _component_config(plan: Mapping[str, Any], kind: str) -> tuple[dict[str, Any], str]:
    root = model_root()
    for entry in (plan.get("model") or {}).get("components", []):
        if entry.get("kind") == kind:
            path = root / str(entry["relative_path"]) / "config.json"
            if path.is_file():
                return json.loads(path.read_text(encoding="utf-8")), f"model_root:{entry['relative_path']}/config.json"
    name = "video_vae_config.json" if kind == "video_vae" else "audio_vae_config.json"
    return reference_json(name, model_root=root), f"reference:{name}"


def normalization_config(plan: Mapping[str, Any]) -> dict[str, Any]:
    video, video_src = _component_config(plan, "video_vae")
    audio, audio_src = _component_config(plan, "audio_vae")
    return {
        "video": _stats(video),
        "audio": _stats(audio),
        "sources": {"video": video_src, "audio": audio_src},
    }


def normalization_digest(plan: Mapping[str, Any]) -> str:
    config = normalization_config(plan)
    return canonical_digest({"video": config["video"], "audio": config["audio"]})


def _same(have: Sequence[float], want: Sequence[float]) -> bool:
    return len(have) == len(want) and all(
        math.isclose(float(h), float(w), rel_tol=1e-6, abs_tol=1e-7) for h, w in zip(have, want, strict=True)
    )


def ensure_vae_arch(plan: Mapping[str, Any], kind: str, vae_config: Any) -> Any:
    """The SGLang VAE arch config a stage (de)normalizes with, complete for ``kind`` (video_vae/audio_vae).

    SGLang fills ``arch_config`` from the checkpoint's ``config.json`` (``update_model_arch``) only on the
    ServerArgs that loaded the component.  A resident VAE reused under another profile's or stage's
    ServerArgs leaves that copy at the class defaults (``latents_mean``/``latents_std`` None →
    ``TypeError: 'NoneType' object is not iterable``).  Here the same ``config.json`` the plan's
    normalization digest is bound to is applied the way a load would, and the statistics are checked
    against the plan's ``normalization_config`` either way.
    """
    arch = vae_config.arch_config
    if getattr(arch, "latents_mean", None) is None or getattr(arch, "latents_std", None) is None:
        config, _source = _component_config(plan, kind)
        vae_config.update_model_arch(dict(config))
        post_init = getattr(vae_config, "post_init", None)
        if callable(post_init):
            post_init()
        arch = vae_config.arch_config
    side = "video" if kind == "video_vae" else "audio"
    want = normalization_config(plan)[side]
    mean, std = getattr(arch, "latents_mean", None), getattr(arch, "latents_std", None)
    if not mean or not std:
        raise ShimError("LATENT_STATS_MISSING", f"{kind} 的 latents_mean／latents_std 無法從 checkpoint 設定取得")
    if not (_same(list(mean), want["latents_mean"]) and _same(list(std), want["latents_std"])):
        raise IntegrityMismatch(
            "LATENT_NORMALIZATION_RUNTIME",
            f"{kind} 的 latent 統計與 plan 綁定的 normalization 設定（{normalization_config(plan)['sources'][side]}）不符",
        )
    return arch


__all__ = ["ensure_vae_arch", "normalization_config", "normalization_digest"]
