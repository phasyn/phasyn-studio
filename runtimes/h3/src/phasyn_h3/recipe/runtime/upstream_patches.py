# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/models/dits/minimax_h3.py (MiniMaxH3AdalnCache construction and two upstream error messages)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: runtime patches pinned to the upstream source hashes.
"""In-process patches of the pinned SGLang (never on disk).

Each patch is bound to the pinned source: the functions it wraps are hash-checked
first (``pins.py``), so a different SGLang build fails closed (``UPSTREAM_PATCH_SOURCE_MISMATCH``)
instead of running a patch written for other code.  No source is compiled or
evaluated; the patches only wrap upstream callables.

1. ``uuid_device_ids.v1`` — SGLang's NVML platform maps ``CUDA_VISIBLE_DEVICES``
   entries with ``int(...)`` (``runtime/platforms/cuda.py:53-67``).  The Node
   narrows the actor's visibility with the GPU UUID, so every NVML-backed
   capability query (the fp8_fa_sm120 / SubBlock resolvers,
   ``cuda.py:432-480, 520-547``) raised ``ValueError``.  ``GPU-…`` entries are
   resolved through the same vendored pynvml instead.
2. ``adaln_online_quant.v1`` — ``MiniMaxH3DiTModel.__init__`` rejects any
   ``quant_config`` together with an AdaLN cache or online rebuild
   (``minimax_h3.py:2154-2159``) because the rebuild reads the BF16
   ``adaln_proj`` tensors straight from the checkpoint
   (``minimax_h3_adaln_cache.py:746-790``).  For an *online* quantization of a
   native BF16 checkpoint those tensors are untouched, so the wrapper builds the
   model exactly as upstream does without the cache (the blocks' AdaLN
   projections exist only on the meta device during construction,
   ``fsdp_load.py:313-315``) and then applies the three structural differences of
   the cache branch (``minimax_h3.py:2166-2168, 2256-2281, 2284-2297``): drop every
   ``adaln_proj``, mark ``_adaln_precomputed`` and attach the
   ``MiniMaxH3AdalnCache``.  It admits only the configs the shim armed for the
   current load: online ``convrot_int8``/``fp8`` whose ignored layers cover
   ``adaln_proj``; everything else hits the unchanged upstream path and its
   rejection.
3. ``fp8_layerwise_quant.v1`` — online FP8 (``--quantization fp8``, a no-arg
   ``Fp8Config``) loads the checkpoint onto the device and moves the whole model
   there before quantizing (``_needs_device_weight_postprocess`` is True,
   ``transformer_load_utils.py:820-837``; no ``quantized_cpu_load_supported``,
   ``transformer_loader.py:54-65, 484-498``; ``fsdp_load.py:480-491``): a 16 GB
   GPU runs out of memory before layerwise offload exists.  While the shim armed
   it for the current load, the patch (a) keeps the checkpoint on the CPU and skips
   the whole-model move for an online FP8 config only, and (b) runs the unchanged
   upstream ``Fp8LinearMethod.process_weights_after_loading`` of each layer with
   that layer's parameters staged on the device (``staged_on``, the per-module
   staging the text-encoder loader does with srt ``stage_module_for_post_load``,
   ``text_encoder_loader.py:740-756``, minus its write-back into the source
   storage): one BF16 layer on the device at a time, the E4M3 weight (transposed
   view, strides kept by ``empty_strided``) and its per-channel scale back on the
   CPU — the convrot round trip (``convrot_int8_jit.py:228-248``) for FP8.
   (c) Layers it quantized on a compute capability in
   ``fp8_linear.VALIDATED_CAPABILITIES`` run ``fp8_linear.fp8_linear`` (cuBLASLt
   unit-scale GEMM + one Triton scale pass) instead of ``apply_fp8_linear``; every
   other ``Fp8LinearMethod`` keeps the upstream ``apply``.
"""

from __future__ import annotations

import contextlib
import contextvars
import importlib
import inspect
import os
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from . import pins
from ._observations import RuntimeObservation
from .acceleration import FP8_PATCH_ID
from .fp8_linear import fp8_linear, supports


