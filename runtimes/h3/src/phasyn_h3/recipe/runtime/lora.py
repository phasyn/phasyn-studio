# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/pipelines_core/lora/pipeline.py (LoRAPipeline.set_lora_adapter name mapping, in prepare_adapter)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0; that SGLang file is itself adapted from hao-ai-lab/FastVideo (Apache-2.0).
# Modified by the Phasyn Studio authors: applied to the stage-split DiT.
"""Dynamic LoRA on the stage-split H3 DiT (torch + pinned SGLang; imported lazily in the actor).

Pinned SGLang applies LoRA from ``LoRAPipeline.__init__`` of ``MiniMaxH3Pipeline``
(``SGR:runtime/pipelines_core/lora/pipeline.py:194-234``), which this shim never builds.  This module re-uses SGLang's pieces in the same order:

1. format normalization ``normalize_lora_state_dict`` (``format_adapter.py:611-645``) after
   splitting off the PDD heads (``--lora-path`` would silently drop them, §4.6 of the design);
2. name mapping ``lora_param_names_mapping`` → ``param_names_mapping`` with q/k/v stacking,
   the PEFT SwiGLU fc1 row swap and fused-group storage (``pipeline.py:1004-1053``:
   ``get_param_names_mapping``, ``_swap_peft_swiglu_fc1_lora_b``, ``_store_fused_lora_groups``);
3. ``MiniMaxH3DiTModel.prepare_lora_adapter`` (``minimax_h3.py:1915-1975``);
4. the ``*WithLoRA`` wrapper classes (``layers/lora/linear.py``) — as the shim's in-place
   subclasses (``lora_inplace``) — constructed directly with ``snapshot_base=False`` so a resident
   layer never gets a CPU weight copy (``wrap_with_lora_layer`` forces one, ``linear.py:902-907``),
   bound to the layerwise manager's CPU views like ``convert_module_lora_layers``
   (``pipeline.py:387-485``);
5. ``set_lora_weights(..., merge_weights=False)``: dynamic — the base GEMM (BF16 or quantized,
   ``quant_method.apply``) runs untouched and ``(x·Aᵀ)·Bᵀ·alpha/r·scale`` is accumulated into its
   output in place, ``dynamic_chunk_tokens`` rows at a time (upstream allocates a second
   full-size output, 2.03 GiB for fc1 at 768p).

Differences from upstream, all fail-closed: alpha comes from the plan (registry), never
from SGLang's alpha=rank fallback (``pipeline.py:797-815``); every key must map to exactly the
layers the registry facts predict (``phasyn_h3.recipe.adapter.loras.expected_native_layers``) — upstream
only logs uncovered layers (``pipeline.py:847-876``); merge is used only for the BF16
comparison arm and never unmerges (a component with LoRA is discarded, not reused).

A stack of LoRAs (``LoraPolicy.specs`` with more than one member) is prepared member by member with the
same strict path, then applied as one adapter per layer whose factors are the members' factors
concatenated along the rank (``lora_stack``); the PDD heads come from the stack's one PDD member.
"""

from __future__ import annotations

import hashlib
import threading
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple, TypedDict, Unpack

from phasyn_components.model_identity import display_path

from phasyn_h3.recipe.adapter.loras import (
    DEFAULT_DYNAMIC_CHUNK_TOKENS,
    PDD_HEAD_KEYS,
    STACK_ALGORITHM,
    analyze_lora_header,
    expected_native_layers,
)

from ._arguments import validate_keywords
from .errors import IntegrityMismatch, ModelFilesMissing, UnsupportedCombination
from .lora_inplace import inplace_wrapper_classes
from .lora_policy import LoraPolicy, LoraSpec
from .lora_stack import Contribution, stack_factors
from .model_root import model_root
from .pdd import install_pdd_heads


class _DynamicAdapterRequired(TypedDict):
    device: Any
    lora_path: str


class _DynamicAdapter(_DynamicAdapterRequired, total=False):
    merge: bool
    chunk_tokens: int


_QKV_PARTS = 3
_GROUPED_WEIGHT_RANK = 3


_LORA_SUFFIXES = (".lora_A", ".lora_B")
_SHA_CACHE: dict[tuple[str, int, int], str] = {}
_SHA_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# file


