# SPDX-License-Identifier: Apache-2.0
# Portions adapted from SGLang de487f8039e06853b5f376fd5f068ea9d7c400bb
# (python/sglang/multimodal_gen/runtime/loader/component_loaders/vae_loader.py (native VAE load path, in _load_video_vae_half)),
# Copyright 2023-2024 SGLang Team, licensed under Apache-2.0.
# Modified by the Phasyn Studio authors: loads one half of the video VAE.
"""Component loading through SGLang's own loaders (native layout + NF4 DiT).

* Native layout (manifest ``format`` hf_native/diffusers, directory paths):
  ``PipelineComponentLoader.load_component`` with library/class from the
  variant's ``model_index.json``.
* Single-file bitsandbytes NF4 DiT (``format`` safetensors + profile quantization
  nf4/bitsandbytes): SGLang ``TransformerLoader`` with ``transformer_weights_path``
  and a synthesized component config written under the actor workdir
 .  Text-encoder/VAE NF4 files are rejected by policy.

Weights are never downloaded: a missing path fails fast, named relative to the model
root in the diagnostic (offline enforcement).

Orchestration option (Phasyn Studio, ``SglangComponentBackend.video_vae_scope``):
an actor that only *encodes* (``encode_only``) or only *decodes* (``decode_only``) with the
MiniMax H3 video VAE loads just that half of ``video_vae/source/model.safetensors``:
``encoder.*`` + ``quant_conv.*`` (0.72 GB FP32) or ``decoder.*`` + ``post_quant_conv.*``
(9.69 GB FP32).  The module is built the way the pinned VAE loader builds it (same class,
config, dtype, strict state loading, channels-last rule, decoder dtype hold and CUDA decoder
fast path for the decode half); the other half's modules are deleted before anything is read
and only the kept tensors are read from the existing checkpoint (``safe_open``; no derived
weight files).  The encode half is constructed on the meta device, so no storage is ever
allocated for the decoder; the decode half is constructed on the host like the pinned loader
does (its non-persistent RoPE buffers are computed in the constructor) and the uninitialized
encoder placeholders are dropped unread.  ``encode`` is ``quant_conv(encoder(x))`` and decoding touches only
``post_quant_conv``/``decoder`` (klvae.py), so neither half's numerics change; the other
half's entry points refuse with ``VIDEO_VAE_HALF_NOT_LOADED``.

Weight streaming (``SglangComponentBackend.weight_streaming``, decode half only, opt-in): the
decode half is constructed on the meta device too and its 36 decoder blocks are never built
or read at load; only the shell (``post_quant_conv.*`` and the decoder's non-block tensors,
~25 MiB) is read, the decoder's non-persistent RoPE buffer is recomputed as its constructor
does, and the first ``slots`` meta blocks stay as slot templates for
``stages/vae_weight_streaming.py``, which streams the blocks for each decode.
"""

from __future__ import annotations

import contextlib
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, NamedTuple

from phasyn_components.model_identity import display_path

from phasyn_h3.recipe.abi.component import ComponentLoadSpec
from phasyn_h3.recipe.abi.tensors import read_header_from_file

from . import pins
from .accel_load import dit_load_context, finalize_dit_facts
from .backend import TorchCudaBackend
from .bounded_fp8_load import bounded_fp8_load_context
from .checkpoint_inspect import (
    REFERENCE_LAYOUT_ROOT,
    build_nf4_transformer_config,
    inspect_file,
    reference_json,
    write_overlay,
)
from .errors import ModelFilesMissing, UnsupportedCombination
from .host_store import (
    HostStore,
    build_host_store,
    drop_module_tensors,
    empty_device_cache,
    free_host_store,
    host_room_bytes,
    materialize,
    module_tensors,
    rebind_to_host,
    release_host_memory,
    reset_device_caches,
)
from .lifecycle import (
    HostMemoryInsufficient,
    LoadResult,
    OffloadResult,
    RestoreResult,
    UnloadResult,
)
from .lora import apply_lora_policy
from .model_root import model_root
from .policy import (
    ComponentPolicy,
    StagePolicy,
    host_residency_refusal,
    plan_pinned_budget,
    resolve_component_policy,
)
from .quantized_cache import quantized_cache_context
from .sglang_env import SglangSession
from .stages import vae_weight_streaming as ws
from .stages.prepare_adaln import sidecar_path
from .stages.vae_weight_streaming import StreamingConfig, streaming_state


_WEIGHT_ENTRY_FIELDS = 2


VIDEO_VAE_SCOPES = ("full", "encode_only", "decode_only")
# top-level modules of the MiniMax H3 video VAE (klvae.py AutoencoderKLLegacy) per half
VIDEO_VAE_HALVES: dict[str, tuple[str, ...]] = {
    "encode_only": ("encoder", "quant_conv"),
    "decode_only": ("decoder", "post_quant_conv"),
}
# entry points that need the half a scope does NOT load (they refuse instead of failing obscurely)
VIDEO_VAE_MISSING_ENTRY_POINTS: dict[str, tuple[str, ...]] = {
    "encode_only": (
        "decode",
        "decode_base",
        "decode_temporal",
        "tiled_decode",
        "_adaptive_decode",
        "_decode_temporal_streaming",
        "prepare_decoder_autocast_weights",
    ),
    "decode_only": (
        "encode",
        "encode_base",
        "encode_temporal",
        "tiled_encode",
        "_adaptive_encode",
        "encode_images",
        "encode_videos",
    ),
}
_KIND_TO_SGLANG = {
    "processor": ("processor", "transformers"),
    "tokenizer": ("tokenizer", "transformers"),
    "text_encoder": ("text_encoder", "transformers"),
    "transformer": ("transformer", "diffusers"),
    "video_vae": ("video_vae", "diffusers"),
    "audio_vae": ("audio_vae", "diffusers"),
}


@dataclass(frozen=True)
class ComponentLocation:
    """Identify the on-disk files for a model component."""

    kind: str
    component_id: str
    path: Path
    format: str
    model_id: str
    model_revision: str
    variant: str

    @property
    def single_file(self) -> bool:
        """Return the path of the single-file checkpoint."""
        return self.path.is_file() and self.path.suffix == ".safetensors"