UUID_PATCH_ID = "uuid_device_ids.v1"
ADALN_PATCH_ID = "adaln_online_quant.v1"
UPSTREAM_ADALN_MESSAGE = (
    "MiniMax H3 AdaLN cache is only compatible with unquantized weights"
)
UPSTREAM_PRUNED_MESSAGE = (
    "MiniMax H3 pruned curve checkpoints cannot use a separate AdaLN cache"
)
ADALN_PREFIXES = ("blocks.0.adaln_proj.linear", "final_layer.adaln_proj.linear")

_LOCK = threading.Lock()
_STATE: dict[str, dict[str, Any] | None] = {"uuid": None, "adaln": None, "fp8": None}
_ARMED: contextvars.ContextVar[frozenset[str] | None] = contextvars.ContextVar(
    "phasyn_adaln_online_quant", default=None
)
_ADMITTED: list[dict[str, Any]] = []


_WHAT = "shim 的 runtime patch "  # pins.check message: "<label> 的上游原始碼…不同；shim 的 runtime patch 不套用…"


# ---------------------------------------------------------------------------
# 1. GPU-UUID CUDA_VISIBLE_DEVICES for SGLang's NVML queries


def ensure_uuid_device_ids() -> dict[str, Any]:
    """Make SGLang's NVML device-id mapping accept ``GPU-<uuid>`` entries (idempotent)."""
    with _LOCK:
        current = _STATE["uuid"]
        if current is not None:
            return dict(current)
        (digest,) = pins.check("uuid_device_ids", what=_WHAT).values()
        cuda_mod = importlib.import_module(
            "sglang.multimodal_gen.runtime.platforms.cuda"
        )
        original = cuda_mod.device_id_to_physical_device_id

        def device_id_to_physical_device_id(device_id: int) -> int:
            raw = os.environ.get("CUDA_VISIBLE_DEVICES")
            if raw is not None:
                entries = raw.split(",")
                if 0 <= device_id < len(entries):
                    entry = entries[device_id].strip()
                    if entry.startswith("GPU-"):
                        # same vendored pynvml as the caller's with_nvml_context
                        nvml = cuda_mod.pynvml
                        return int(
                            nvml.nvmlDeviceGetIndex(
                                nvml.nvmlDeviceGetHandleByUUID(entry)
                            )
                        )
            return int(original(device_id))

        device_id_to_physical_device_id.__wrapped__ = original  # type: ignore[attr-defined]
        device_id_to_physical_device_id._phasyn_patch = UUID_PATCH_ID  # type: ignore[attr-defined]
        cuda_mod.device_id_to_physical_device_id = device_id_to_physical_device_id  # type: ignore[attr-defined]
        state = {"patch": UUID_PATCH_ID, "source_sha256": digest}
        _STATE["uuid"] = state
        return dict(state)


# ---------------------------------------------------------------------------
# 2. AdaLN cache/online x online quantization


def _is_serialized(quant_config: Any) -> bool:
    return bool(
        getattr(quant_config, "is_checkpoint_int8_serialized", False)
        or getattr(quant_config, "is_checkpoint_fp8_serialized", False)
        or getattr(quant_config, "layer_markers", None) is not None
    )


def _admit(quant_config: Any) -> bool:
    """True when the armed shim load may combine this config with the AdaLN cache."""
    armed = _ARMED.get()
    if not armed:
        return False
    name = str(quant_config.get_name())
    reason = None
    if name not in armed:
        reason = f"quantization {name!r} 不在 shim 允許的線上量化 {sorted(armed)} 內"
    elif _is_serialized(quant_config):
        reason = "預量化（serialized）checkpoint 的 adaln_proj 不保證是 BF16"
    else:
        from sglang.srt.layers.quantization.utils import is_layer_skipped  # type: ignore[import-untyped]

        ignored = list(getattr(quant_config, "ignored_layers", None) or [])
        mapping = getattr(quant_config, "packed_modules_mapping", None) or {}
        uncovered = [
            p
            for p in ADALN_PREFIXES
            if not is_layer_skipped(p, ignored, fused_mapping=mapping)
        ]
        if uncovered:
            reason = f"ignored layers {ignored} 沒有涵蓋 {uncovered}（adaln_proj 必須保持 BF16）"
    if reason is not None:
        raise ValueError(f"{UPSTREAM_ADALN_MESSAGE} ({ADALN_PATCH_ID}: {reason})")
    _ADMITTED.append(
        {
            "quantization": name,
            "ignored_layers": list(getattr(quant_config, "ignored_layers", []) or []),
        }
    )
    return True