def lora_file(spec: LoraSpec, *, root: Path | None = None) -> Path:
    """``PHASYN_MODEL_ROOT`` + manifest relative path; never escapes the root."""
    base = (root or model_root()).resolve()
    path = (base / spec.relative_path).resolve()
    if base not in path.parents:
        raise ModelFilesMissing(
            "PATH_ESCAPES_ROOT", f"LoRA 路徑 {spec.relative_path} 逃出 model root"
        )
    if not path.is_file():
        raise ModelFilesMissing(
            "LORA_NOT_ON_DISK",
            f"LoRA 檔不存在：{display_path(path, base)}（不自動下載；先取得並 verify）",
        )
    return path


def verify_lora_file(path: Path, spec: LoraSpec) -> str:
    """Size + sha256 against the frozen manifest (hash cached per (path, size, mtime))."""
    stat = path.stat()
    if stat.st_size != spec.size_bytes:
        raise IntegrityMismatch(
            "LORA_SIZE_MISMATCH",
            f"{path.name} 大小 {stat.st_size} ≠ registry {spec.size_bytes}",
            expected=spec.size_bytes,
            actual=stat.st_size,
        )
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _SHA_LOCK:
        digest = _SHA_CACHE.get(key)
    if digest is None:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for block in iter(lambda: fh.read(8 << 20), b""):
                h.update(block)
        digest = h.hexdigest()
        with _SHA_LOCK:
            _SHA_CACHE[key] = digest
    if digest != spec.sha256:
        raise IntegrityMismatch(
            "LORA_SHA256_MISMATCH",
            f"{path.name} 的 sha256 與 registry 不符",
            expected=spec.sha256,
            actual=digest,
        )
    return digest


def read_lora_file(path: Path) -> tuple[dict[str, Any], dict[str, str]]:
    """Read adapter tensors from the LoRA weights."""
    from safetensors import safe_open

    with safe_open(str(path), framework="pt", device="cpu") as fh:
        metadata = dict(fh.metadata() or {})
        tensors = {name: fh.get_tensor(name) for name in fh.keys()}  # noqa: SIM118 - safe_open has no __iter__
    return tensors, metadata


# ---------------------------------------------------------------------------
# normalize + map (SGLang's own functions, strict coverage)


@dataclass
class PreparedAdapter:
    """Hold the loaded LoRA tensors and their resolved settings."""

    tensors: dict[
        str, Any
    ]  # native "<layer>.lora_A" / ".lora_B" / ".lora_output_offset"
    layers: list[str]
    heads: dict[str, Any]
    source_modules: list[str]
    dropped_adaln_layers: list[str] = field(default_factory=list)
    # stacks: per-layer (rank, alpha, strength) of the concatenated factors; None = the spec's own values
    scaling: dict[str, tuple[int, float, float]] | None = None

    def layer_scaling(self, name: str, spec: LoraSpec) -> tuple[int, float, float]:
        """(rank, alpha, strength) the wrapper of layer ``name`` uses."""
        if self.scaling is None:
            return spec.rank, spec.alpha, spec.scale
        return self.scaling[name]


def _reject(reason: str, message: str, **kwargs: Any) -> UnsupportedCombination:
    return UnsupportedCombination(reason, message, field_path="lora", **kwargs)


def _sample(names: list[str], limit: int = 8) -> str:
    return ", ".join(names[:limit]) + (" …" if len(names) > limit else "")


def prepare_adapter(
    module: Any, spec: LoraSpec, raw: Mapping[str, Any], metadata: Mapping[str, str]
) -> PreparedAdapter:
    """Raw file tensors → native-name adapter for ``module``; fails on any unmapped key."""
    from sglang.multimodal_gen.runtime.loader.utils import get_param_names_mapping  # type: ignore[import-untyped]
    from sglang.multimodal_gen.runtime.pipelines_core.lora.format_adapter import (  # type: ignore[import-untyped]
        normalize_lora_state_dict,
    )
    from sglang.multimodal_gen.runtime.pipelines_core.lora.pipeline import (  # type: ignore[import-untyped]
        _store_fused_lora_groups,
        _swap_peft_swiglu_fc1_lora_b,
    )

    # layer shapes are checked against the loaded DiT itself (_check_shapes), not H3 constants
    facts = _check_adapter_header(raw, metadata, spec)

    heads = {k: raw[k] for k in PDD_HEAD_KEYS if k in raw}
    if spec.is_pdd != bool(heads):
        raise IntegrityMismatch(
            "LORA_PDD_HEADS",
            f"PDD 輸出頭 {sorted(heads)} 與 registry 格式 {spec.format} 不符",
        )
    backbone = {k: v for k, v in raw.items() if k not in heads}
    # a global alpha is the only scaling this runtime honours: PEFT alpha_pattern / rslora
    # (per-layer scaling) would silently change the update, so they are not passed as config
    normalized = normalize_lora_state_dict(backbone, adapter_config={})

    adapter = _normalize_lora_targets(
        module,
        get_param_names_mapping,
        normalized,
        _swap_peft_swiglu_fc1_lora_b,
        _store_fused_lora_groups,
    )

    adapter, dropped = _project_adaln(spec, module, adapter)

    layers = _check_lora_layers(adapter, facts, spec)
    return PreparedAdapter(
        tensors=adapter,
        layers=layers,
        heads=heads,
        source_modules=list(facts["modules"]),
        dropped_adaln_layers=sorted(dropped),
    )