def locate_component(
    model: Mapping[str, Any], kind: str, *, root: Path | None = None
) -> ComponentLocation:
    """Resolve ``PHASYN_MODEL_ROOT`` + manifest ``relative_path`` (fail fast)."""
    root = root or model_root()
    entries = [c for c in model.get("components", []) if c.get("kind") == kind]
    if len(entries) != 1:
        raise ModelFilesMissing(
            "MANIFEST_COMPONENT",
            f"model manifest 需恰有一個 {kind} component，找到 {len(entries)}",
        )
    entry = entries[0]
    rel = str(entry["relative_path"])
    candidate = (root / rel).resolve()
    if root not in candidate.parents and candidate != root:
        raise ModelFilesMissing(
            "PATH_ESCAPES_ROOT", f"{kind} 路徑 {rel} 逃出 model root"
        )
    if not candidate.exists():
        raise ModelFilesMissing(
            "WEIGHTS_NOT_ON_DISK",
            f"{kind} 權重不存在：{display_path(candidate, root)}（offline enforcement：不自動下載；請先取得並驗證該 component）",
        )
    if entry.get("verification") == "rejected":
        raise ModelFilesMissing(
            "COMPONENT_REJECTED", f"{kind} 已被 registry 標為 rejected"
        )
    return ComponentLocation(
        kind=kind,
        component_id=str(entry["component_id"]),
        path=candidate,
        format=str(entry.get("format", "hf_native")),
        model_id=str(model.get("model_id")),
        model_revision=str(model.get("source_revision")),
        variant=str(model.get("variant", "fl2va")).lower(),
    )


def reference_model_index(variant: str) -> dict[str, Any]:
    """The variant's upstream ``model_index.json`` from the user's MiniMax-H3 snapshot (SHA-256 verified)."""
    name = (
        "ref2va_model_index.json"
        if variant in ("ref2va", "hybrid")
        else "fl2va_model_index.json"
    )
    return reference_json(name, model_root=model_root())


def model_index_for(location: ComponentLocation) -> tuple[Path, dict[str, Any], str]:
    """Variant directory, its model_index.json and where it came from (relative to the model root).

    A component outside a snapshot variant directory (e.g. a single-file NF4 DiT next to the
    snapshot) uses the snapshot's own ``model_index.json`` of the same variant.
    """
    variant_dir = location.path.parent
    index_path = variant_dir / "model_index.json"
    if index_path.is_file():
        source = display_path(index_path, model_root())
        return variant_dir, json.loads(index_path.read_text(encoding="utf-8")), source
    return (
        variant_dir,
        reference_model_index(location.variant),
        f"reference:{location.variant}_model_index.json",
    )


def sniff_single_file(location: ComponentLocation) -> None:
    """Reject single-file components the pinned loaders cannot honour (header only)."""
    header = read_header_from_file(location.path)
    bnb = any(".quant_state.bitsandbytes__" in name for name in header.tensors)
    if bnb and location.kind == "text_encoder":
        raise UnsupportedCombination(
            "NF4_TEXT_ENCODER_UNSUPPORTED",
            f"{location.path.name} 是 bitsandbytes 4-bit text encoder；釘版 SGLang 沒有 H3 encoder 的 bnb 載入路徑",
        )
    if bnb and location.kind in ("video_vae", "audio_vae"):
        raise UnsupportedCombination(
            "NF4_VAE_UNSUPPORTED",
            f"{location.path.name} 是 bitsandbytes 4-bit VAE；"
            "釘版 VAE loader 無法還原 bnb 序列化狀態（vae_loader.py:62-100）",
        )
    raise UnsupportedCombination(
        "SINGLE_FILE_NOT_WIRED",
        f"{location.kind} 單檔 safetensors（{location.path.name}）在此 shim 只支援 transformer NF4 路徑",
    )


@dataclass
class LoadedComponent:
    """Keep the loaded model with its source and device information."""

    kind: str
    module: Any
    location: ComponentLocation
    policy: ComponentPolicy | None
    server_args: Any
    facts: dict[str, Any] = field(default_factory=dict)
    on_device: bool = True
    # host copy of the tensors this backend moves between host and device:
    # every parameter/buffer for component/none offload, the non-layer ones for
    # layerwise offload (the SGLang managers own the layer stores)
    host_store: HostStore | None = None
    layerwise: bool = False


def _cuda(device: Any) -> bool:
    return getattr(device, "type", str(device)) == "cuda"