def install_adaln_online_quant_patch() -> dict[str, Any]:
    """Wrap ``MiniMaxH3DiTModel.__init__`` (idempotent; inactive until armed)."""
    with _LOCK:
        current = _STATE["adaln"]
        if current is not None:
            return dict(current)
        (digest,) = pins.check("adaln_online_quant", what=_WHAT).values()
        module = importlib.import_module(
            "sglang.multimodal_gen.runtime.models.dits.minimax_h3"
        )
        cls = module.MiniMaxH3DiTModel
        original = cls.__init__
        arguments = inspect.signature(original)

        def patched_init(
            self: Any, config: Any, hf_config: dict[str, Any], *args: Any, **kwargs: Any
        ) -> None:
            bound = arguments.bind(self, config, hf_config, *args, **kwargs)
            bound.apply_defaults()
            options = bound.arguments
            quant_config = options["quant_config"]
            adaln_cache_path = options["adaln_cache_path"]
            adaln_cache_model_variant = options["adaln_cache_model_variant"]
            adaln_weight_files = options["adaln_weight_files"]
            adaln_plan_width = options["adaln_plan_width"]
            adaln_max_plans = options["adaln_max_plans"]
            adaln_host_cache_bytes = options["adaln_host_cache_bytes"]
            adaln_precision = options["adaln_precision"]
            precomputed = adaln_cache_path is not None or adaln_weight_files is not None
            if not (precomputed and quant_config is not None and _admit(quant_config)):
                original(
                    self,
                    config,
                    hf_config,
                    quant_config=quant_config,
                    adaln_cache_path=adaln_cache_path,
                    adaln_cache_model_variant=adaln_cache_model_variant,
                    adaln_weight_files=adaln_weight_files,
                    adaln_plan_width=adaln_plan_width,
                    adaln_max_plans=adaln_max_plans,
                    adaln_host_cache_bytes=adaln_host_cache_bytes,
                    adaln_precision=adaln_precision,
                )
                return
            # upstream construction without the cache (adaln_proj on meta only) ...
            original(self, config, hf_config, quant_config=quant_config)
            if self.arch.adaln_curve_grid is not None:
                raise ValueError(UPSTREAM_PRUNED_MESSAGE)
            # ... then exactly the cache branch's structural differences
            for block in self.blocks:
                block.adaln_proj = None
            self.final_layer.adaln_proj = None
            self._adaln_precomputed = True
            self.adaln_cache = module.MiniMaxH3AdalnCache(
                self.arch,
                path=adaln_cache_path,
                model_variant=adaln_cache_model_variant,
                weight_files=adaln_weight_files,
                max_plans=adaln_max_plans,
                max_plan_width=adaln_plan_width,
                host_cache_bytes=adaln_host_cache_bytes,
                precision=adaln_precision,
            )

        patched_init.__name__ = original.__name__
        patched_init.__qualname__ = original.__qualname__
        patched_init.__module__ = original.__module__
        patched_init.__doc__ = original.__doc__
        patched_init.__wrapped__ = original  # type: ignore[attr-defined]
        patched_init._phasyn_patch = ADALN_PATCH_ID  # type: ignore[attr-defined]
        cls.__init__ = patched_init
        state = {"patch": ADALN_PATCH_ID, "source_sha256": digest}
        _STATE["adaln"] = state
        return dict(state)


