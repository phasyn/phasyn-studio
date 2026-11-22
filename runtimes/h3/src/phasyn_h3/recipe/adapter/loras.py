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
from dataclasses import dataclass
from typing import Any

from phasyn_h3.recipe.abi.canonical import canonical_digest

from . import constants


_MATRIX_RANK = 2


LORA_FORMAT_PDD = "pdd_videox_fun"
LORA_FORMAT_PEFT = "peft_diffusers"
LORA_FORMATS = (LORA_FORMAT_PDD, LORA_FORMAT_PEFT)
# manifest ``targets`` vocabulary (Diffusers module-name suffixes), in canonical order
TARGETS = (
    "to_q",
    "to_k",
    "to_v",
    "to_out.0",
    "ff.net.0.proj",
    "ff.net.2",
    "adaln_proj.linear",
)
ADALN_TARGET = "adaln_proj.linear"
PDD_HEAD_KEYS = (
    "proj_out.weight",
    "proj_out.bias",
    "audio_proj_out.weight",
    "audio_proj_out.bias",
)
# video head = latents_dim * patch volume (24 * 1 * 2 * 2), audio head = audio_latents_dim
PDD_VIDEO_HEAD_OUT = (
    constants.VIDEO_LATENT_CHANNELS
    * constants.PATCH_SIZE[0]
    * constants.PATCH_SIZE[1]
    * constants.PATCH_SIZE[2]
)
PDD_AUDIO_HEAD_OUT = constants.AUDIO_LATENT_CHANNELS
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
    "attn.to_q": (constants.DIT_HIDDEN, constants.DIT_HEADS * constants.DIT_HEAD_DIM),
    "attn.to_k": (constants.DIT_HIDDEN, constants.DIT_HEADS * constants.DIT_HEAD_DIM),
    "attn.to_v": (constants.DIT_HIDDEN, constants.DIT_HEADS * constants.DIT_HEAD_DIM),
    "attn.to_out.0": (
        constants.DIT_HEADS * constants.DIT_HEAD_DIM,
        constants.DIT_HIDDEN,
    ),
    "ff.net.0.proj": (constants.DIT_HIDDEN, 2 * constants.DIT_FFN),
    "ff.net.2": (constants.DIT_FFN, constants.DIT_HIDDEN),
    "adaln_proj.linear": (constants.DIT_TIME_EMBED_DIM, constants.DIT_ADALN_OUT),
}
_DTYPE_BYTES = {
    "F64": 8,
    "F32": 4,
    "BF16": 2,
    "F16": 2,
    "I64": 8,
    "I32": 4,
    "U8": 1,
    "I8": 1,
    "BOOL": 1,
}


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
    halves, unmatched, heads, fmt = _group_lora_tensors(tensors, problems)

    facts = _analyze_modules(halves, problems, check_dims=check_dims)
    rank, targets, blocks, refiners, dtypes = (
        facts.rank,
        facts.targets,
        facts.blocks,
        facts.refiners,
        facts.dtypes,
    )

    alpha_key, alpha = _lora_alpha(metadata, rank, problems)

    pdd = (
        _pdd_facts(heads, metadata, facts, problems, check_dims=check_dims)
        if heads or fmt == LORA_FORMAT_PDD
        else None
    )

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


def expected_native_layers(
    diffusers_modules: Iterable[str], *, include_adaln: bool
) -> list[str]:
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
        problems.append(
            f"pdd.blocks 只適用 {LORA_FORMAT_PDD}，此 manifest 是 {manifest.get('format')}"
        )
    num_steps = pdd.get("num_steps")
    if sum(blocks) != num_steps:
        problems.append(
            f"pdd.blocks {list(blocks)} 的總和 {sum(blocks)} 不等於 pdd.num_steps={num_steps}"
        )
    steps = (manifest.get("sampling_contract") or {}).get("steps")
    if steps != [len(blocks)]:
        problems.append(
            f"pdd.blocks 有 {len(blocks)} 組（{len(blocks)} 次 DiT 更新），sampling_contract.steps 必須是 "
            f"[{len(blocks)}]，目前是 {steps}"
        )
    return problems