def _st_dtype(tensor: Any) -> str:
    import torch

    return {
        torch.bfloat16: "BF16",
        torch.float16: "F16",
        torch.float32: "F32",
        torch.float64: "F64",
        torch.int64: "I64",
        torch.int32: "I32",
        torch.uint8: "U8",
        torch.int8: "I8",
        torch.bool: "BOOL",
    }.get(tensor.dtype, str(tensor.dtype))


# ---------------------------------------------------------------------------
# attach


def _wrapper_class(layer: Any) -> Any:
    """``wrap_with_lora_layer``'s type dispatch (``linear.py:952-963``, same order), mapped onto the shim's in-place subclasses (``lora_inplace``: the dynamic term is accumulated into the base output chunk by chunk instead of a second full-size output).

    H3 LoRA targets are Merged/Column/Row parallel linears only.  ``QKVParallelLinear`` (its B is a
    ``[B_q, B_kv]`` pair) and ``WeightOnlyFP8Linear`` / ``ReplicatedLinear`` / plain ``nn.Linear``
    (out-of-place ``@torch.compile`` wrappers) have no in-place variant → refused (None).
    """
    from sglang.multimodal_gen.runtime.layers.linear import (  # type: ignore[import-untyped]
        ColumnParallelLinear,
        MergedColumnParallelLinear,
        QKVParallelLinear,
        RowParallelLinear,
    )
    from sglang.multimodal_gen.runtime.layers.quantization.weight_only_fp8 import (  # type: ignore[import-untyped]
        WeightOnlyFP8Linear,
    )

    if isinstance(layer, (WeightOnlyFP8Linear, QKVParallelLinear)):
        return None
    classes = inplace_wrapper_classes()
    for base_cls, upstream_name in (
        (MergedColumnParallelLinear, "MergedColumnParallelLinearWithLoRA"),
        (ColumnParallelLinear, "ColumnParallelLinearWithLoRA"),
        (RowParallelLinear, "RowParallelLinearWithLoRA"),
    ):
        if isinstance(layer, base_cls):
            return classes[upstream_name]
    return None


def _check_shapes(name: str, layer: Any, a: Any, b: Any) -> None:
    in_features = int(getattr(layer, "input_size", a.shape[-1]))
    out_features = int(getattr(layer, "output_size", -1))
    rows = (
        int(b.shape[0] * b.shape[1])
        if b.dim() == _GROUPED_WEIGHT_RANK
        else int(b.shape[0])
    )
    if int(a.shape[-1]) != in_features or (out_features > 0 and rows != out_features):
        raise _reject(
            "LORA_SHAPE_MISMATCH",
            f"{name}: LoRA A{list(a.shape)}／B{list(b.shape)} 與層 in={in_features} out={out_features} 不符",
        )