class SglangComponentBackend:
    """``lifecycle.ComponentBackend`` implementation over SGLang loaders."""

    def __init__(
        self,
        session: SglangSession,
        device_backend: TorchCudaBackend,
        workdir: Path,
        *,
        video_vae_scope: str = "full",
        weight_streaming: Mapping[str, Any] | None = None,
    ) -> None:
        """Bind SGLang component loading to the selected runtime."""
        self.session = session
        self.device = device_backend
        self.workdir = workdir
        self._requests: dict[str, dict[str, Any]] = {}
        # orchestration only (module docstring): "full" | "encode_only" | "decode_only"
        self.video_vae_scope = video_vae_scope
        # orchestration only (module docstring): None, or the resolved provider_options.weight_streaming
        self.weight_streaming = (
            dict(weight_streaming) if weight_streaming is not None else None
        )

    def register_request(
        self,
        spec: ComponentLoadSpec,
        *,
        policy: StagePolicy,
        location: ComponentLocation,
    ) -> None:
        """Attach the stage policy/location the next ``load(spec)`` must use."""
        self._requests[spec.single_flight_key] = {
            "policy": policy,
            "location": location,
        }

    def _allocated(self) -> int:
        return int(self.device.memory_snapshot().get("allocated_bytes") or 0)

    # -- ComponentBackend -------------------------------------------------
    def load(self, spec: ComponentLoadSpec) -> LoadResult:
        """Load a model component from its checkpoint with the selected policy."""
        request = self._requests.get(spec.single_flight_key)
        if request is None:
            raise UnsupportedCombination(
                "LOAD_REQUEST_MISSING", f"{spec.component_id} 沒有對應的 stage policy"
            )
        policy: StagePolicy = request["policy"]
        location: ComponentLocation = request["location"]
        torch_device = self.device.torch_device()
        self.session.ensure_process(torch_device)
        before = self._allocated()
        self.device.reset_peak()
        started = time.perf_counter()
        accel: Any = contextlib.nullcontext({})
        if location.kind == "transformer":
            # online quant gates / JIT build / AdaLN x quant + per-layer FP8 patch arming
            accel = dit_load_context(policy, self.device.facts(), torch_device)
        with accel as accel_facts:
            if location.kind == "transformer" and location.single_file:
                module, server_args, facts = self._load_nf4_transformer(
                    policy, location
                )
            else:
                module, server_args, facts = self._load_native(policy, location)
        facts["checkpoint_load_seconds"] = round(time.perf_counter() - started, 6)
        if location.kind == "transformer":
            facts["acceleration"] = finalize_dit_facts(module, policy, accel_facts)
        comp_policy = policy.components.get(location.kind)
        layerwise = comp_policy is not None and comp_policy.layerwise
        if layerwise:
            if comp_policy is None:
                raise RuntimeError("comp_policy is unavailable in this stage")
            facts["layerwise"] = self._configure_layerwise(
                module, location.kind, comp_policy, server_args
            )
        if location.kind == "transformer":
            # after layerwise configuration, like upstream's "offload, then wrap" (pipeline.py:442-485)

            facts["lora"] = apply_lora_policy(
                module, policy.lora, device=torch_device, workdir=self.workdir
            )
        handle = LoadedComponent(
            kind=location.kind,
            module=module,
            location=location,
            policy=comp_policy,
            server_args=server_args,
            facts=facts,
            layerwise=layerwise,
        )
        if (
            comp_policy is not None
            and comp_policy.component_cpu_offload
            and hasattr(module, "named_parameters")
        ):
            # component offload: the weights live in a host store (pinned up to
            # max_pinned_bytes) and the whole component is copied to the device
            # for each use; the loader's own copy (mmap view or anonymous memory)
            # is dropped as the module is rebound to the store
            store = build_host_store(
                module_tensors(module),
                pinned_cap_bytes=comp_policy.max_pinned_bytes,
                pin=_cuda(torch_device),
                host_available_bytes=host_room_bytes(),
            )
            rebind_to_host(module, store)
            handle.host_store = store
            facts["host_store"] = store.facts()
            empty_device_cache(torch_device)
            facts["transfer"] = materialize(module, store, torch_device)
        elif (
            comp_policy is not None
            and not layerwise
            and _cuda(torch_device)
            and hasattr(module, "to")
            # offload=none: resident on the device.  SGLang's VAE offload flag is
            # shared by both VAEs, so a component-offloaded video VAE makes the
            # loader start the audio VAE on the CPU as well.
            and any(t.device.type != "cuda" for _, _, t in module_tensors(module))
        ):
            started = time.perf_counter()
            module.to(torch_device)
            self.device.synchronize()
            facts["moved_to_device_after_load_seconds"] = round(
                time.perf_counter() - started, 6
            )
        self.device.synchronize()
        snap = self.device.memory_snapshot()
        after = int(snap.get("allocated_bytes") or 0)
        peak = snap.get("max_allocated_bytes")
        return LoadResult(
            handle=handle,
            allocated_bytes=max(0, after - before),
            peak_loading_bytes=None if peak is None else max(0, int(peak) - before),
            details=facts,
        )

    def unload(self, handle: Any, spec: ComponentLoadSpec) -> UnloadResult:
        """Evict: the device copy *and* every host copy (host store, layer stores) are freed here.

        ``_release_memory`` breaks the module's references before anything is collected: the
        layerwise managers point back at the module (``manager.model``), so a ``gc.collect``
        while a local still holds a manager (the loop variable of the old code) freed nothing,
        and an evict outside a stage (``release_component``) has no later collection — the
        pinned and pageable host copies stayed in the actor until it exited.
        """
        del spec
        before = self._allocated()
        details: dict[str, Any] = {}
        if isinstance(handle, LoadedComponent):
            details = _release_memory(handle)
        del handle
        details["gc_collected"] = (
            release_host_memory()
        )  # nothing in this frame points into the module
        synced = self.device.synchronize()
        self.device.empty_cache()
        after = self._allocated()
        return UnloadResult(
            released_bytes=max(0, before - after),
            cuda_synchronized=synced,
            details=details,
        )

    def offload(self, handle: Any, spec: ComponentLoadSpec) -> OffloadResult:
        """Release the device copy; keep the weights in host memory.

        Layerwise: every SGLang manager releases all layers (their host stores
        stay) and the non-layer parameters/buffers are parked in a host store.
        Component/none: the module is rebound to its host store (built on the
        first offload by a device->host copy).  Refused with
        :class:`HostMemoryInsufficient` *before* anything moves when the host
        cannot hold a new copy (MemAvailable minus a 2 GiB reserve).
        """
        if not isinstance(handle, LoadedComponent) or handle.module is None:
            raise HostMemoryInsufficient(
                "OFFLOAD_NOT_SUPPORTED", f"{spec.component_id} 沒有可 offload 的模組"
            )
        refusal = (
            None
            if handle.policy is None
            else host_residency_refusal(
                spec.component_id,
                handle.policy.quant_scheme,
                handle.policy.quant_provider,
            )
        )
        if (
            refusal is not None
        ):  # policy rejects these up front; a directive-driven load can still get here
            raise HostMemoryInsufficient(
                "HOST_RESIDENCY_QUANTIZED_UNVALIDATED", f"{refusal}（改為釋放）"
            )
        module = handle.module
        torch_device = self.device.torch_device()
        started = time.perf_counter()
        before = self._allocated()
        details: dict[str, Any] = {}
        # lazily built caches (e.g. the DiT's inference-mode ``_frequency_cache`` buffer) are dropped,
        # never parked: the model rebuilds them, and an inference tensor cannot be rebound later
        reset_device_caches(module)
        if handle.host_store is None:
            exclude: set[str] = set()
            if handle.layerwise:
                # the managers keep their own host copies: never copy their layers a second time
                pins.check_attrs(
                    module,
                    pins.LAYERWISE_MODULE_ATTRS,
                    what="layerwise 元件的 host 常駐",
                )
                exclude = set(module._managed_layer_parameter_names())
            items = module_tensors(module, exclude=exclude)
            cap = handle.policy.max_pinned_bytes if handle.policy is not None else 0
            if handle.layerwise:
                lw = handle.facts.get("layerwise") or {}
                cap = max(
                    0,
                    cap
                    - int(lw.get("pinned_committed_bytes") or 0)
                    - int(lw.get("courier_reserve_bytes") or 0),
                )
            # refused (HostMemoryInsufficient) before anything moves when the host
            # cannot hold the copy; the provider then evicts instead
            handle.host_store = build_host_store(
                items,
                pinned_cap_bytes=cap,
                pin=_cuda(torch_device),
                host_available_bytes=host_room_bytes(),
            )
            details["host_store_built"] = True
        store = handle.host_store
        if handle.layerwise:
            released_layers = 0
            for manager in module.layerwise_offload_managers or []:
                pins.check_attrs(
                    manager, ("release_all",), what="layerwise 元件的 host 常駐"
                )
                manager.release_all()
                released_layers += 1
            details["layerwise_managers_released"] = released_layers
        rebind_to_host(module, store)
        repointed = _repoint_lora_snapshots(module)
        if repointed:
            details["lora_snapshots_repointed"] = repointed
        synced = empty_device_cache(torch_device)
        handle.on_device = False
        after = self._allocated()
        details["host_store"] = store.facts()
        details["device_tensor_bytes_left"] = _device_tensor_bytes(module)
        if handle.policy is not None and handle.policy.quantized:
            # convrot_int8 / online FP8: INT8 or E4M3 (transposed view, strides kept by host_layout)
            # weights + FP32 row scales parked as they are (no BF16 copy, no re-quantization)
            details["quantized_host_bytes"] = {
                str(dtype): size
                for dtype, size in sorted(
                    _host_bytes_by_dtype(store).items(), key=lambda kv: str(kv[0])
                )
            }
        # everything the component now holds in host memory (layerwise: + the managers' layer stores)
        held = self.host_footprint(handle) or {
            "host_bytes": store.host_bytes,
            "pinned_bytes": store.pinned_bytes,
        }
        return OffloadResult(
            released_bytes=max(0, before - after),
            cuda_synchronized=synced,
            host_bytes=held["host_bytes"],
            pinned_bytes=held["pinned_bytes"],
            seconds=time.perf_counter() - started,
            details={**details, "allocated_after_bytes": after},
        )

    def restore(self, handle: Any, spec: ComponentLoadSpec) -> RestoreResult:
        """Copy the host store back to the device (layers stream again on demand)."""
        if (
            not isinstance(handle, LoadedComponent)
            or handle.module is None
            or handle.host_store is None
        ):
            raise UnsupportedCombination(
                "RESTORE_WITHOUT_HOST_COPY", f"{spec.component_id} 沒有 host 副本可還原"
            )
        torch_device = self.device.torch_device()
        before = self._allocated()
        try:
            transfer = materialize(handle.module, handle.host_store, torch_device)
        except BaseException:
            # roll back to the host copy so the registry can keep host_cached
            rebind_to_host(handle.module, handle.host_store)
            empty_device_cache(torch_device)
            raise
        handle.on_device = True
        after = self._allocated()
        return RestoreResult(
            allocated_bytes=max(0, after - before),
            transferred_bytes=int(transfer["bytes"]),
            seconds=float(transfer["seconds"]),
            details={"transfer": transfer, "layerwise": handle.layerwise},
        )

    def host_footprint(self, handle: Any) -> dict[str, int] | None:
        """Host memory the component holds right now (``lifecycle`` residency reports, also while it is on the device): its host store (component offload, or the copy kept after a host offload) plus, for layerwise offload, the SGLang managers' per-layer host copies and courier staging slots (``layer_store_bytes``).

        None when that cannot be told.
        """
        if not isinstance(handle, LoadedComponent) or handle.module is None:
            return None
        host = pinned = 0
        if handle.host_store is not None:
            host += int(handle.host_store.host_bytes)
            pinned += int(handle.host_store.pinned_bytes)
        streamed = _streaming_state(handle.module)
        if streamed is not None:  # staging buffers or the host copy of the blocks
            held_host, held_pinned = streamed.host_footprint()
            host += held_host
            pinned += held_pinned
        if handle.layerwise:
            layers = layer_store_bytes(handle.module)
            if layers is None:
                return None
            host += layers[0]
            pinned += layers[1]
        return {"host_bytes": host, "pinned_bytes": pinned}

    def trim(self, handle: Any, spec: ComponentLoadSpec) -> dict[str, Any]:
        """after_use=device for a layerwise component: drop the streamed window, keep the resident layer set (SGLang ``release_after_use(keep_resident=True)``)."""
        del spec
        if (
            not isinstance(handle, LoadedComponent)
            or not handle.layerwise
            or handle.module is None
        ):
            return {}
        before = self._allocated()
        trimmed = 0
        pins.check_attrs(
            handle.module,
            ("layerwise_offload_managers",),
            what="layerwise 元件的使用後裁減",
        )
        for manager in handle.module.layerwise_offload_managers or []:
            pins.check_attrs(
                manager, ("release_after_use",), what="layerwise 元件的使用後裁減"
            )
            manager.release_after_use(keep_resident=True)
            trimmed += 1
        synced = empty_device_cache(self.device.torch_device())
        return {
            "layerwise_managers_trimmed": trimmed,
            "released_bytes": max(0, before - self._allocated()),
            "cuda_synchronized": synced,
        }

    # -- native layout ------------------------------------------------------
    def _model_path(self, location: ComponentLocation) -> Path:
        """One stable ``model_path`` per model revision (config resolution only).

        Component weights are always passed explicitly; ``model_path`` only lets
        SGLang resolve the H3 pipeline config.  A component directory without
        ``model_index.json`` gets the snapshot's verified copy in the process workdir.
        """
        variant_dir, index, _source = model_index_for(location)
        if (variant_dir / "model_index.json").is_file():
            return variant_dir
        overlay = (
            self.workdir
            / "overlays"
            / f"{location.model_id}-{location.model_revision[:12]}"
        )
        overlay.mkdir(parents=True, exist_ok=True)
        target = overlay / "model_index.json"
        if not target.is_file():
            target.write_text(
                json.dumps(index, indent=2, sort_keys=True), encoding="utf-8"
            )
        return overlay

    def _server_args(
        self,
        policy: StagePolicy,
        *,
        model_path: Path,
        variant: str,
        weights: str | None = None,
        kind: str = "",
    ) -> Any:

        # Knobs come from every component the frozen profile can express, not only
        # this stage's, so one job keeps one ServerArgs across its stages.
        merged = dict(policy.components)
        for name, comp_profile in (
            policy.effective_profile.get("components") or {}
        ).items():
            if name in merged:
                continue
            try:
                merged[name] = resolve_component_policy(
                    name, comp_profile, mode=policy.mode
                )
            except UnsupportedCombination:
                continue

        adaln_cache_path = None
        if policy.adaln_mode == "fixed":
            cache_ref = str(
                (policy.effective_profile.get("adaln") or {}).get("cache_ref")
            )
            # SGLang opens this path when it builds the DiT (minimax_h3_adaln_cache.py:455);
            # other components only carry the name (the sidecar lives on the DiT node)
            if kind == "transformer":
                adaln_cache_path = str(sidecar_path(cache_ref))
            else:
                adaln_cache_path = cache_ref
        kwargs = SglangSession.build_kwargs(
            model_path=str(model_path),
            variant=variant,
            policy=replace(policy, components=merged),
            transformer_weights_path=weights,
            adaln_cache_path=adaln_cache_path,
        )
        return self.session.server_args_for(kwargs)

    def _video_vae_scope(self) -> str:
        scope = self.video_vae_scope
        if scope not in VIDEO_VAE_SCOPES:
            raise UnsupportedCombination(
                "VIDEO_VAE_SCOPE_INVALID",
                f"video_vae_scope={scope!r} 不合法（{'／'.join(VIDEO_VAE_SCOPES)}）",
            )
        return str(scope)

    def _load_native(
        self, policy: StagePolicy, location: ComponentLocation
    ) -> tuple[Any, Any, dict[str, Any]]:
        if not location.path.is_dir():
            sniff_single_file(location)
        if location.kind == "video_vae" and self._video_vae_scope() != "full":
            return self._load_video_vae_half(policy, location, self._video_vae_scope())
        if location.kind == "video_vae":
            self._weight_streaming(
                self._video_vae_scope()
            )  # refuses weight_streaming for a full video VAE
        _variant_dir, index, index_source = model_index_for(location)
        entry = index.get(location.kind)
        if not isinstance(entry, list) or len(entry) != _WEIGHT_ENTRY_FIELDS:
            raise ModelFilesMissing(
                "MODEL_INDEX_ENTRY",
                f"model_index.json 沒有 {location.kind} 的 [library, class]",
            )
        library, architecture = entry
        server_args = self._server_args(
            policy,
            model_path=self._model_path(location),
            variant=location.variant,
            kind=location.kind,
        )
        from sglang.multimodal_gen.runtime.loader.component_loaders.component_loader import (  # type: ignore[import-untyped]
            PipelineComponentLoader,
        )

        sglang_name, _ = _KIND_TO_SGLANG[location.kind]
        bounded: Any = contextlib.nullcontext({"enabled": False})
        cached: Any = contextlib.nullcontext({"enabled": False})
        if location.kind == "transformer":
            bounded = bounded_fp8_load_context(policy, location.path)
            # opt-in (provider_options.quantized_cache): off yields {"enabled": False} and patches nothing
            cached = quantized_cache_context(policy, location.path, self.device.facts())
        with bounded as bounded_facts, cached as cache_facts:
            module, memory_usage = PipelineComponentLoader.load_component(
                component_name=sglang_name,
                component_model_path=str(location.path),
                transformers_or_diffusers=str(library),
                server_args=server_args,
                component_architecture=str(architecture),
            )
        facts: dict[str, Any] = {
            "loader": "PipelineComponentLoader.load_component",
            "library": library,
            "architecture": architecture,
            "model_index": index_source,
            "sglang_memory_usage_gib": memory_usage,
            "bounded_cold_load": bounded_facts,
        }
        if cache_facts.get("enabled"):
            facts["quantized_cache"] = cache_facts
        return module, server_args, facts

    # -- one half of the video VAE (orchestration option) -----------------------
    def _load_video_vae_half(
        self, policy: StagePolicy, location: ComponentLocation, scope: str
    ) -> tuple[Any, Any, dict[str, Any]]:
        """The pinned VAE loader's native path (vae_loader.py VAELoader.load_customized + ComponentLoader.load finalize) for one half of the MiniMax H3 video VAE; see the module docstring.

        Placement (device / host store) stays with :meth:`load` as for a full load.
        """
        import torch
        from safetensors import safe_open
        from sglang.multimodal_gen.runtime.loader.component_loaders import (  # type: ignore[import-untyped]
            vae_loader as sg_vae,
        )
        from sglang.multimodal_gen.runtime.loader.component_loaders.component_loader import (
            ComponentLoader,
        )
        from sglang.multimodal_gen.runtime.loader.utils import (  # type: ignore[import-untyped]
            adopt_plain_weight_norm_state,
            finalize_loaded_model,
            initialize_model,
            load_model_state_dict,
        )
        from sglang.multimodal_gen.runtime.models.registry import ModelRegistry  # type: ignore[import-untyped]
        from sglang.multimodal_gen.runtime.utils.hf_diffusers_utils import (  # type: ignore[import-untyped]
            get_diffusers_component_config,
        )
        from sglang.multimodal_gen.runtime.utils.precision import (  # type: ignore[import-untyped]
            resolve_component_precision,
        )
        from sglang.multimodal_gen.runtime.utils.precision_types import (  # type: ignore[import-untyped]
            PRECISION_TO_TYPE,
        )

        index_source, library, architecture = _video_vae_index(location)
        server_args = self._server_args(
            policy,
            model_path=self._model_path(location),
            variant=location.variant,
            kind=location.kind,
        )
        component_path = str(location.path)
        loader = ComponentLoader.for_component_type(
            "video_vae", str(library), str(architecture)
        )
        config, class_name, weights_path = _video_vae_config(
            loader, server_args, scope, component_path, get_diffusers_component_config
        )
        vae_config = server_args.pipeline_config.vae_config
        vae_precision = server_args.pipeline_config.vae_precision
        resolved_dtype = resolve_component_precision(server_args, "video_vae")
        vae_dtype = (
            resolved_dtype
            if resolved_dtype is not None
            else PRECISION_TO_TYPE[vae_precision]
        )
        vae_config.update_model_arch(config)
        if hasattr(vae_config, "post_init"):
            vae_config.post_init()
        checkpoint = _half_checkpoint(
            _HalfCheckpointInputs(
                loader, weights_path, server_args, vae_precision, scope
            )
        )
        header = read_header_from_file(checkpoint)
        half = video_vae_half_plan(header.tensors, scope)
        streaming = self._weight_streaming(scope)
        started = time.perf_counter()
        vae_cls, _ = ModelRegistry.resolve_model_cls(class_name)
        # encode half: meta construction (the decoder never gets storage); decode half: host construction like
        # the pinned loader (non-persistent RoPE buffers are made in the constructor); weight-streaming decode
        # half: meta as well, no decoder block is built or read here.  The other half's modules are deleted
        # before any tensor is read.
        construct_on = (
            torch.device("meta")
            if scope == "encode_only" or streaming is not None
            else None
        )
        vae = initialize_model(vae_cls, {"config": vae_config}, vae_dtype, construct_on)
        for name in half["drop_modules"]:
            delattr(vae, name)
        blocks, slots, keep = _streaming_slots(half, streaming, checkpoint, header, vae)
        loaded: dict[str, Any] = {}
        with safe_open(str(checkpoint), framework="pt", device="cpu") as handle:
            for name in keep:
                loaded[name] = handle.get_tensor(name)
        num_deparameterized = adopt_plain_weight_norm_state(vae, loaded)
        consumed = sg_vae._consume_vae_checkpoint_arch_metadata(
            loaded, vae_config, vae.state_dict()
        )
        load_model_state_dict(vae, loaded, strict=True, assign=True)
        rope_rebuilt = ws.rebuild_rope_buffers(vae) if streaming is not None else 0
        channels_last = sg_vae._should_use_channels_last_3d(server_args, "video_vae")
        if channels_last:
            sg_vae._convert_conv3d_weights_to_channels_last_3d(vae)
        vae = _optimize_half(
            vae,
            _CheckHalfKeysInputs(scope, streaming, server_args, weights_path, slots),
        )
        guarded = _guard_half_vae(scope, vae)
        vae = finalize_loaded_model(
            vae
        )  # rejects any meta tensor left, freezes, eval()
        del loaded
        streaming_facts = _streaming_facts(
            _StreamingFactsInputs(streaming, blocks, slots, self, vae, rope_rebuilt)
        )
        return (
            vae,
            server_args,
            {
                "loader": "phasyn_h3.recipe.runtime.loaders.video_vae_half (pinned VAELoader native path, subset read)",
                "library": library,
                "architecture": architecture,
                "model_index": index_source,
                "checkpoint": display_path(checkpoint, model_root()),
                "video_vae_scope": {
                    **{k: v for k, v in half.items() if k != "keep"},
                    "dtype": str(vae_dtype),
                    "constructed_on": "meta" if construct_on is not None else "host",
                    "channels_last_3d": bool(channels_last),
                    "weight_norm_adopted": int(num_deparameterized),
                    "checkpoint_metadata_consumed": list(consumed),
                    "guarded_entry_points": guarded,
                    "read_seconds": round(time.perf_counter() - started, 6),
                    **streaming_facts,
                },
            },
        )

    def _weight_streaming(self, scope: str) -> Any:
        """The resolved ``StreamingConfig`` for a video-VAE half, or None (option off)."""
        if self.weight_streaming is None:
            return None

        if scope != "decode_only":
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_SCOPE",
                f"weight_streaming 只適用 video_vae_scope=decode_only（此元件是 {scope}）",
            )
        return StreamingConfig.from_mapping(self.weight_streaming)

    # -- NF4 single-file DiT --------------------------------------------------
    def _load_nf4_transformer(
        self, policy: StagePolicy, location: ComponentLocation
    ) -> tuple[Any, Any, dict[str, Any]]:
        comp = policy.components.get("transformer")
        if (
            comp is None
            or comp.quant_scheme != "nf4"
            or comp.quant_provider != "bitsandbytes"
        ):
            raise UnsupportedCombination(
                "SINGLE_FILE_REQUIRES_NF4_PROFILE",
                "單檔 transformer 只支援 profile quantization nf4/bitsandbytes（其他單檔格式未接入）",
                field_path="components.transformer.quantization",
            )
        facts = inspect_file(location.path)
        config = build_nf4_transformer_config(
            facts,
            qkv_layout=policy.declaration.transformer_qkv_layout,
            declared_architecture=policy.declaration.transformer_architecture,
            model_root=model_root(),
        )
        overlay = (
            self.workdir
            / "overlays"
            / f"{location.component_id}-{location.model_revision[:12]}"
        )
        transformer_dir = write_overlay(
            overlay,
            weights_file=location.path,
            config=config,
            model_index=reference_model_index(location.variant),
            component_root=model_root()
            / REFERENCE_LAYOUT_ROOT
            / ("Ref2VA" if location.variant in ("ref2va", "hybrid") else "FL2VA"),
        )
        server_args = self._server_args(
            policy,
            model_path=overlay,
            variant=location.variant,
            weights=str(location.path),
            kind="transformer",
        )
        from sglang.multimodal_gen.runtime.loader.component_loaders.component_loader import (
            PipelineComponentLoader,
        )

        module, memory_usage = PipelineComponentLoader.load_component(
            component_name="transformer",
            component_model_path=str(transformer_dir),
            transformers_or_diffusers="diffusers",
            server_args=server_args,
            component_architecture="MiniMaxH3DiTModel",
        )
        arch = getattr(module, "arch", None)
        if (
            facts.pruned_curve
            and facts.adaln_curve_shape is not None
            and getattr(arch, "adaln_curve_grid", None) != facts.adaln_curve_shape[0]
        ):
            raise UnsupportedCombination(
                "PRUNED_CURVE_NOT_APPLIED",
                "SGLang 未依標頭套用 pruned AdaLN curve 維度",
            )
        return (
            module,
            server_args,
            {
                "loader": "TransformerLoader(transformer_weights_path) + synthesized config",
                "quant": {
                    "scheme": "nf4",
                    "provider": "bitsandbytes",
                    "double_quant": facts.double_quant,
                },
                "skip_modules": len(facts.plain_quant_capable_prefixes),
                "quantized_linears": len(facts.quantized_prefixes),
                "pruned_curve": facts.adaln_curve_shape,
                "qkv_layout": "concat(declared)",
                "overlay_dir": overlay.name,
                "sglang_memory_usage_gib": memory_usage,
            },
        )

    # -- layerwise offload ----------------------------------------------------
    def _configure_layerwise(
        self, module: Any, kind: str, comp: ComponentPolicy, server_args: Any
    ) -> dict[str, Any]:
        from sglang.multimodal_gen.runtime.managers.memory_managers.host_memory_budget import (  # type: ignore[import-untyped]
            HostPinBudget,
        )
        from sglang.multimodal_gen.runtime.managers.memory_managers.layerwise_offload import (  # type: ignore[import-untyped]
            LayerwiseOffloadableModuleMixin,
            configure_layerwise_offload_modules,
        )

        if not isinstance(module, LayerwiseOffloadableModuleMixin):
            raise UnsupportedCombination(
                "LAYERWISE_NOT_SUPPORTED", f"{kind} 不支援 layerwise offload"
            )
        layer_bytes = _layer_bytes(module)
        pinned = plan_pinned_budget(
            comp.max_pinned_bytes, layer_bytes, cuda=self.device.facts().sm is not None
        )
        budget = HostPinBudget()
        # tighten the upstream budget to the profile cap minus the courier slots
        budget.available_bytes = min(
            int(budget.spendable_bytes), int(pinned.layer_budget_bytes)
        )
        budget.reserve_bytes = 0
        sglang_name, _ = _KIND_TO_SGLANG[kind]
        configured = configure_layerwise_offload_modules(
            {sglang_name: module}, server_args, [sglang_name], pin_budget=budget
        )
        managers = getattr(module, "layerwise_offload_managers", []) or []
        groups = []
        for manager in managers:
            groups.append(
                {
                    "layers_attr": getattr(manager, "layers_attr_str", None),
                    "num_layers": getattr(manager, "num_layers", None),
                    "prefetch_size": getattr(manager, "prefetch_size", None),
                    "resident_layers": getattr(manager, "resident_layers", None),
                }
            )
            if getattr(manager, "prefetch_size", comp.prefetch_depth) not in (
                comp.prefetch_depth,
                getattr(manager, "num_layers", -1),
            ):
                raise UnsupportedCombination(
                    "PREFETCH_NOT_HONOURED",
                    f"{kind}.{manager.layers_attr_str}: SGLang prefetch={manager.prefetch_size} "
                    f"≠ 要求 {comp.prefetch_depth}",
                )
        return {
            "configured": configured,
            "groups": groups,
            "pinned_cap_bytes": pinned.cap_bytes,
            "courier_reserve_bytes": pinned.courier_reserve_bytes,
            "courier_reserve_by_group": dict(pinned.courier_groups),
            "layer_pin_budget_bytes": int(budget.available_bytes),
            "pinned_committed_bytes": int(budget.committed_bytes),
        }