@contextlib.contextmanager
def armed_adaln_online_quant(
    methods: frozenset[str] | set[str],
) -> Iterator[list[dict[str, Any]]]:
    """Admit ``methods`` (SGLang quantization names) for the AdaLN cache in this context."""
    install_adaln_online_quant_patch()
    token = _ARMED.set(frozenset(methods))
    start = len(_ADMITTED)
    admitted: list[dict[str, Any]] = []
    try:
        yield admitted
    finally:
        _ARMED.reset(token)
        admitted.extend(_ADMITTED[start:])


# ---------------------------------------------------------------------------
# 3. online FP8, one layer at a time (no whole-model device postprocess)


@dataclass
class Fp8Arming:
    """The FP8 load the shim armed (``armed_fp8_layerwise_quant``) and what it did."""

    device: Any  # torch.device each layer is staged to for quantization
    gemm: (
        str | None
    )  # fp8_linear.KERNEL_ID for the quantized layers, or None: upstream apply_fp8_linear
    layers: int = 0
    staged_layers: int = (
        0  # round-tripped CPU -> device -> CPU (the rest were on the device already)
    )
    seconds: float = 0.0
    bf16_bytes: int = 0
    fp8_bytes: int = 0
    gemm_layers: dict[str, int] = field(default_factory=dict)

    def facts(self) -> dict[str, Any]:
        """Return the observed runtime facts for reporting."""
        return {
            "patch": FP8_PATCH_ID,
            "weight_postprocess": "per_layer",
            "quantized_layers": self.layers,
            "staged_layers": self.staged_layers,
            "seconds": round(self.seconds, 3),
            "bf16_bytes": self.bf16_bytes,
            "fp8_bytes": self.fp8_bytes,
            "gemm_layers": dict(sorted(self.gemm_layers.items())),
        }


_FP8_ARMED: contextvars.ContextVar[Fp8Arming | None] = contextvars.ContextVar(
    "phasyn_fp8_layerwise", default=None
)
UPSTREAM_FP8_GEMM = "upstream_apply_fp8_linear"


def is_online_fp8(quant_config: Any) -> bool:
    """A no-arg ``Fp8Config()`` (``--quantization fp8``): per-channel online, not serialized/block/MX."""
    if quant_config is None:
        return False
    with RuntimeObservation() as method_query:
        name = str(quant_config.get_name())
    if method_query.error is not None:
        return False
    return (
        name == "fp8"
        and not bool(getattr(quant_config, "is_checkpoint_fp8_serialized", False))
        and getattr(quant_config, "weight_block_size", None) is None
        and not bool(getattr(quant_config, "use_mxfp8", False))
    )


def _host_copy(tensor: Any, device: Any) -> Any:
    """A fresh copy of ``tensor`` on ``device`` with the same shape and strides (dense views only)."""
    import torch

    copy = torch.empty_strided(
        tuple(tensor.shape), tuple(tensor.stride()), dtype=tensor.dtype, device=device
    )
    copy.copy_(tensor)
    return copy


@contextlib.contextmanager
def staged_on(layer: Any, device: Any) -> Iterator[None]:
    """Run ``layer``'s post-load processing with its parameters on ``device``, one layer at a time.

    Afterwards every parameter the layer then holds (the replaced E4M3 ``weight`` view, the new
    ``weight_scale``, an untouched ``bias``) is rebound to a fresh copy on the layer's original device
    with its strides kept, the way srt's ``stage_module_for_post_load`` restores new tensors
    (``post_load.py:59-78``).  Unlike that helper nothing is ever written back into the source
    storage: on a shared CPU/GPU pool the checkpoint views are read-only mappings
    (``loader/readonly_safetensors.py``), and a write into one faults.
    """
    homes = {param.device for param in layer.parameters(recurse=False)}
    if len(homes) != 1 or any(True for _ in layer.buffers(recurse=False)):
        raise ValueError(
            f"{FP8_PATCH_ID}: cannot stage a layer with parameters on {homes} or buffers"
        )
    (home,) = homes
    original_parameters = dict(layer._parameters)
    original_data = [(param, param.data) for param in layer.parameters(recurse=False)]
    try:
        for param, _data in original_data:
            param.data = param.data.to(device)
        yield
        for param in layer.parameters(recurse=False):
            if param.device != home:
                param.data = _host_copy(param.data, home)
    except BaseException:
        # Moving parameter N or copying a quantized result home can fail too.
        # Restore original parameters/storage, including those replaced by quantization.
        layer._parameters.clear()
        layer._parameters.update(original_parameters)
        for param, data in original_data:
            param.data = data
        raise