def bindings_pdd_blocks(
    bindings: Sequence[Mapping[str, Any]],
) -> tuple[int, ...] | None:
    """The plan's non-uniform PDD grouping (the one PDD binding's ``pdd.blocks``), None for uniform or no PDD."""
    for binding in bindings:
        manifest = binding.get("manifest") or {}
        if manifest.get("format") == LORA_FORMAT_PDD:
            blocks = pdd_blocks(manifest)
            if blocks is not None:
                return blocks
    return None


def adapters_signature(
    bindings: Sequence[Mapping[str, Any]], *, merge_mode: str = "dynamic"
) -> str:
    """Identity of every LoRA applied to the DiT ("none" when there is none).

    One LoRA: the digest of today (a one-element list is its own sorted order).  A stack keeps the
    configured order — the factors are concatenated in that order, so another order is another
    rounding — and names the stacking arithmetic (:data:`STACK_ALGORITHM`).
    """
    entries = [lora_identity(b) for b in bindings]
    if not entries:
        return "none"
    doc: dict[str, Any] = {
        "kind": "h3_lora_adapters_v1",
        "merge_mode": merge_mode,
        "loras": entries,
    }
    if len(entries) > 1:
        doc["stack"] = STACK_ALGORITHM
    return canonical_digest(doc)


def adaln_lora_signature(bindings: Sequence[Mapping[str, Any]]) -> str:
    """Identity of the LoRAs that change AdaLN outputs ("none": base AdaLN cache is shared).

    Turbo (no ``adaln_proj`` factors) never enters, so it reuses the base sidecar; PDD does,
    so its sidecar must be built with the LoRA applied and carry this exact signature.  In a
    stack only the AdaLN-touching members enter: PDD plus a LoRA without ``adaln_proj`` factors
    keeps the PDD sidecar; two AdaLN-touching members need a sidecar built with both, in order.
    """
    entries = [
        {**lora_identity(b), "targets": [ADALN_TARGET]}
        for b in bindings
        if b["manifest"].get("touches_adaln")
    ]
    if not entries:
        return "none"
    doc: dict[str, Any] = {"kind": "h3_adaln_lora_v1", "loras": entries}
    if len(entries) > 1:
        doc["stack"] = STACK_ALGORITHM
    return canonical_digest(doc)


# ---------------------------------------------------------------------------
# LoRA stacks (several LoRAs on one DiT: one accelerator + additive style/concept LoRAs)

ROLE_ACCELERATION = "acceleration"
ROLE_STYLE = "style"
LORA_ROLES = (ROLE_ACCELERATION, ROLE_STYLE)
# most LoRAs one DiT takes at once (each adds its factors on the DiT device)
MAX_STACK = 4
# how a stack is applied (recipe/runtime/lora_stack.py): per layer, the members' factors are concatenated
# along the rank (A rows, B columns); a layer only one member touches keeps that member's factors as is
STACK_ALGORITHM = "rank_concat_v1"


def lora_role(manifest: Mapping[str, Any]) -> str:
    """``acceleration`` (owns the sampling contract) or ``style`` (additive) of one manifest.

    An explicit manifest ``role`` wins.  Otherwise a PDD or PTD LoRA (fused output heads, per-step
    adapters) and any LoRA whose sampling contract excludes the native schedule
    (:data:`constants.DEFAULT_STEPS`, e.g. Turbo 4/8 steps) is an accelerator; the rest are style LoRAs.
    """
    declared = manifest.get("role")
    if declared in LORA_ROLES:
        return str(declared)
    if manifest.get("format") == LORA_FORMAT_PDD or manifest.get("ptd") is not None:
        return ROLE_ACCELERATION
    steps = (manifest.get("sampling_contract") or {}).get("steps")
    if isinstance(steps, list) and steps and constants.DEFAULT_STEPS not in steps:
        return ROLE_ACCELERATION
    return ROLE_STYLE


def stack_accelerator(manifests: Sequence[Mapping[str, Any]]) -> int | None:
    """Index of the stack's accelerator (the member whose sampling contract applies), None when none."""
    found = [i for i, m in enumerate(manifests) if lora_role(m) == ROLE_ACCELERATION]
    return found[0] if found else None