def video_vae_half_plan(tensors: Mapping[str, Any], scope: str) -> dict[str, Any]:
    """Which checkpoint tensors a video-VAE half keeps, by top-level module (torch-free).

    ``tensors`` is a safetensors header (name -> info with ``byte_length``).  Every tensor must
    belong to one of the two halves; anything else (e.g. statistics a future checkpoint might
    carry) refuses the split instead of being silently dropped or loaded.
    """
    if scope not in VIDEO_VAE_HALVES:
        raise UnsupportedCombination(
            "VIDEO_VAE_SCOPE_INVALID",
            f"{scope} 不是 video VAE 的半邊（encode_only／decode_only）",
        )
    keep_modules = VIDEO_VAE_HALVES[scope]
    known = {m for half in VIDEO_VAE_HALVES.values() for m in half}
    groups: dict[str, dict[str, int]] = {}
    keep: list[str] = []
    unknown: list[str] = []
    for name, info in tensors.items():
        top = name.split(".", 1)[0]
        if top not in known:
            unknown.append(name)
            continue
        group = groups.setdefault(top, {"tensors": 0, "bytes": 0})
        group["tensors"] += 1
        group["bytes"] += int(info.byte_length)
        if top in keep_modules:
            keep.append(name)
    if unknown:
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_LAYOUT",
            f"video VAE checkpoint 有不屬於 encoder／decoder 兩半的 tensor {sorted(unknown)[:5]}；不拆開載入",
        )
    kept = {m: g for m, g in groups.items() if m in keep_modules}
    dropped = {m: g for m, g in groups.items() if m not in keep_modules}
    return {
        "scope": scope,
        "keep_modules": list(keep_modules),
        "drop_modules": [
            m
            for half in VIDEO_VAE_HALVES.values()
            for m in half
            if m not in keep_modules
        ],
        "groups": dict(sorted(groups.items())),
        "keep": sorted(keep),
        "kept_tensors": sum(g["tensors"] for g in kept.values()),
        "kept_bytes": sum(g["bytes"] for g in kept.values()),
        "skipped_tensors": sum(g["tensors"] for g in dropped.values()),
        "skipped_bytes": sum(g["bytes"] for g in dropped.values()),
    }