def attach_dynamic(
    module: Any,
    prepared: PreparedAdapter,
    spec: LoraSpec,
    **arguments: Unpack[_DynamicAdapter],
) -> dict[str, Any]:
    """Wrap exactly ``prepared.layers`` and install the factors (dynamic unless ``merge``).

    Dynamic wrappers accumulate the term into the base output in place, ``chunk_tokens`` rows
    at a time (``lora_inplace``; 0 = the whole sequence in one ``addmm_``).
    """
    validate_keywords(arguments, _DynamicAdapter)
    device = arguments["device"]
    lora_path = arguments["lora_path"]
    merge = arguments.get("merge", False)
    chunk_tokens = arguments.get("chunk_tokens", DEFAULT_DYNAMIC_CHUNK_TOKENS)
    from sglang.multimodal_gen.runtime.layers.lora.linear import replace_submodule  # type: ignore[import-untyped]
    from sglang.multimodal_gen.runtime.managers.memory_managers.layerwise_offload import (  # type: ignore[import-untyped]
        is_layerwise_offloaded_module,
        iter_materialized_weights,
        refresh_layerwise_targets,
    )

    wrappers, kinds = _dynamic_wrappers(
        prepared, module, spec, chunk_tokens, replace_submodule
    )

    layerwise = is_layerwise_offloaded_module(module)
    bound = 0
    if layerwise:
        # repoint the managers at ``*.base_layer.weight`` and bind the CPU views, exactly like
        # convert_module_lora_layers after its wrap (pipeline.py:442-461)
        refresh_layerwise_targets(module)
        materialized = dict(iter_materialized_weights(module))
        for name, wrapper in wrappers.items():
            weight = materialized.get(f"{name}.weight")
            if weight is None:
                continue
            data = weight.detach()
            wrapper.cpu_weight = data
            wrapper._base_is_view = True
            base = wrapper.base_layer
            base._offload_root = module
            base._offload_param_prefix = name
            base._packed_weight_cpu = data
            bound += 1

    factor_bytes = _install_dynamic_factors(
        _InstallDynamicFactorsInputs(wrappers, prepared, device, spec, lora_path, merge)
    )
    return {
        "wrapped_layers": len(wrappers),
        "wrapper_classes": dict(sorted(kinds.items())),
        "layerwise": layerwise,
        "layerwise_views_bound": bound,
        "factor_device_bytes": factor_bytes,
        "factor_dtype": str(next(iter(prepared.tensors.values())).dtype)
        if prepared.tensors
        else None,
        # merged layers run the upstream forward (comparison arm); dynamic ones the in-place term
        "accumulate": "merged" if merge else "inplace_addmm",
        "dynamic_chunk_tokens": None if merge else int(chunk_tokens),
    }


def ensure_no_pdd_heads(module: Any) -> None:
    """Reject prediction heads incompatible with this adapter path."""
    final_layer = getattr(module, "final_layer", None)
    if final_layer is not None and getattr(final_layer, "_pdd_heads", None) is not None:
        raise _reject(
            "PDD_HEADS_UNEXPECTED",
            "DiT 帶有 PDD 融合輸出頭，但 plan 沒有 PDD LoRA（SGLANG_DIFFUSION_MINIMAX_H3_PDD_HEADS 不得由環境注入）",
        )


def apply_lora_policy(
    module: Any, policy: LoraPolicy | None, *, device: Any, workdir: Path
) -> dict[str, Any]:
    """Attach the plan LoRA(s) to a freshly loaded DiT; returns the residency facts."""
    if policy is None:
        ensure_no_pdd_heads(module)
        return {"mode": "none"}
    if policy.merge_mode not in ("dynamic", "merge"):
        raise _reject("LORA_MERGE_MODE_INVALID", f"merge_mode={policy.merge_mode}")
    if len(policy.specs) > 1:
        return _apply_stack(module, policy, device=device, workdir=workdir)
    facts: dict[str, Any] = {**policy.as_dict(), "loaded": []}
    for spec in policy.specs:
        path = lora_file(spec)
        digest = verify_lora_file(path, spec)
        raw, metadata = read_lora_file(path)
        prepared = prepare_adapter(module, spec, raw, metadata)
        del raw
        attached = attach_dynamic(
            module,
            prepared,
            spec,
            device=device,
            lora_path=str(path),
            merge=policy.merge_mode == "merge",
            chunk_tokens=policy.chunk_tokens,
        )
        item: dict[str, Any] = {
            "lora_id": spec.lora_id,
            "sha256": digest,
            "lora_merge_mode": policy.merge_mode,
            "adaln_handling": spec.adaln_handling,
            "adaln_layers_from_sidecar": len(prepared.dropped_adaln_layers),
            **attached,
        }
        if spec.is_pdd:
            item["pdd"] = install_pdd_heads(
                module, prepared.heads, spec, workdir=workdir
            )
        else:
            ensure_no_pdd_heads(module)
        if spec.hop_files:
            if policy.merge_mode != "dynamic":
                raise _reject(
                    "LORA_PTD_MERGE_UNSUPPORTED",
                    "PTD 每步換 adapter，只能 dynamic（不能合併進權重）",
                )
            item["ptd"] = _attach_ptd_hops(module, spec, prepared)
        facts["loaded"].append(item)
    return facts