def contract_enforced(manifests: Sequence[Mapping[str, Any]], index: int) -> bool:
    """Whether member ``index``'s sampling contract binds the run.

    A single LoRA, every member of a stack without an accelerator, and the accelerator itself: yes.
    A style member next to an accelerator: no — the accelerator's grid is the one the run uses (its
    PDD heads, Turbo distillation); the style LoRA's own contract (usually the native 50 steps) only
    describes where it was trained.
    """
    if len(manifests) <= 1:
        return True
    owner = stack_accelerator(manifests)
    return owner is None or owner == index


@dataclass(frozen=True)
class StackProblem:
    """One reason a list of LoRAs cannot be stacked."""

    reason: str
    message: str
    index: int | None = None


def stack_problems(manifests: Sequence[Mapping[str, Any]]) -> list[StackProblem]:
    """Why these manifests (in configured order) cannot run together; empty for zero or one LoRA."""
    if len(manifests) <= 1:
        return []
    out: list[StackProblem] = []
    if len(manifests) > MAX_STACK:
        out.append(
            StackProblem(
                "LORA_STACK_TOO_MANY",
                f"一次最多串接 {MAX_STACK} 個 LoRA，收到 {len(manifests)} 個",
            )
        )
    seen: dict[str, int] = {}
    for index, manifest in enumerate(manifests):
        lora_id = str(manifest.get("lora_id"))
        if lora_id in seen:
            out.append(
                StackProblem(
                    "LORA_STACK_DUPLICATE",
                    f"LoRA {lora_id} 在串接清單出現兩次（第 {seen[lora_id] + 1} 與第 {index + 1} 項）；"
                    "要加強請調整該項的 scale",
                    index,
                )
            )
        seen.setdefault(lora_id, index)
        if manifest.get("ptd") is not None:
            out.append(
                StackProblem(
                    "LORA_STACK_PTD",
                    f"LoRA {lora_id} 是 PTD（每步換一組 adapter），不能與其他 LoRA 串接",
                    index,
                )
            )
        if (
            manifest.get("format") == LORA_FORMAT_PDD
            and lora_role(manifest) != ROLE_ACCELERATION
        ):
            out.append(
                StackProblem(
                    "LORA_STACK_PDD_NOT_ADDITIVE",
                    f"LoRA {lora_id} 是 PDD 格式（帶融合輸出頭 proj_out／audio_proj_out），只能當加速 LoRA，"
                    "不能宣告成疊加用的 style LoRA",
                    index,
                )
            )
    accelerators = [
        i for i, m in enumerate(manifests) if lora_role(m) == ROLE_ACCELERATION
    ]
    if len(accelerators) > 1:
        names = "、".join(str(manifests[i].get("lora_id")) for i in accelerators)
        out.append(
            StackProblem(
                "LORA_STACK_ACCELERATORS",
                f"串接清單最多一個加速 LoRA（各自帶不同的採樣合約），目前有 {len(accelerators)} 個：{names}",
                accelerators[1],
            )
        )
    elif not accelerators:
        grids = {_contract_grid(m) for m in manifests if _contract_grid(m) is not None}
        has_steps = any(
            (m.get("sampling_contract") or {}).get("steps") for m in manifests
        )
        if len(grids) > 1 or (has_steps and stack_accepted_steps(manifests) is None):
            out.append(
                StackProblem(
                    "LORA_STACK_CONTRACT_CONFLICT",
                    "串接的 LoRA 採樣合約互相衝突（steps／shift 沒有共同值），沒有加速 LoRA 可以決定網格",
                )
            )
    return out


def stack_accepted_steps(manifests: Sequence[Mapping[str, Any]]) -> list[int] | None:
    """Steps the stack accepts: the accelerator's contract, else the members' common steps (None: no contract)."""
    if not manifests:
        return None
    owner = stack_accelerator(manifests) if len(manifests) > 1 else None
    members = [manifests[owner]] if owner is not None else list(manifests)
    common: set[int] | None = None
    for manifest in members:
        steps = (manifest.get("sampling_contract") or {}).get("steps")
        if not isinstance(steps, list) or not steps:
            continue
        valid = {
            s
            for s in steps
            if isinstance(s, int) and not isinstance(s, bool) and s >= 1
        }
        if len(valid) != len(steps):
            return None
        common = valid if common is None else common & valid
    return sorted(common) if common else None