def _missing_half_refusal(scope: str) -> Any:
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_NOT_LOADED",
            f"此 video VAE 以 video_vae_scope={scope} 載入（{'／'.join(VIDEO_VAE_HALVES[scope])} 以外未載入），不能做這個操作",
        )

    return refuse


def _streaming_state(module: Any) -> Any:
    """The weight-streaming state of a video-VAE shell (``stages/vae_weight_streaming.py``), else None."""
    return streaming_state(module) if module is not None else None


def _repoint_lora_snapshots(module: Any) -> int:
    """LoRA wrappers hold ``cpu_weight``, a zero-copy view of the base weight (``snapshot_base=False``, ``linear.py:97-102``); once the weight moved to its host copy, a view of the old device storage would keep that storage allocated.

    Re-point it at the (now host) base weight.
    """
    count = 0
    for sub in module.modules():
        snapshot = sub.__dict__.get("cpu_weight")
        base = sub.__dict__.get("_modules", {}).get("base_layer")
        if (
            snapshot is None
            or base is None
            or getattr(getattr(snapshot, "device", None), "type", "cpu") == "cpu"
        ):
            continue
        sub.cpu_weight = base.weight.detach()
        count += 1
    return count


def _device_tensor_bytes(module: Any) -> int:
    """Bytes of parameters/buffers still on an accelerator (layerwise placeholders are a few bytes)."""
    return sum(
        int(t.numel()) * int(t.element_size())
        for _name, _kind, t in module_tensors(module)
        if getattr(t.device, "type", "cpu") != "cpu"
    )