def _apply_stack(
    module: Any, policy: LoraPolicy, *, device: Any, workdir: Path
) -> dict[str, Any]:
    """Prepare every member strictly, concatenate their factors per layer, attach one adapter per layer."""
    if any(spec.hop_files for spec in policy.specs):
        raise _reject(
            "LORA_STACK_PTD", "PTD LoRA（每步換 adapter）不能與其他 LoRA 串接"
        )
    pdd_specs = [spec for spec in policy.specs if spec.is_pdd]
    if len(pdd_specs) > 1:
        raise _reject(
            "LORA_STACK_ACCELERATORS", "串接清單最多一個 PDD LoRA（各自帶融合輸出頭）"
        )
    items: list[dict[str, Any]] = []
    prepared_members: list[tuple[LoraSpec, PreparedAdapter]] = []
    for spec in policy.specs:
        path = lora_file(spec)
        digest = verify_lora_file(path, spec)
        raw, metadata = read_lora_file(path)
        prepared_members.append((spec, prepare_adapter(module, spec, raw, metadata)))
        del raw
        items.append(
            {
                "lora_id": spec.lora_id,
                "sha256": digest,
                "lora_merge_mode": policy.merge_mode,
                "adaln_handling": spec.adaln_handling,
                "stack_role": spec.stack_role,
                "path": str(path),
            }
        )
    combined, multi, folded = _stack_prepared(prepared_members)
    representative = pdd_specs[0] if pdd_specs else policy.specs[0]
    attached = attach_dynamic(
        module,
        combined,
        representative,
        device=device,
        lora_path="+".join(item.pop("path") for item in items),
        merge=policy.merge_mode == "merge",
        chunk_tokens=policy.chunk_tokens,
    )
    for (spec, prepared), item in zip(prepared_members, items, strict=True):
        item["layers"] = len(prepared.layers)
        item["adaln_layers_from_sidecar"] = len(prepared.dropped_adaln_layers)
        if spec.is_pdd:
            item["pdd"] = install_pdd_heads(
                module, prepared.heads, spec, workdir=workdir
            )
    if not pdd_specs:
        ensure_no_pdd_heads(module)
    return {
        **policy.as_dict(),
        "loaded": items,
        "stack": {
            "algorithm": STACK_ALGORITHM,
            "members": [spec.lora_id for spec in policy.specs],
            "layers": len(combined.layers),
            "multi_member_layers": multi,
            "scale_folded_layers": folded,
            **attached,
        },
    }


def _stack_prepared(
    members: list[tuple[LoraSpec, PreparedAdapter]],
) -> tuple[PreparedAdapter, int, int]:
    """One PreparedAdapter whose per-layer factors are the members' factors stacked in order."""
    layers = sorted({name for _spec, prepared in members for name in prepared.layers})
    tensors: dict[str, Any] = {}
    scaling: dict[str, tuple[int, float, float]] = {}
    multi = folded = 0
    for name in layers:
        parts = [
            Contribution(
                lora_id=spec.lora_id,
                # popped: host memory holds each layer's factors once (member copy or stacked copy)
                a=prepared.tensors.pop(f"{name}.lora_A"),
                b=prepared.tensors.pop(f"{name}.lora_B"),
                rank=spec.rank,
                alpha=spec.alpha,
                scale=spec.scale,
                offset=prepared.tensors.pop(f"{name}.lora_output_offset", None),
            )
            for spec, prepared in members
            if name in prepared.layers
        ]
        stacked = stack_factors(parts, layer=name)
        tensors[f"{name}.lora_A"] = stacked.a
        tensors[f"{name}.lora_B"] = stacked.b
        if stacked.offset is not None:
            tensors[f"{name}.lora_output_offset"] = stacked.offset
        scaling[name] = (stacked.rank, stacked.alpha, stacked.strength)
        multi += len(parts) > 1
        folded += stacked.folded
    pdd_heads = next((prepared.heads for spec, prepared in members if spec.is_pdd), {})
    combined = PreparedAdapter(
        tensors=tensors,
        layers=layers,
        heads=pdd_heads,
        source_modules=sorted(
            {m for _spec, prepared in members for m in prepared.source_modules}
        ),
        dropped_adaln_layers=sorted(
            {d for _spec, prepared in members for d in prepared.dropped_adaln_layers}
        ),
        scaling=scaling,
    )
    return combined, multi, folded