def _contract_grid(manifest: Mapping[str, Any]) -> tuple[Any, ...] | None:
    contract = manifest.get("sampling_contract")
    if not isinstance(contract, Mapping):
        return None
    # the steps are compared as a set intersection (stack_accepted_steps); the grid is shifts + scheduler
    return (
        contract.get("video_shift"),
        contract.get("audio_shift"),
        contract.get("scheduler", constants.SCHEDULER_ID),
    )


# ---------------------------------------------------------------------------
# dynamic LoRA working memory (phasyn_h3.recipe.runtime.lora_inplace)

# Tokens per in-place chunk of the dynamic LoRA term (profile extension ``phasyn.sglang_h3.lora``
# ``dynamic_chunk_tokens``; 0 = the whole sequence in one ``addmm_``, still in place).
DEFAULT_DYNAMIC_CHUNK_TOKENS = 4096
MAX_DYNAMIC_CHUNK_TOKENS = 1 << 20
# native DiT LoRA targets per block: (in_features, out_features, stacked groups of the factors)
DIT_LORA_LAYER_DIMS: Mapping[str, tuple[int, int, int]] = {
    "attn.qkv_proj": (
        constants.DIT_HIDDEN,
        3 * constants.DIT_HEADS * constants.DIT_HEAD_DIM,
        3,
    ),
    "attn.out_proj": (
        constants.DIT_HEADS * constants.DIT_HEAD_DIM,
        constants.DIT_HIDDEN,
        1,
    ),
    "mlp.fc1": (constants.DIT_HIDDEN, 2 * constants.DIT_FFN, 1),
    "mlp.fc2": (constants.DIT_FFN, constants.DIT_HIDDEN, 1),
}


__all__ = [
    "ADALN_TARGET",
    "DEFAULT_DYNAMIC_CHUNK_TOKENS",
    "DIT_LORA_LAYER_DIMS",
    "LORA_FORMATS",
    "LORA_FORMAT_PDD",
    "LORA_FORMAT_PEFT",
    "LORA_ROLES",
    "MAX_DYNAMIC_CHUNK_TOKENS",
    "MAX_STACK",
    "PDD_HEAD_KEYS",
    "ROLE_ACCELERATION",
    "ROLE_STYLE",
    "STACK_ALGORITHM",
    "TARGETS",
    "StackProblem",
    "adaln_lora_signature",
    "adapters_signature",
    "analyze_lora_header",
    "bindings_pdd_blocks",
    "contract_enforced",
    "expected_native_layers",
    "lora_identity",
    "lora_role",
    "pdd_blocks",
    "pdd_blocks_problems",
    "stack_accelerator",
    "stack_accepted_steps",
    "stack_problems",
]


@dataclass(frozen=True)
class _ModuleFacts:
    rank: int | None
    targets: set[str]
    blocks: set[int]
    refiners: set[int]
    dtypes: set[str]


def _group_lora_tensors(
    tensors: Mapping[str, tuple[str, Sequence[int]]], problems: list[str]
) -> tuple[
    dict[str, dict[str, tuple[str, tuple[int, ...]]]],
    list[str],
    dict[str, tuple[str, tuple[int, ...]]],
    str | None,
]:
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
            module, half = (
                pdd_key.group("module"),
                "A" if pdd_key.group("half") == "down" else "B",
            )
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
    fmt = _header_format(slots, heads, formats, problems)
    return halves, unmatched, heads, fmt


def _analyze_modules(
    halves: dict[str, dict[str, tuple[str, tuple[int, ...]]]],
    problems: list[str],
    *,
    check_dims: bool,
) -> _ModuleFacts:
    ranks: set[int] = set()
    targets: set[str] = set()
    blocks: set[int] = set()
    refiners: set[int] = set()
    dtypes: set[str] = set()
    for module, pair in sorted(halves.items()):
        match = _MODULE_RE.match(module)
        if not (match is not None):
            raise AssertionError
        if set(pair) != {"A", "B"}:
            problems.append(f"{module} 缺少 LoRA {'B' if 'A' in pair else 'A'} 半邊")
            continue
        (a_dtype, a_shape), (b_dtype, b_shape) = pair["A"], pair["B"]
        dtypes.update((a_dtype, b_dtype))
        if (
            len(a_shape) != _MATRIX_RANK
            or len(b_shape) != _MATRIX_RANK
            or a_shape[0] != b_shape[1]
        ):
            problems.append(
                f"{module} 的 A{list(a_shape)}／B{list(b_shape)} 形狀不是 [r,in]／[out,r]"
            )
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
            if (
                target == "adaln_proj.linear"
            ):  # the refiner has no AdaLN in the pinned model
                problems.append(f"{module}：token refiner 沒有 adaln_proj")
    if len(ranks) > 1:
        problems.append(
            f"rank 不一致：{sorted(ranks)}（混合 rank 的全域 alpha 語意不明）"
        )
    rank = next(iter(ranks)) if len(ranks) == 1 else None
    return _ModuleFacts(rank, targets, blocks, refiners, dtypes)