def _host_bytes_by_dtype(store: HostStore) -> dict[Any, int]:
    out: dict[Any, int] = {}
    for tensor in store.tensors.values():
        out[tensor.dtype] = out.get(tensor.dtype, 0) + int(tensor.numel()) * int(
            tensor.element_size()
        )
    return out


def close_layerwise(module: Any) -> int:
    """Unload of a layerwise component: stop each SGLang manager (forward hooks, mapped-layer courier and populator threads) and drop everything it holds — per-layer host stores, checkpoint-mapped views, the ``model`` back-reference — then detach the managers from the module.

    Returns the number of managers closed.
    """
    managers = list(getattr(module, "layerwise_offload_managers", None) or [])
    for manager in managers:
        with contextlib.suppress(Exception):
            manager.remove_forward_hooks()
        for attr in ("_mapped_courier", "_mapped_populator"):
            helper = manager.__dict__.get(attr)
            if helper is not None:
                with contextlib.suppress(
                    Exception
                ):  # joins its threads (layerwise_offload.py:657,825)
                    helper.close()
        manager.__dict__.clear()
    if managers:
        with contextlib.suppress(Exception):
            module.layerwise_offload_managers = []
    return len(managers)


def _release_memory(handle: LoadedComponent) -> dict[str, Any]:
    """Free what a loaded component holds and leave the handle empty (``unload``)."""
    details: dict[str, Any] = {}
    module, handle.module = handle.module, None
    store, handle.host_store = handle.host_store, None
    if store is not None:
        details["host_bytes_released"] = int(store.host_bytes)
        details["pinned_bytes_released"] = int(store.pinned_bytes)
    if module is not None:
        layers = layer_store_bytes(module) if handle.layerwise else None
        if layers is not None:
            (
                details["layer_store_bytes_released"],
                details["layer_store_pinned_bytes_released"],
            ) = layers
        streamed = _streaming_state(module)
        if (
            streamed is not None
        ):  # staging buffers / host copy of the blocks and the checkpoint descriptor
            held = streamed.host_footprint()
            (
                details["weight_streaming_host_bytes_released"],
                details["weight_streaming_pinned_bytes_released"],
            ) = held
            streamed.close()
        details["layerwise_managers_closed"] = close_layerwise(module)
        details["tensors_dropped"] = drop_module_tensors(module)
    free_host_store(
        store, collect=False
    )  # unload collects once, from a frame without the module
    return details