class PtdHops:
    """Per-step adapters of a PTD LoRA on a resident DiT: hop k's factors are copied into the in-place wrappers' (device) ``lora_A``/``lora_B`` before denoise step k.

    Every hop is held in ordinary (pageable) host memory: pinning thousands of small factor tensors next to a block-streamed DiT's pinned weights is far slower than a pageable switch, which copies one hop's factors once per step.
    """

    def __init__(
        self, wrappers: Mapping[str, Any], hops: list[dict[str, tuple[Any, Any]]]
    ) -> None:
        """Prepare the LoRA settings for each sampling hop."""
        self.wrappers = dict(wrappers)
        self.hops = hops
        self.current = 0
        self.switches = 0

    @property
    def count(self) -> int:
        """Return the number of prepared sampling hops."""
        return len(self.hops)

    def set_hop(self, hop: int) -> None:
        """Select the adapter state for the current sampling hop."""
        if not 0 <= hop < len(self.hops):
            raise _reject(
                "LORA_PTD_HOP_RANGE", f"PTD hop {hop} 超出 0..{len(self.hops) - 1}"
            )
        if hop == self.current:
            return
        factors = self.hops[hop]
        for name, wrapper in self.wrappers.items():
            a, b = factors[name]
            wrapper.lora_A.data.copy_(a)
            wrapper.lora_B.data.copy_(b)
        self.current = hop
        self.switches += 1


def _host_factor(tensor: Any, like: Any) -> Any:
    """``tensor`` on the CPU in the wrapper's dtype, contiguous (no copy when it already is)."""
    return tensor.detach().to(device="cpu", dtype=like.dtype).contiguous()


def _attach_ptd_hops(
    module: Any, spec: LoraSpec, prepared: PreparedAdapter
) -> dict[str, Any]:
    """Prepare hops 1..N-1 with the hop-0 mapping and keep every hop's factors in host memory."""
    wrappers = {name: module.get_submodule(name) for name in prepared.layers}

    def factors_of(adapter: PreparedAdapter, hop: int) -> dict[str, tuple[Any, Any]]:
        out = {}
        for name in adapter.layers:
            a, b = adapter.tensors[f"{name}.lora_A"], adapter.tensors[f"{name}.lora_B"]
            wa, wb = wrappers[name].lora_A, wrappers[name].lora_B
            if tuple(a.shape) != tuple(wa.shape) or tuple(b.shape) != tuple(wb.shape):
                raise _reject(
                    "LORA_PTD_SHAPE_MISMATCH",
                    f"PTD hop {hop} 的 {name} 形狀與 hop 0 不同",
                )
            out[name] = (_host_factor(a, wa), _host_factor(b, wb))
        return out

    hops = [factors_of(prepared, 0)]
    digests = []
    for hop in range(1, spec.ptd_hops):
        hop_spec = spec.hop_spec(hop)
        path = lora_file(hop_spec)
        digests.append(verify_lora_file(path, hop_spec))
        raw, metadata = read_lora_file(path)
        other = prepare_adapter(module, hop_spec, raw, metadata)
        del raw
        if other.layers != prepared.layers:
            raise _reject("LORA_PTD_LAYER_MISMATCH", f"PTD hop {hop} 的層與 hop 0 不同")
        if any(f"{n}.lora_output_offset" in other.tensors for n in other.layers):
            raise _reject(
                "LORA_PTD_OFFSET_UNSUPPORTED",
                "PTD hop 檔帶 lora_output_offset（未接入）",
            )
        hops.append(factors_of(other, hop))
        del other
    host_bytes = sum(
        t.numel() * t.element_size() for h in hops for pair in h.values() for t in pair
    )
    module._phasyn_ptd_hops = PtdHops(wrappers, hops)
    return {
        "hops": len(hops),
        "hop_sha256": digests,
        "host_bytes": host_bytes,
        "pinned": False,
    }


def ptd_hops(module: Any) -> PtdHops | None:
    """The resident DiT's PTD per-step adapters, None for a one-adapter LoRA."""
    return getattr(module, "_phasyn_ptd_hops", None)


__all__ = [
    "PreparedAdapter",
    "PtdHops",
    "apply_lora_policy",
    "attach_dynamic",
    "ensure_no_pdd_heads",
    "lora_file",
    "prepare_adapter",
    "ptd_hops",
    "read_lora_file",
    "verify_lora_file",
]