def install_fp8_layerwise_patch() -> dict[str, Any]:
    """Wrap the online-FP8 load/apply path (idempotent; inactive until armed)."""
    with _LOCK:
        current = _STATE["fp8"]
        if current is not None:
            return dict(current)
        digests = pins.check("fp8_layerwise_quant", what=_WHAT)
        fp8_mod = importlib.import_module(
            "sglang.multimodal_gen.runtime.layers.quantization.fp8"
        )
        tlu = importlib.import_module(
            "sglang.multimodal_gen.runtime.loader.transformer_load_utils"
        )
        loader = importlib.import_module(
            "sglang.multimodal_gen.runtime.loader.component_loaders.transformer_loader"
        )
        cls = fp8_mod.Fp8LinearMethod
        original_pwal = cls.process_weights_after_loading
        original_apply = cls.apply
        original_needs = tlu._needs_device_weight_postprocess
        original_resolve = loader._resolve_checkpoint_load_device

        _needs_device_weight_postprocess, _resolve_checkpoint_load_device = (
            _fp8_placement_hooks(original_needs, original_resolve)
        )

        def process_weights_after_loading(self: Any, layer: Any) -> None:
            arming = _FP8_ARMED.get()
            if (
                arming is None
                or self.block_quant
                or not is_online_fp8(self.quant_config)
            ):
                original_pwal(self, layer)
                return
            if self.use_marlin:
                # weight-only FP8 (W8A16) on CC < 8.9 or SGLANG_FORCE_FP8_MARLIN: not the W8A8 path
                raise ValueError(
                    f"{FP8_PATCH_ID}: Fp8LinearMethod chose Marlin (weight-only FP8); refused"
                )
            bf16_bytes = _stage_fp8_weights(layer, arming, self, original_pwal)
            _record_fp8_weights(layer, arming, bf16_bytes)

        def apply(self: Any, layer: Any, x: Any, bias: Any = None) -> Any:
            if getattr(layer, "_phasyn_fp8_gemm", None) is None:
                return original_apply(self, layer, x, bias)

            return fp8_linear(layer, x, bias)

        _mark_fp8_methods(
            _MarkFp8MethodsInputs(
                process_weights_after_loading,
                original_pwal,
                apply,
                original_apply,
                _needs_device_weight_postprocess,
                original_needs,
                _resolve_checkpoint_load_device,
                original_resolve,
            )
        )
        cls.process_weights_after_loading = process_weights_after_loading
        cls.apply = apply
        tlu._needs_device_weight_postprocess = _needs_device_weight_postprocess  # type: ignore[attr-defined]
        loader._resolve_checkpoint_load_device = _resolve_checkpoint_load_device  # type: ignore[attr-defined]
        state = {"patch": FP8_PATCH_ID, "source_sha256": digests}
        _STATE["fp8"] = state
        return dict(state)


@contextlib.contextmanager
def armed_fp8_layerwise_quant(device: Any, *, gemm: str | None) -> Iterator[Fp8Arming]:
    """Quantize every online-FP8 layer of the load in this context on ``device``, one at a time."""
    install_fp8_layerwise_patch()
    arming = Fp8Arming(device=device, gemm=gemm)
    token = _FP8_ARMED.set(arming)
    try:
        yield arming
    finally:
        _FP8_ARMED.reset(token)


def patch_state() -> dict[str, Any]:
    """Report the installed upstream patches."""
    with _LOCK:
        return {
            key: (None if value is None else dict(value))
            for key, value in _STATE.items()
        }