def layer_store_bytes(module: Any) -> tuple[int, int] | None:
    """(host, pinned) bytes of the SGLang layerwise managers' host memory: the per-layer copies (``_consolidated_cpu_weights``/``_strided_cpu_weights``, pinned or pageable) and the mapped-layer courier's staging slots; layers left on the checkpoint mapping (page cache) and the permanently resident layers hold none.

    None when a manager does not expose its stores (pinned SGLang de487f8, ``layerwise_offload.py:1116-1131,774-785``).
    """
    managers = getattr(module, "layerwise_offload_managers", None)
    if not managers:
        return None
    seen: set[int] = set()
    host = pinned = 0

    def count(tensor: Any) -> None:
        nonlocal host, pinned
        storage = tensor.untyped_storage()
        ptr = int(storage.data_ptr())
        if ptr == 0 or ptr in seen:
            return
        seen.add(ptr)
        nbytes = int(storage.nbytes())
        host += nbytes
        if tensor.is_pinned():
            pinned += nbytes

    try:
        for manager in managers:
            if not _count_manager_buffers(manager, count):
                return None
    except (AttributeError, RuntimeError, TypeError):
        return None
    return host, pinned


def _layer_bytes(module: Any) -> dict[str, list[tuple[int, int]]]:
    """Layer group -> (bytes, tensor_count) per streamable layer (one courier per group)."""
    out: dict[str, list[tuple[int, int]]] = {}
    named = dict(module.named_modules())
    for name in getattr(module, "layer_names", []) or []:
        container = named.get(name)
        if container is None or len(container) == 0:
            continue
        group = out.setdefault(str(name), [])
        for layer in container:
            params = list(layer.parameters())
            group.append(
                (sum(p.numel() * p.element_size() for p in params), len(params))
            )
    return out