def _lora_alpha(
    metadata: Mapping[str, str], rank: int | None, problems: list[str]
) -> tuple[str | None, float | None]:
    alpha_key = next((k for k in _ALPHA_METADATA_KEYS if k in metadata), None)
    alpha_values = {
        k: _float(metadata[k]) for k in _ALPHA_METADATA_KEYS if k in metadata
    }
    if any(v is None or v <= 0 for v in alpha_values.values()):
        problems.append(
            f"metadata alpha 不是正數：{ {k: metadata[k] for k in alpha_values} }"
        )
    if len({v for v in alpha_values.values() if v is not None}) > 1:
        problems.append(f"metadata alpha 互相矛盾：{alpha_values}")
    alpha = alpha_values.get(alpha_key) if alpha_key else None
    declared_rank = _float(metadata.get("lora_rank"))
    if declared_rank is not None and rank is not None and int(declared_rank) != rank:
        problems.append(
            f"metadata lora_rank={metadata['lora_rank']} 與張量 rank {rank} 不符"
        )
    return alpha_key, alpha


def _pdd_facts(
    heads: dict[str, tuple[str, tuple[int, ...]]],
    metadata: Mapping[str, str],
    facts: _ModuleFacts,
    problems: list[str],
    *,
    check_dims: bool,
) -> dict[str, int] | None:
    targets, dtypes = facts.targets, facts.dtypes
    pdd: dict[str, int] | None = None
    missing = [k for k in PDD_HEAD_KEYS if k not in heads]
    if missing:
        problems.append(f"PDD 格式缺少輸出頭：{missing}")
    else:
        n = heads["proj_out.weight"][1][0] if heads["proj_out.weight"][1] else 0
        expected = {
            "proj_out.weight": (n, PDD_VIDEO_HEAD_OUT, constants.DIT_HIDDEN),
            "proj_out.bias": (n, PDD_VIDEO_HEAD_OUT),
            "audio_proj_out.weight": (n, PDD_AUDIO_HEAD_OUT, constants.DIT_HIDDEN),
            "audio_proj_out.bias": (n, PDD_AUDIO_HEAD_OUT),
        }
        for key, shape in expected.items():
            have = heads[key][1]
            if (
                (check_dims and have != shape)
                or len(have) != len(shape)
                or (have and have[0] != n)
            ):
                problems.append(f"PDD {key} 形狀 {list(have)} ≠ {list(shape)}")
        dtypes.update(dtype for dtype, _ in heads.values())
        meta_steps = _float(metadata.get("pdd_num_steps"))
        meta_block = _float(metadata.get("pdd_block_size"))
        if meta_steps is not None and int(meta_steps) != n:
            problems.append(
                f"metadata pdd_num_steps={metadata['pdd_num_steps']} 與輸出頭數 {n} 不符"
            )
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
            problems.append(
                f"metadata lora_targets {sorted(declared)} 與實際張量 {sorted(targets)} 不符"
            )
    return pdd


def _header_format(
    slots: set[str], heads: Mapping[str, Any], formats: set[str], problems: list[str]
) -> str | None:
    if len(slots) > 1:
        problems.append(f"PEFT 檔含多個 adapter slot：{sorted(slots)}")
    if heads:
        formats.add(LORA_FORMAT_PDD)
    if len(formats) > 1:
        problems.append("同一檔案混用 lora_down/lora_up 與 lora_A/lora_B 命名")
    return next(iter(formats)) if len(formats) == 1 else None