__all__ = [
    "ADALN_PATCH_ID",
    "FP8_PATCH_ID",
    "UPSTREAM_FP8_GEMM",
    "UUID_PATCH_ID",
    "Fp8Arming",
    "armed_adaln_online_quant",
    "armed_fp8_layerwise_quant",
    "ensure_uuid_device_ids",
    "install_adaln_online_quant_patch",
    "install_fp8_layerwise_patch",
    "is_online_fp8",
    "patch_state",
    "staged_on",
]


def _stage_fp8_weights(layer: Any, arming: Any, self: Any, original_pwal: Any) -> Any:
    weight = layer.weight
    bf16_bytes = int(weight.numel()) * int(weight.element_size())
    started = time.perf_counter()
    if (
        weight.device.type == arming.device.type
    ):  # already on the device (resident load)
        original_pwal(self, layer)
    else:
        with staged_on(layer, arming.device):
            original_pwal(self, layer)
        arming.staged_layers += 1
    arming.seconds += time.perf_counter() - started
    return bf16_bytes


def _record_fp8_weights(layer: Any, arming: Any, bf16_bytes: Any) -> None:
    quantized = layer.weight
    if (
        str(quantized.dtype) != "torch.float8_e4m3fn"
        or getattr(layer, "weight_scale", None) is None
    ):
        raise ValueError(
            f"{FP8_PATCH_ID}: online FP8 left {quantized.dtype} weights (expected float8_e4m3fn)"
        )
    arming.layers += 1
    arming.bf16_bytes += bf16_bytes
    arming.fp8_bytes += int(quantized.numel()) + int(layer.weight_scale.numel()) * 4
    gemm = UPSTREAM_FP8_GEMM
    if arming.gemm is not None and supports(layer):
        layer._phasyn_fp8_gemm = arming.gemm
        gemm = arming.gemm
    arming.gemm_layers[gemm] = arming.gemm_layers.get(gemm, 0) + 1


class _MarkFp8MethodsInputs(NamedTuple):
    process_weights_after_loading: Any
    original_pwal: Any
    apply: Any
    original_apply: Any
    needs_device_weight_postprocess: Any
    original_needs: Any
    resolve_checkpoint_load_device: Any
    original_resolve: Any


def _mark_fp8_methods(inputs: _MarkFp8MethodsInputs) -> None:
    (
        process_weights_after_loading,
        original_pwal,
        apply,
        original_apply,
        _needs_device_weight_postprocess,
        original_needs,
        _resolve_checkpoint_load_device,
        original_resolve,
    ) = inputs
    wrapped: tuple[tuple[Any, Any], ...] = (
        (process_weights_after_loading, original_pwal),
        (apply, original_apply),
        (_needs_device_weight_postprocess, original_needs),
        (_resolve_checkpoint_load_device, original_resolve),
    )
    for wrapper, original in wrapped:
        wrapper.__qualname__ = original.__qualname__
        wrapper.__module__ = original.__module__
        wrapper.__doc__ = original.__doc__
        wrapper.__wrapped__ = original
        wrapper._phasyn_patch = FP8_PATCH_ID


def _fp8_placement_hooks(original_needs: Any, original_resolve: Any) -> tuple[Any, Any]:
    def _needs_device_weight_postprocess(quant_config: Any) -> bool:
        if _FP8_ARMED.get() is not None and is_online_fp8(quant_config):
            return False  # each layer is quantized on its own device round trip below
        return bool(original_needs(quant_config))

    def _resolve_checkpoint_load_device(
        runtime_device: Any,
        *,
        component_starts_on_cpu: bool,
        runtime_quant_config: Any,
        quantized_cpu_load_supported: bool = False,
    ) -> Any:
        if _FP8_ARMED.get() is not None and is_online_fp8(runtime_quant_config):
            quantized_cpu_load_supported = (
                True  # as for convrot_int8 (transformer_loader.py:492-497)
            )
        return original_resolve(
            runtime_device,
            component_starts_on_cpu=component_starts_on_cpu,
            runtime_quant_config=runtime_quant_config,
            quantized_cpu_load_supported=quantized_cpu_load_supported,
        )

    return _needs_device_weight_postprocess, _resolve_checkpoint_load_device
