"""MiniMax H3 DiT LoRA facts: header analysis, native layer mapping and identity signatures.

Pure Python; reads safetensors *headers* only (tensor names, dtypes, shapes, metadata),
never tensor data.  Two on-disk formats are understood:

* ``pdd_videox_fun`` — alibaba-pai MiniMax-H3-Acc-LoRAs (VideoX-Fun): Diffusers module names
  with ``.lora_down`` [r, in] / ``.lora_up`` [out, r] (no ``.weight`` suffix) plus the PDD
  per-interval output heads ``proj_out.{weight,bias}`` [N, 96, 5376] / [N, 96] and
  ``audio_proj_out.{weight,bias}`` [N, 32, 5376] / [N, 32]; safetensors metadata
  ``lora_rank``, ``lora_alpha``, ``pdd_num_steps``, ``pdd_block_size``, ``lora_targets``.
* ``peft_diffusers`` — PEFT／Diffusers ``.lora_A[.<slot>].weight`` [r, in] /
  ``.lora_B[.<slot>].weight`` [out, r] with one global alpha in metadata ``alpha`` /
  ``lora_alpha`` / ``network_alpha`` (absent in some releases, e.g. lightx2v
  ``fl2v_turbo_4step_v0.1``; the registry then needs an explicitly declared alpha so the
  runtime never falls back to alpha = rank, ``SGR:runtime/pipelines_core/lora/pipeline.py:797-815``).

Native layer names follow ``SGR:configs/models/dits/minimax_h3.py:17-84``: ``to_q/to_k/to_v``
fuse into ``attn.qkv_proj``, ``to_out.0`` → ``attn.out_proj``, ``ff.net.0.proj`` → ``mlp.fc1``,
``ff.net.2`` → ``mlp.fc2``, ``adaln_proj.linear`` passes through; the refiner maps
``token_refiner.refiner_blocks.N`` → ``token_refiner.blocks.N``.  The runtime shim compares
SGLang's own mapping against :func:`expected_native_layers` and fails on any difference.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest

from . import constants as C

LORA_FORMAT_PDD = "pdd_videox_fun"
LORA_FORMAT_PEFT = "peft_diffusers"
LORA_FORMATS = (LORA_FORMAT_PDD, LORA_FORMAT_PEFT)
# manifest ``targets`` vocabulary (Diffusers module-name suffixes), in canonical order
TARGETS = ("to_q", "to_k", "to_v", "to_out.0", "ff.net.0.proj", "ff.net.2", "adaln_proj.linear")
ADALN_TARGET = "adaln_proj.linear"
PDD_HEAD_KEYS = ("proj_out.weight", "proj_out.bias", "audio_proj_out.weight", "audio_proj_out.bias")
# video head = latents_dim * patch volume (24 * 1 * 2 * 2), audio head = audio_latents_dim
PDD_VIDEO_HEAD_OUT = C.VIDEO_LATENT_CHANNELS * C.PATCH_SIZE[0] * C.PATCH_SIZE[1] * C.PATCH_SIZE[2]
PDD_AUDIO_HEAD_OUT = C.AUDIO_LATENT_CHANNELS
_ALPHA_METADATA_KEYS = ("lora_alpha", "network_alpha", "alpha")

_MODULE_RE = re.compile(
    r"^(?:transformer_blocks\.(?P<block>\d+)|token_refiner\.refiner_blocks\.(?P<refiner>\d+))"
    r"\.(?P<target>attn\.to_q|attn\.to_k|attn\.to_v|attn\.to_out\.0|ff\.net\.0\.proj|ff\.net\.2|adaln_proj\.linear)$"
)
_PDD_KEY_RE = re.compile(r"^(?P<module>.+)\.lora_(?P<half>down|up)$")
_PEFT_KEY_RE = re.compile(
    r"^(?:base_model\.model\.)?(?P<module>.+)\.lora_(?P<half>[AB])(?:\.(?P<slot>[^.]+))?\.weight$"
)
_SHORT_TARGET = {
    "attn.to_q": "to_q",
    "attn.to_k": "to_k",
    "attn.to_v": "to_v",
    "attn.to_out.0": "to_out.0",
    "ff.net.0.proj": "ff.net.0.proj",
    "ff.net.2": "ff.net.2",
    "adaln_proj.linear": ADALN_TARGET,
}
_NATIVE_TARGET = {
    "attn.to_q": "attn.qkv_proj",
    "attn.to_k": "attn.qkv_proj",
    "attn.to_v": "attn.qkv_proj",
    "attn.to_out.0": "attn.out_proj",
    "ff.net.0.proj": "mlp.fc1",
    "ff.net.2": "mlp.fc2",
    "adaln_proj.linear": "adaln_proj.linear",
}
# (in_features, out_features) of each Diffusers module of the dense H3 DiT (H3:transformer/config.json)
_MODULE_DIMS = {
    "attn.to_q": (C.DIT_HIDDEN, C.DIT_HEADS * C.DIT_HEAD_DIM),
    "attn.to_k": (C.DIT_HIDDEN, C.DIT_HEADS * C.DIT_HEAD_DIM),
    "attn.to_v": (C.DIT_HIDDEN, C.DIT_HEADS * C.DIT_HEAD_DIM),
    "attn.to_out.0": (C.DIT_HEADS * C.DIT_HEAD_DIM, C.DIT_HIDDEN),
    "ff.net.0.proj": (C.DIT_HIDDEN, 2 * C.DIT_FFN),
    "ff.net.2": (C.DIT_FFN, C.DIT_HIDDEN),
    "adaln_proj.linear": (C.DIT_TIME_EMBED_DIM, C.DIT_ADALN_OUT),
}
_DTYPE_BYTES = {"F64": 8, "F32": 4, "BF16": 2, "F16": 2, "I64": 8, "I32": 4, "U8": 1, "I8": 1, "BOOL": 1}


def _target_order(target: str) -> int:
    return TARGETS.index(target) if target in TARGETS else len(TARGETS)


def _float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def analyze_lora_header(
    tensors: Mapping[str, tuple[str, Sequence[int]]],
    metadata: Mapping[str, str] | None = None,
    *,
    check_dims: bool = True,
) -> dict[str, Any]:
    """Facts of one LoRA safetensors file from its header (``name -> (dtype, shape)``).

    Never raises on a malformed file: everything wrong lands in ``problems`` and every key
    that is neither a LoRA factor nor a PDD head lands in ``unmatched_keys``.  ``check_dims``
    compares in/out features with the dense H3 DiT (registry verify); the runtime checks the
    loaded layers themselves instead.
    """
    metadata = dict(metadata or {})
    problems: list[str] = []
    halves: dict[str, dict[str, tuple[str, tuple[int, ...]]]] = {}
    unmatched: list[str] = []
    formats: set[str] = set()
    heads: dict[str, tuple[str, tuple[int, ...]]] = {}
    slots: set[str] = set()
    for name, (dtype, shape) in sorted(tensors.items()):
        shape_t = tuple(int(d) for d in shape)
        if name in PDD_HEAD_KEYS:
            heads[name] = (dtype, shape_t)
            continue
        pdd_key = _PDD_KEY_RE.match(name)
        peft = _PEFT_KEY_RE.match(name)
        if pdd_key is not None:
            formats.add(LORA_FORMAT_PDD)
            module, half = pdd_key.group("module"), "A" if pdd_key.group("half") == "down" else "B"
        elif peft is not None:
            formats.add(LORA_FORMAT_PEFT)
            module, half = peft.group("module"), peft.group("half")
            if peft.group("slot"):
                slots.add(peft.group("slot"))
        else:
            unmatched.append(name)
            continue
        if _MODULE_RE.match(module) is None:
            unmatched.append(name)
            continue
        if half in halves.setdefault(module, {}):
            problems.append(f"{module}.lora_{half} 重複（多個 adapter slot？）")
        halves[module][half] = (dtype, shape_t)
    if len(slots) > 1:
        problems.append(f"PEFT 檔含多個 adapter slot：{sorted(slots)}")
    if heads:
        formats.add(LORA_FORMAT_PDD)
    if len(formats) > 1:
        problems.append("同一檔案混用 lora_down/lora_up 與 lora_A/lora_B 命名")
    fmt = next(iter(formats)) if len(formats) == 1 else None

    ranks: set[int] = set()
    targets: set[str] = set()
    blocks: set[int] = set()
    refiners: set[int] = set()
    dtypes: set[str] = set()
    for module, pair in sorted(halves.items()):
        match = _MODULE_RE.match(module)
        assert match is not None
        if set(pair) != {"A", "B"}:
            problems.append(f"{module} 缺少 LoRA {'B' if 'A' in pair else 'A'} 半邊")
            continue
        (a_dtype, a_shape), (b_dtype, b_shape) = pair["A"], pair["B"]
        dtypes.update((a_dtype, b_dtype))
        if len(a_shape) != 2 or len(b_shape) != 2 or a_shape[0] != b_shape[1]:
            problems.append(f"{module} 的 A{list(a_shape)}／B{list(b_shape)} 形狀不是 [r,in]／[out,r]")
            continue
        target = match.group("target")
        expected_in, expected_out = _MODULE_DIMS[target]
        if check_dims and (a_shape[1], b_shape[0]) != (expected_in, expected_out):
            problems.append(
                f"{module} 的 in/out={a_shape[1]}/{b_shape[0]} 與 H3 DiT 的 {expected_in}/{expected_out} 不符"
            )
        ranks.add(int(a_shape[0]))
        targets.add(_SHORT_TARGET[target])
        if match.group("block") is not None:
            blocks.add(int(match.group("block")))
        else:
            refiners.add(int(match.group("refiner")))
            if target == "adaln_proj.linear":  # the refiner has no AdaLN in the pinned model
                problems.append(f"{module}：token refiner 沒有 adaln_proj")
    if len(ranks) > 1:
        problems.append(f"rank 不一致：{sorted(ranks)}（混合 rank 的全域 alpha 語意不明）")
    rank = next(iter(ranks)) if len(ranks) == 1 else None

    alpha_key = next((k for k in _ALPHA_METADATA_KEYS if k in metadata), None)
    alpha_values = {k: _float(metadata[k]) for k in _ALPHA_METADATA_KEYS if k in metadata}
    if any(v is None or v <= 0 for v in alpha_values.values()):
        problems.append(f"metadata alpha 不是正數：{ {k: metadata[k] for k in alpha_values} }")
    if len({v for v in alpha_values.values() if v is not None}) > 1:
        problems.append(f"metadata alpha 互相矛盾：{alpha_values}")
    alpha = alpha_values.get(alpha_key) if alpha_key else None
    declared_rank = _float(metadata.get("lora_rank"))
    if declared_rank is not None and rank is not None and int(declared_rank) != rank:
        problems.append(f"metadata lora_rank={metadata['lora_rank']} 與張量 rank {rank} 不符")

    pdd: dict[str, int] | None = None
    if heads or fmt == LORA_FORMAT_PDD:
        missing = [k for k in PDD_HEAD_KEYS if k not in heads]
        if missing:
            problems.append(f"PDD 格式缺少輸出頭：{missing}")
        else:
            n = heads["proj_out.weight"][1][0] if heads["proj_out.weight"][1] else 0
            expected = {
                "proj_out.weight": (n, PDD_VIDEO_HEAD_OUT, C.DIT_HIDDEN),
                "proj_out.bias": (n, PDD_VIDEO_HEAD_OUT),
                "audio_proj_out.weight": (n, PDD_AUDIO_HEAD_OUT, C.DIT_HIDDEN),
                "audio_proj_out.bias": (n, PDD_AUDIO_HEAD_OUT),
            }
            for key, shape in expected.items():
                have = heads[key][1]
                if (check_dims and have != shape) or len(have) != len(shape) or (have and have[0] != n):
                    problems.append(f"PDD {key} 形狀 {list(have)} ≠ {list(shape)}")
            dtypes.update(dtype for dtype, _ in heads.values())
            meta_steps = _float(metadata.get("pdd_num_steps"))
            meta_block = _float(metadata.get("pdd_block_size"))
            if meta_steps is not None and int(meta_steps) != n:
                problems.append(f"metadata pdd_num_steps={metadata['pdd_num_steps']} 與輸出頭數 {n} 不符")
            if meta_block is None:
                problems.append("PDD 檔缺少 metadata pdd_block_size")
            else:
                block = int(meta_block)
                if block < 1 or n % block:
                    problems.append(f"PDD 輸出頭數 {n} 不能被 block_size {block} 整除")
                pdd = {"num_steps": int(n), "block_size": block}
        declared_targets = metadata.get("lora_targets")
        if declared_targets is not None:
            declared = {t.strip() for t in declared_targets.split(",") if t.strip()}
            if declared != targets:
                problems.append(f"metadata lora_targets {sorted(declared)} 與實際張量 {sorted(targets)} 不符")

    tensor_bytes = 0
    for dtype, shape in tensors.values():
        count = 1
        for dim in shape:
            count *= int(dim)
        tensor_bytes += count * _DTYPE_BYTES.get(dtype, 0)
    return {
        "format": fmt,
        "rank": rank,
        "alpha_metadata": alpha,
        "alpha_metadata_key": alpha_key,
        "targets": sorted(targets, key=_target_order),
        "touches_adaln": ADALN_TARGET in targets,
        "transformer_blocks": sorted(blocks),
        "refiner_blocks": sorted(refiners),
        "modules": sorted(halves),
        "native_layers": len(expected_native_layers(halves, include_adaln=True)),
        "pdd": pdd,
        "dtypes": sorted(dtypes),
        "tensor_count": len(tensors),
        "tensor_bytes": tensor_bytes,
        "unmatched_keys": unmatched[:50],
        "unmatched_count": len(unmatched),
        "problems": problems,
    }


def expected_native_layers(diffusers_modules: Iterable[str], *, include_adaln: bool) -> list[str]:
    """SGLang-native layer names the modules map to (``to_q/k/v`` fuse into one ``qkv_proj``)."""
    out: set[str] = set()
    for module in diffusers_modules:
        match = _MODULE_RE.match(module)
        if match is None:
            continue
        target = match.group("target")
        if target == "adaln_proj.linear" and not include_adaln:
            continue
        prefix = (
            f"blocks.{match.group('block')}"
            if match.group("block") is not None
            else f"token_refiner.blocks.{match.group('refiner')}"
        )
        out.add(f"{prefix}.{_NATIVE_TARGET[target]}")
    return sorted(out)


# ---------------------------------------------------------------------------
# identities (component keys, AdaLN cache keys, sidecar signatures)


def lora_identity(binding: Mapping[str, Any]) -> dict[str, Any]:
    """Numerically relevant identity of one plan LoRA binding."""
    manifest = binding["manifest"]
    return {
        "lora_id": str(binding["lora_id"]),
        "revision": str(binding["revision"]),
        "sha256": str(manifest["file"]["sha256"]),
        "format": str(manifest["format"]),
        "rank": int(manifest["rank"]),
        "alpha": float(manifest["alpha"]),
        "scale": float(binding["scale"]),
    }


def pdd_blocks(manifest: Mapping[str, Any]) -> tuple[int, ...] | None:
    """The manifest's non-uniform PDD grouping ``pdd.blocks`` (interval counts per fused head), None when absent.

    Without ``pdd.blocks`` a PDD manifest groups its ``num_steps`` intervals uniformly by ``block_size``.  Call
    :func:`pdd_blocks_problems` first: this returns None for anything that is not a well-formed list.
    """
    pdd = manifest.get("pdd")
    raw = pdd.get("blocks") if isinstance(pdd, Mapping) else None
    if not isinstance(raw, list) or not raw:
        return None
    if not all(isinstance(b, int) and not isinstance(b, bool) for b in raw):
        return None
    return tuple(int(b) for b in raw)


def pdd_blocks_problems(manifest: Mapping[str, Any]) -> list[str]:
    """Why a manifest's ``pdd.blocks`` cannot run (empty when it is absent or valid).

    Valid: a PDD manifest, positive integers summing to ``pdd.num_steps``, and ``sampling_contract.steps`` equal
    to ``[len(blocks)]`` (one DiT update per fused head).
    """
    pdd = manifest.get("pdd")
    if not isinstance(pdd, Mapping) or "blocks" not in pdd:
        return []
    raw = pdd.get("blocks")
    blocks = pdd_blocks(manifest)
    if blocks is None or min(blocks) < 1:
        return [f"pdd.blocks={raw!r} 必須是正整數清單"]
    problems: list[str] = []
    if manifest.get("format") != LORA_FORMAT_PDD:
        problems.append(f"pdd.blocks 只適用 {LORA_FORMAT_PDD}，此 manifest 是 {manifest.get('format')}")
    num_steps = pdd.get("num_steps")
    if sum(blocks) != num_steps:
        problems.append(f"pdd.blocks {list(blocks)} 的總和 {sum(blocks)} 不等於 pdd.num_steps={num_steps}")
    steps = (manifest.get("sampling_contract") or {}).get("steps")
    if steps != [len(blocks)]:
        problems.append(
            f"pdd.blocks 有 {len(blocks)} 組（{len(blocks)} 次 DiT 更新），sampling_contract.steps 必須是 "
            f"[{len(blocks)}]，目前是 {steps}"
        )
    return problems


def bindings_pdd_blocks(bindings: Sequence[Mapping[str, Any]]) -> tuple[int, ...] | None:
    """The plan's non-uniform PDD grouping (the one PDD binding's ``pdd.blocks``), None for uniform or no PDD."""
    for binding in bindings:
        manifest = binding.get("manifest") or {}
        if manifest.get("format") == LORA_FORMAT_PDD:
            blocks = pdd_blocks(manifest)
            if blocks is not None:
                return blocks
    return None


def adapters_signature(bindings: Sequence[Mapping[str, Any]], *, merge_mode: str = "dynamic") -> str:
    """Identity of every LoRA applied to the DiT ("none" when there is none)."""
    entries = sorted((lora_identity(b) for b in bindings), key=lambda e: (e["lora_id"], e["revision"], e["sha256"]))
    if not entries:
        return "none"
    return canonical_digest({"kind": "h3_lora_adapters_v1", "merge_mode": merge_mode, "loras": entries})


def adaln_lora_signature(bindings: Sequence[Mapping[str, Any]]) -> str:
    """Identity of the LoRAs that change AdaLN outputs ("none": base AdaLN cache is shared).

    Turbo (no ``adaln_proj`` factors) never enters, so it reuses the base sidecar; PDD does,
    so its sidecar must be built with the LoRA applied and carry this exact signature.
    """
    entries = sorted(
        ({**lora_identity(b), "targets": [ADALN_TARGET]} for b in bindings if b["manifest"].get("touches_adaln")),
        key=lambda e: (e["lora_id"], e["revision"], e["sha256"]),
    )
    if not entries:
        return "none"
    return canonical_digest({"kind": "h3_adaln_lora_v1", "loras": entries})


# ---------------------------------------------------------------------------
# dynamic LoRA working memory (phasyn_h3.recipe.runtime.lora_inplace)

# Tokens per in-place chunk of the dynamic LoRA term (profile extension ``phasyn.sglang_h3.lora``
# ``dynamic_chunk_tokens``; 0 = the whole sequence in one ``addmm_``, still in place).
DEFAULT_DYNAMIC_CHUNK_TOKENS = 4096
MAX_DYNAMIC_CHUNK_TOKENS = 1 << 20
# native DiT LoRA targets per block: (in_features, out_features, stacked groups of the factors)
DIT_LORA_LAYER_DIMS: Mapping[str, tuple[int, int, int]] = {
    "attn.qkv_proj": (C.DIT_HIDDEN, 3 * C.DIT_HEADS * C.DIT_HEAD_DIM, 3),
    "attn.out_proj": (C.DIT_HEADS * C.DIT_HEAD_DIM, C.DIT_HIDDEN, 1),
    "mlp.fc1": (C.DIT_HIDDEN, 2 * C.DIT_FFN, 1),
    "mlp.fc2": (C.DIT_FFN, C.DIT_HIDDEN, 1),
}


__all__ = [
    "ADALN_TARGET",
    "DEFAULT_DYNAMIC_CHUNK_TOKENS",
    "DIT_LORA_LAYER_DIMS",
    "LORA_FORMATS",
    "LORA_FORMAT_PDD",
    "LORA_FORMAT_PEFT",
    "MAX_DYNAMIC_CHUNK_TOKENS",
    "PDD_HEAD_KEYS",
    "TARGETS",
    "adaln_lora_signature",
    "adapters_signature",
    "analyze_lora_header",
    "bindings_pdd_blocks",
    "expected_native_layers",
    "lora_identity",
    "pdd_blocks",
    "pdd_blocks_problems",
]