__all__ = [
    "VIDEO_VAE_HALVES",
    "VIDEO_VAE_MISSING_ENTRY_POINTS",
    "VIDEO_VAE_SCOPES",
    "ComponentLocation",
    "LoadedComponent",
    "SglangComponentBackend",
    "close_layerwise",
    "layer_store_bytes",
    "locate_component",
    "model_index_for",
    "reference_model_index",
    "sniff_single_file",
    "video_vae_half_plan",
]


def _video_vae_index(location: ComponentLocation) -> tuple[Any, Any, Any]:
    _variant_dir, index, index_source = model_index_for(location)
    entry = index.get("video_vae")
    if not isinstance(entry, list) or len(entry) != _WEIGHT_ENTRY_FIELDS:
        raise ModelFilesMissing(
            "MODEL_INDEX_ENTRY",
            "model_index.json 沒有 video_vae 的 [library, class]",
        )
    library, architecture = entry
    return index_source, library, architecture


def _video_vae_config(
    loader: Any,
    server_args: Any,
    scope: str,
    component_path: Any,
    get_diffusers_component_config: Any,
) -> tuple[dict[str, Any], str | None, str]:
    if loader.resolve_component_direct_gpu_loading(server_args, "video_vae"):
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_DIRECT_GPU", f"{scope} 不接受 direct GPU weight loading"
        )
    weights_path = loader.resolve_component_weights_path(
        component_path, server_args, "video_vae"
    )
    if weights_path != component_path:
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_OVERRIDE", f"{scope} 不接受 video_vae 權重覆寫路徑"
        )
    config = get_diffusers_component_config(component_path=component_path)
    server_args.model_paths["video_vae"] = component_path
    if not loader.is_native_only_component(server_args, "video_vae"):
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_NOT_NATIVE",
            f"{scope} 只複製釘版的 native VAE 載入路徑；此 pipeline 的 video_vae 不是",
        )
    class_name = config.pop("_class_name", None)
    return config, class_name, weights_path


class _HalfCheckpointInputs(NamedTuple):
    loader: Any
    weights_path: Any
    server_args: Any
    vae_precision: Any
    scope: str


def _half_checkpoint(inputs: _HalfCheckpointInputs) -> Any:
    from sglang.multimodal_gen.runtime.loader.utils import _list_safetensors_files
    from sglang.multimodal_gen.runtime.weights.source import (  # type: ignore[import-untyped]
        filter_duplicate_precision_variant_safetensors,
    )

    loader, weights_path, server_args, vae_precision, scope = inputs
    files = loader.select_weight_files(
        _list_safetensors_files(weights_path, raw_candidates=True),
        weights_path,
        server_args,
        "video_vae",
        vae_precision,
    )
    files = filter_duplicate_precision_variant_safetensors(files)
    if len(files) != 1:
        raise UnsupportedCombination(
            "VIDEO_VAE_HALF_FILES",
            f"{scope} 需要恰好一個 video VAE 權重檔，找到 {files}",
        )
    return Path(files[0])


class _CheckHalfKeysInputs(NamedTuple):
    scope: str
    streaming: Any
    server_args: Any
    weights_path: Any
    slots: list[Any]


def _optimize_half(vae: Any, inputs: _CheckHalfKeysInputs) -> Any:
    from sglang.multimodal_gen.runtime.loader.component_loaders import (
        vae_loader as sg_vae,
    )
    from sglang.multimodal_gen.runtime.platforms import current_platform  # type: ignore[import-untyped]

    scope, streaming, server_args, weights_path, slots = inputs
    if (
        scope == "decode_only" and streaming is None
    ):  # the loader's decoder post-processing, unchanged
        sg_vae._hold_decoder_weights_in_decode_dtype(
            vae, server_args, "video_vae", weights_path, component_type="video_vae"
        )
        vae = current_platform.optimize_vae(vae)
    elif scope == "decode_only":
        # the shell holds no block linear to round (fp16: each streamed block is rounded on the device);
        # the slot templates get the quality-gated attention forwards the resident blocks get
        with ws.blocks_attached(vae, slots):
            optimized = current_platform.optimize_vae(vae)
        if optimized is not vae:
            raise UnsupportedCombination(
                "WEIGHT_STREAMING_OPTIMIZE",
                "optimize_vae 換掉了 video VAE 模組；不串流",
            )
    return vae


def _count_manager_buffers(manager: Any, count: Callable[[Any], None]) -> bool:
    for attr in ("_consolidated_cpu_weights", "_strided_cpu_weights"):
        table = getattr(manager, attr, None)
        if not isinstance(table, Mapping):
            return False
        for per_layer in table.values():
            for tensor in per_layer.values():
                count(tensor)
    courier = getattr(manager, "_mapped_courier", None)
    for tensor in getattr(courier, "_slots", None) or []:
        count(tensor)
    return True


def _streaming_slots(
    half: Any, streaming: Any, checkpoint: Any, header: Any, vae: Any
) -> tuple[Any, list[Any], Any]:
    keep = list(half["keep"])
    slots: list[Any] = []
    blocks = None
    if streaming is not None:
        blocks = ws.block_index(
            checkpoint,
            header,
            keep=keep,
            num_blocks=len(vae.decoder.transformer_blocks),
        )
        slots = ws.detach_blocks(vae, streaming)
        keep = list(blocks.shell)
    return blocks, slots, keep


def _guard_half_vae(scope: str, vae: Any) -> Any:
    guarded = [
        n
        for n in VIDEO_VAE_MISSING_ENTRY_POINTS[scope]
        if callable(getattr(vae, n, None))
    ]
    refusal = _missing_half_refusal(scope)
    for name in guarded:
        object.__setattr__(vae, name, refusal)
    object.__setattr__(vae, "_phasyn_video_vae_scope", scope)
    return guarded


class _StreamingFactsInputs(NamedTuple):
    streaming: Any
    blocks: Any
    slots: Any
    self: SglangComponentBackend
    vae: Any
    rope_rebuilt: Any


def _streaming_facts(inputs: _StreamingFactsInputs) -> dict[str, Any]:
    streaming, blocks, slots, self, vae, rope_rebuilt = inputs
    streaming_facts: dict[str, Any] = {}
    if streaming is not None:
        if blocks is None:
            raise RuntimeError("blocks is unavailable in this stage")
        state = ws.WeightStreamingState(
            config=streaming,
            index=blocks,
            slots=slots,
            pin=_cuda(self.device.torch_device()),
        )
        ws.attach_state(vae, state)
        streaming_facts = {
            "weight_streaming": {
                **state.facts(),
                "rope_buffers_rebuilt": rope_rebuilt,
            }
        }
    return streaming_facts