def _check_adapter_header(
    raw: Mapping[str, Any], metadata: Mapping[str, str], spec: LoraSpec
) -> dict[str, Any]:
    facts = analyze_lora_header(
        {k: (_st_dtype(v), tuple(v.shape)) for k, v in raw.items()},
        metadata,
        check_dims=False,
    )
    if facts["problems"] or facts["unmatched_count"]:
        raise _reject(
            "LORA_KEY_UNMATCHED",
            f"LoRA {spec.lora_id} 的 key 無法全部對應 H3 DiT：{_sample(list(facts['problems']) + list(facts['unmatched_keys']))}",
        )
    if facts["format"] != spec.format or facts["rank"] != spec.rank:
        raise IntegrityMismatch(
            "LORA_FACTS_DRIFT",
            f"檔案 header 是 {facts['format']}／rank {facts['rank']}，registry 是 {spec.format}／rank {spec.rank}",
        )
    alpha_meta = facts["alpha_metadata"]
    if alpha_meta is not None and float(alpha_meta) != spec.alpha:
        raise IntegrityMismatch(
            "LORA_ALPHA_FILE_CONFLICT",
            f"檔案 metadata alpha={alpha_meta} ≠ registry alpha={spec.alpha}",
        )
    return facts


def _normalize_lora_targets(
    module: Any,
    get_param_names_mapping: Any,
    normalized: Any,
    _swap_peft_swiglu_fc1_lora_b: Any,
    _store_fused_lora_groups: Any,
) -> dict[str, Any]:
    arch = getattr(module, "arch", None)
    lora_mapping = get_param_names_mapping(
        getattr(arch, "lora_param_names_mapping", None)
        or module.lora_param_names_mapping
    )
    param_mapping = get_param_names_mapping(
        getattr(arch, "param_names_mapping", None) or module.param_names_mapping
    )
    adapter: dict[str, Any] = {}
    pending: defaultdict[Any, dict[Any, Any]] = defaultdict(dict)
    unmapped: list[str] = []
    for source, tensor in normalized.items():
        name = source.replace("diffusion_model.", "").replace(".weight", "")
        name, _, _ = lora_mapping(name)
        target, merge_index, total = param_mapping(name)
        if not target.endswith(_LORA_SUFFIXES):
            unmapped.append(f"{source}→{target}")
            continue
        if merge_index is not None:
            pending[target][merge_index] = tensor  # q/k/v sections, stacked below
            if total != _QKV_PARTS:
                unmapped.append(f"{source}→{target}（{total} 段融合）")
            continue
        if target in adapter:
            unmapped.append(f"{source}→{target}（重複）")
            continue
        adapter[target] = _swap_peft_swiglu_fc1_lora_b(name, target, tensor)
    if unmapped:
        raise _reject(
            "LORA_KEY_UNMATCHED",
            f"{len(unmapped)} 個 LoRA key 對不到 DiT 層：{_sample(unmapped)}",
        )
    _store_fused_lora_groups(adapter, pending, None, "cpu")
    incomplete = sorted(k for k in pending if k not in adapter)
    if incomplete:
        raise _reject("LORA_KEY_UNMATCHED", f"q/k/v 三段不完整：{_sample(incomplete)}")
    alpha_keys = sorted(k for k in adapter if k.endswith(".alpha"))
    if alpha_keys:
        raise _reject(
            "LORA_PER_LAYER_ALPHA",
            f"逐層 alpha 不在 registry 合約內：{_sample(alpha_keys)}",
        )
    return adapter


def _project_adaln(
    spec: LoraSpec, module: Any, adapter: dict[str, Any]
) -> tuple[dict[str, Any], set[str]]:
    dropped: set[str] = set()
    if (
        spec.adaln_handling == "sidecar"
    ):  # their effect lives in the LoRA-signed AdaLN sidecar
        for key in [k for k in adapter if ".adaln_proj." in k]:
            adapter.pop(key)
            dropped.add(key.rsplit(".", 1)[0])
    if getattr(module, "_adaln_precomputed", False) and any(
        ".adaln_proj." in k for k in adapter
    ):
        raise _reject(
            "LORA_ADALN_CACHE_CONFLICT",
            "DiT 以 AdaLN cache 建置（沒有 adaln_proj），但 LoRA 仍有 adaln 因子；需 fixed sidecar 帶 LoRA 簽章",
        )
    try:
        adapter = module.prepare_lora_adapter(adapter)
    except ValueError as exc:
        raise _reject(
            "LORA_PREPARE_REJECTED", f"SGLang prepare_lora_adapter 拒絕：{exc}"
        ) from exc
    return adapter, dropped


