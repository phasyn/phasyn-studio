"""Header-only inspection of single-file bitsandbytes NF4 H3 checkpoints (torch-free).

Only the safetensors JSON header is read (bounded parser, no tensor data).  The
result drives the synthesized SGLang component config for an NF4 DiT and the explicit rejections for layouts the pinned runtime
cannot honour.

The upstream MiniMax H3 configs this needs (transformer/VAE ``config.json``, ``model_index.json``)
are not shipped with Phasyn Studio: :func:`reference_json` reads them from the user's own
MiniMax-H3 snapshot under the model root and verifies each against its pinned SHA-256.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.model_identity import display_path

from phasyn_h3.recipe.abi.canonical import sha256_hex
from phasyn_h3.recipe.abi.tensors import SafetensorsHeader, read_header_from_file

from .errors import IntegrityMismatch, ModelFilesMissing, UnsupportedCombination

_BNB_STATE_RE = re.compile(r"^(?P<prefix>.+)\.weight\.quant_state\.bitsandbytes__(?P<qtype>nf4|fp4)$")
# SGLang builds these MiniMaxH3DiTModel linears with quant_config (may be NF4) …
_QUANT_CAPABLE_RE = re.compile(
    r"^(blocks\.\d+\.(attn\.(qkv_proj|out_proj)|mlp\.(fc1|fc2)|adaln_proj\.linear)"
    r"|token_refiner\.blocks\.\d+\.(attn\.(qkv_proj|out_proj)|mlp\.(fc1|fc2))"
    r"|condition_proj|final_layer\.adaln_proj\.linear)$"
)
# … and these always with quant_config=None (minimax_h3.py:2185-2205, 616-645, 1721-1770).
_NEVER_QUANTIZED_RE = re.compile(
    r"^(video_patch_proj|audio_patch_proj|time_embedder\.proj_(in|out)|final_layer\.(video_out|audio_out))$"
)

REFERENCE_REVISION = "MiniMax-AI/MiniMax-H3@d21241f0a4b3acbb34c97dae47fa417b7065e438"
REFERENCE_LAYOUT_ROOT = "MiniMax-H3"
# name -> (candidate paths under <model root>/MiniMax-H3/, pinned sha256 at REFERENCE_REVISION).
# Transformer and VAE configs are byte-identical in FL2VA and Ref2VA, so either variant's copy is accepted.
REFERENCE_FILES: dict[str, tuple[tuple[str, ...], str]] = {
    "transformer_config.json": (
        ("Ref2VA/transformer/config.json", "FL2VA/transformer/config.json"),
        "f619093a231fcfbcc3d035bec26c50ad864e7331a500d5c519f5045dc1e50458",
    ),
    "ref2va_model_index.json": (
        ("Ref2VA/model_index.json",),
        "b160b13700bf08aea7fce1bc3dd0d3a49ea15036298c50082ec107f87843b90c",
    ),
    "fl2va_model_index.json": (
        ("FL2VA/model_index.json",),
        "d1113e0f123c69f79cd0de35ca1771606ebc3ec924270d257b771f96f584aa6b",
    ),
    "video_vae_config.json": (
        ("Ref2VA/video_vae/config.json", "FL2VA/video_vae/config.json"),
        "3edd2cdd1ebc823c868be55ef917e1b3b8a398fde4d3150dae44a3bf05d9f627",
    ),
    "audio_vae_config.json": (
        ("Ref2VA/audio_vae/config.json", "FL2VA/audio_vae/config.json"),
        "d8f3bcc62e23c7e9806970fa63cca6139c06faa3797cf9c94034f60db8512771",
    ),
}


def reference_json(name: str, *, model_root: Path) -> dict[str, Any]:
    """A pinned upstream MiniMax H3 config, read from the user's snapshot and verified by SHA-256.

    The first candidate that exists is used; a hash mismatch is an error (it never falls through to
    another candidate), and no candidate on disk is ``REFERENCE_CONFIG_MISSING``.
    """
    if name not in REFERENCE_FILES:
        raise KeyError(name)
    candidates, expected = REFERENCE_FILES[name]
    paths = [model_root / REFERENCE_LAYOUT_ROOT / relative for relative in candidates]
    for path in paths:
        if not path.is_file():
            continue
        raw = path.read_bytes()
        actual = sha256_hex(raw)
        if actual != expected:
            raise IntegrityMismatch(
                "REFERENCE_CONFIG_MISMATCH",
                f"MiniMax H3 官方設定 {display_path(path, model_root)} 與釘版 {REFERENCE_REVISION} 的 SHA-256 不符",
                expected=expected,
                actual=actual,
            )
        return json.loads(raw.decode("utf-8"))
    wanted = "、".join(display_path(path, model_root) for path in paths)
    raise ModelFilesMissing(
        "REFERENCE_CONFIG_MISSING",
        f"找不到 MiniMax H3 官方設定 {wanted}；請下載完整的 MiniMax-H3 snapshot（{REFERENCE_REVISION}）",
        error_code="COMPONENT_NOT_CONFIGURED",
    )


@dataclass(frozen=True)
class Nf4TransformerFacts:
    quantized_prefixes: tuple[str, ...]
    plain_quant_capable_prefixes: tuple[str, ...]
    quant_type: str
    double_quant: bool
    adaln_curve_shape: tuple[int, int] | None
    num_blocks: int
    num_refiner_blocks: int
    has_time_embedder: bool
    tensor_count: int
    problems: tuple[str, ...] = field(default_factory=tuple)

    @property
    def pruned_curve(self) -> bool:
        return self.adaln_curve_shape is not None


def inspect_nf4_transformer(header: SafetensorsHeader) -> Nf4TransformerFacts:
    names = set(header.tensors)
    quantized: dict[str, str] = {}
    for name in names:
        match = _BNB_STATE_RE.match(name)
        if match:
            quantized[match.group("prefix")] = match.group("qtype")
    problems: list[str] = []
    qtypes = set(quantized.values())
    if len(qtypes) > 1:
        problems.append(f"混用 bitsandbytes 量化型別 {sorted(qtypes)}")
    quant_type = next(iter(qtypes)) if qtypes else "none"
    double_quant = bool(quantized) and all(f"{p}.weight.nested_absmax" in names for p in quantized)
    if quantized and not double_quant and any(f"{p}.weight.nested_absmax" in names for p in quantized):
        problems.append("部分 linear 有 nested_absmax、部分沒有（double quant 不一致）")
    for prefix in quantized:
        weight = header.tensors.get(f"{prefix}.weight")
        if weight is None or weight.dtype != "U8" or len(weight.shape) != 2 or weight.shape[1] != 1:
            problems.append(f"{prefix}.weight 不是 bnb 4-bit 打包的 U8 [n,1]")
        if _NEVER_QUANTIZED_RE.match(prefix):
            problems.append(f"{prefix} 在釘版 SGLang 以 quant_config=None 建立，不能載入 NF4 權重")
        elif not _QUANT_CAPABLE_RE.match(prefix):
            problems.append(f"{prefix} 不是釘版 MiniMaxH3DiTModel 的已知 linear")
    plain: list[str] = []
    for name in names:
        if not name.endswith(".weight"):
            continue
        prefix = name[: -len(".weight")]
        if prefix in quantized:
            continue
        if _QUANT_CAPABLE_RE.match(prefix):
            plain.append(prefix)
    curve = header.tensors.get("adaln_t_table") or header.tensors.get("time_embedder.table")
    curve_shape = None
    if curve is not None:
        if len(curve.shape) != 2 or curve.shape[0] < 2:
            problems.append(f"adaln_t_table 形狀不合法 {curve.shape}")
        else:
            curve_shape = (int(curve.shape[0]), int(curve.shape[1]))
    blocks = {int(m.group(1)) for n in names if (m := re.match(r"^blocks\.(\d+)\.", n))}
    refiner = {int(m.group(1)) for n in names if (m := re.match(r"^token_refiner\.blocks\.(\d+)\.", n))}
    has_time_embedder = any(n.startswith("time_embedder.proj_") for n in names)
    if curve_shape is None and not has_time_embedder:
        problems.append("既沒有 adaln_t_table 也沒有 time_embedder：無法判定 AdaLN 架構")
    if curve_shape is not None and has_time_embedder:
        problems.append("同時含 adaln_t_table 與 time_embedder，架構矛盾")
    if blocks and blocks != set(range(len(blocks))):
        problems.append("blocks.N 編號不連續")
    return Nf4TransformerFacts(
        quantized_prefixes=tuple(sorted(quantized)),
        plain_quant_capable_prefixes=tuple(sorted(plain)),
        quant_type=quant_type,
        double_quant=double_quant,
        adaln_curve_shape=curve_shape,
        num_blocks=len(blocks),
        num_refiner_blocks=len(refiner),
        has_time_embedder=has_time_embedder,
        tensor_count=len(names),
        problems=tuple(problems),
    )


def build_nf4_transformer_config(
    facts: Nf4TransformerFacts,
    *,
    qkv_layout: str | None,
    declared_architecture: str | None,
    model_root: Path,
) -> dict[str, Any]:
    """Synthesize the component ``config.json`` SGLang's TransformerLoader reads.

    Base: the pinned upstream ``transformer/config.json`` from the user's snapshot (:func:`reference_json`).  Adds the bitsandbytes
    ``quantization_config`` derived from the header and the explicit QKV layout;
    the AdaLN curve dims are set by SGLang itself from the header
    (transformer_loader.py:318-331).
    """
    if facts.problems:
        raise UnsupportedCombination(
            "NF4_LAYOUT_MISMATCH", "NF4 DiT 標頭與釘版模型不相容：" + "；".join(facts.problems)
        )
    if facts.quant_type != "nf4":
        raise UnsupportedCombination("NF4_QUANT_TYPE", f"檔案量化型別為 {facts.quant_type}，不是 nf4")
    if declared_architecture is not None:
        actual = "pruned_curve" if facts.pruned_curve else "dense"
        if actual != declared_architecture:
            raise IntegrityMismatch(
                "ARCHITECTURE_DECLARATION_MISMATCH",
                f"宣告的 transformer_architecture={declared_architecture} 與檔案標頭 {actual} 不符",
            )
    if qkv_layout is None:
        raise UnsupportedCombination(
            "NF4_QKV_LAYOUT_UNDECLARED",
            "NF4 打包的 qkv_proj 無法在載入時做 grouped→concat 列重排（minimax_h3.py:249-278, 1072-1137）；"
            "需在 profile extension phasyn.sglang_h3.checkpoint 宣告 transformer_qkv_layout",
            field_path="extensions",
        )
    if qkv_layout != "concat":
        raise UnsupportedCombination(
            "NF4_QKV_LAYOUT_UNSUPPORTED",
            f"transformer_qkv_layout={qkv_layout}：4-bit 打包權重不能逐列重排，"
            "只接受已是 [q_all,k_all,v_all] 的 concat 版面",
            field_path="extensions",
        )
    config = reference_json("transformer_config.json", model_root=model_root)
    if facts.num_blocks != int(config.get("num_layers", 50)):
        raise UnsupportedCombination(
            "NF4_LAYER_COUNT", f"檔案有 {facts.num_blocks} 個 blocks，參考設定為 {config.get('num_layers')}"
        )
    if facts.num_refiner_blocks != int(config.get("token_refiner_num_layers", 2)):
        raise UnsupportedCombination("NF4_REFINER_COUNT", f"token_refiner blocks={facts.num_refiner_blocks}")
    config["checkpoint_qkv_layout"] = "native"
    config["quantization_config"] = {
        "quant_method": "bitsandbytes",
        "load_in_4bit": True,
        "load_in_8bit": False,
        "bnb_4bit_quant_type": "nf4",
        "bnb_4bit_use_double_quant": bool(facts.double_quant),
        "bnb_4bit_compute_dtype": "bfloat16",
        "bnb_4bit_quant_storage": "uint8",
        "llm_int8_skip_modules": list(facts.plain_quant_capable_prefixes),
    }
    return config


def inspect_file(path: Path) -> Nf4TransformerFacts:
    return inspect_nf4_transformer(read_header_from_file(path))


def write_overlay(
    overlay_dir: Path,
    *,
    weights_file: Path,
    config: Mapping[str, Any],
    model_index: Mapping[str, Any],
    component_root: Path | None = None,
) -> Path:
    """Write ``model_index.json`` + ``transformer/config.json`` into the actor workdir.

    The weights stay where they are (the model root is read-only); SGLang reads
    them through ``transformer_weights_path``.  SGLang's directory check requires every
    component listed in ``model_index.json`` to exist next to ``transformer/``: the other
    components are linked read-only from ``component_root`` (the variant directory of the
    full snapshot) — only the transformer is loaded from this overlay.
    """
    transformer_dir = overlay_dir / "transformer"
    transformer_dir.mkdir(parents=True, exist_ok=True)
    (overlay_dir / "model_index.json").write_text(json.dumps(model_index, indent=2, sort_keys=True), encoding="utf-8")
    (transformer_dir / "config.json").write_text(json.dumps(dict(config), indent=2, sort_keys=True), encoding="utf-8")
    (overlay_dir / "WEIGHTS_SOURCE").write_text(str(weights_file), encoding="utf-8")
    for key, value in model_index.items():
        if key.startswith("_") or key == "transformer" or not isinstance(value, (list, tuple)) or len(value) != 2:
            continue
        link = overlay_dir / key
        if link.exists() or link.is_symlink():
            continue
        target = component_root / key if component_root is not None else None
        if target is not None and target.exists():
            link.symlink_to(target, target_is_directory=True)
        else:
            link.mkdir(parents=True, exist_ok=True)
    return transformer_dir


__all__ = [
    "REFERENCE_FILES",
    "REFERENCE_LAYOUT_ROOT",
    "REFERENCE_REVISION",
    "Nf4TransformerFacts",
    "build_nf4_transformer_config",
    "inspect_file",
    "inspect_nf4_transformer",
    "reference_json",
    "write_overlay",
]