def _check_lora_layers(adapter: dict[str, Any], facts: Any, spec: LoraSpec) -> Any:
    layers = sorted(
        {k.rsplit(".", 1)[0] for k in adapter if k.endswith(_LORA_SUFFIXES)}
    )
    expected = expected_native_layers(
        facts["modules"], include_adaln=spec.adaln_handling == "dynamic"
    )
    if layers != expected:
        extra = sorted(set(layers) - set(expected))
        missing = sorted(set(expected) - set(layers))
        raise _reject(
            "LORA_LAYER_MAPPING_MISMATCH",
            f"SGLang 對應出的層與 registry 事實不同：多出 {_sample(extra)}；缺少 {_sample(missing)}",
        )
    for layer in layers:
        a, b = adapter.get(f"{layer}.lora_A"), adapter.get(f"{layer}.lora_B")
        if a is None or b is None:
            raise _reject("LORA_KEY_UNMATCHED", f"{layer} 缺少 lora_A 或 lora_B")
        if int(a.shape[-2]) != spec.rank:
            raise IntegrityMismatch(
                "LORA_FACTS_DRIFT",
                f"{layer} rank {int(a.shape[-2])} ≠ registry {spec.rank}",
            )
    return layers


def _dynamic_wrappers(
    prepared: PreparedAdapter,
    module: Any,
    spec: LoraSpec,
    chunk_tokens: Any,
    replace_submodule: Any,
) -> tuple[dict[str, Any], dict[str, int]]:
    wrappers: dict[str, Any] = {}
    kinds: dict[str, int] = defaultdict(int)
    for name in prepared.layers:
        try:
            layer = module.get_submodule(name)
        except AttributeError as exc:
            raise _reject("LORA_TARGET_MISSING", f"DiT 沒有層 {name}") from exc
        wrapper_cls = _wrapper_class(layer)
        if wrapper_cls is None:
            raise _reject(
                "LORA_TARGET_TYPE_UNSUPPORTED",
                f"{name} 是 {type(layer).__name__}，沒有對應的 LoRA 包裝類",
            )
        _check_shapes(
            name,
            layer,
            prepared.tensors[f"{name}.lora_A"],
            prepared.tensors[f"{name}.lora_B"],
        )
        # snapshot_base=False: the unmerge snapshot is a zero-copy view (linear.py:97-102)
        rank, alpha, _strength = prepared.layer_scaling(name, spec)
        wrapper = wrapper_cls(
            layer, lora_rank=rank, lora_alpha=alpha, snapshot_base=False
        )
        wrapper.chunk_tokens = int(chunk_tokens)
        replace_submodule(module, name, wrapper)
        wrappers[name] = wrapper
        kinds[wrapper_cls.__name__] += 1
    return wrappers, kinds


class _InstallDynamicFactorsInputs(NamedTuple):
    wrappers: dict[str, Any]
    prepared: PreparedAdapter
    device: Any
    spec: LoraSpec
    lora_path: Any
    merge: Any


def _install_dynamic_factors(inputs: _InstallDynamicFactorsInputs) -> Any:
    wrappers, prepared, device, spec, lora_path, merge = inputs
    factor_bytes = 0
    for name, wrapper in wrappers.items():
        a = prepared.tensors[f"{name}.lora_A"].to(device=device)
        b = prepared.tensors[f"{name}.lora_B"].to(device=device)
        offset = prepared.tensors.get(f"{name}.lora_output_offset")
        factor_bytes += a.numel() * a.element_size() + b.numel() * b.element_size()
        # the registry alpha, never SGLang's alpha=rank fallback (pipeline.py:797-815); a stack's
        # concatenated layers carry alpha = rank and the (shared or folded) scale as strength
        rank, alpha, strength = prepared.layer_scaling(name, spec)
        wrapper.lora_rank = rank
        wrapper.lora_alpha = alpha
        wrapper.set_lora_weights(
            a,
            b,
            lora_path=lora_path,
            strength=strength,
            clear_existing=True,
            merge_weights=False,
            output_offset=None if offset is None else offset.to(device=device),
        )
        for param in (wrapper.lora_A, wrapper.lora_B, wrapper.lora_output_offset):
            if (
                param is not None
            ):  # inference only: never build autograd state on the factors
                param.requires_grad_(requires_grad=False)
        if merge:
            if not wrapper.can_merge_base_weight:
                raise _reject(
                    "LORA_MERGE_QUANTIZED", f"{name} 的權重是量化格式，不能合併"
                )
            # the comparison arm is discarded with its component, never unmerged: skip the
            # owned CPU snapshot merge_lora_weights would otherwise copy (linear.py:347-352)
            wrapper._base_is_view = False
            wrapper.merge_lora_weights()
    return factor_bytes
