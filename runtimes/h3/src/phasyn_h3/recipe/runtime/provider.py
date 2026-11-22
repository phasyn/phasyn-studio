"""SGLangH3Provider — executes H3 recipe stages on one device inside a component process.

* ``execute_stage(stage, ctx)`` — resolves the stage policy, runs one stage kind and returns a
  :class:`~phasyn_h3.recipe.abi.stage.StageResult` (failures are results, cancellation raises);
* ``use_component(run, kind)`` — single-flight, refcounted acquisition through the component registry,
  followed by the component's between-use policy;
* ``synchronize_stage()`` — stage-end release evidence: CUDA synchronize, the stage's transient memory
  returned to the driver, and what stays resident (``resident_components`` on the device,
  ``host_cached_components`` in host memory; each with ``last_used_at`` and the host memory it holds);
* ``shutdown()``.

Every stage reports the info diagnostics ``RUNTIME_MEMORY`` (allocator/NVML numbers, host RSS, host copies,
host->device weight transfers) and ``RUNTIME_COMPUTE`` (analytic FLOP and compute timing, ``measure.py``),
and ``RUNTIME_COST`` when it recorded ETA work (``StageRun.cost``, ``measure.COST_STAGES``).

After each use a component follows its between-use policy
(``ComponentPolicy.residency``, profile extension ``phasyn.sglang_h3.residency``):
``device`` keeps it on the GPU (a layerwise component only drops its streamed
window), ``host`` releases the device copy and keeps the weights in host memory
(``host_cached``; evicted instead when the host cannot hold them), ``drop`` evicts.

Torch and SGLang are imported lazily through the device/component backends so
this module (and its tests with fake backends) stays torch-free.
"""

from __future__ import annotations

import contextlib
import gc
import json
import os
import sys
import tempfile
import traceback
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import AbstractContextManager
from dataclasses import replace
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypedDict, Unpack, cast

from phasyn_components.errors import Cancelled

from phasyn_h3.recipe.abi.component import ComponentLease, ComponentLoadSpec
from phasyn_h3.recipe.abi.errors import diagnostic
from phasyn_h3.recipe.abi.stage import StageContext, StageResult

from . import PROVIDER_ID, PROVIDER_VERSION
from ._arguments import validate_keywords
from ._observations import RuntimeObservation
from .acceleration import quant_variant
from .errors import ShimError, UnsupportedCombination, classify_exception
from .lifecycle import ComponentRegistry, HostMemoryInsufficient
from .measure import cost_message, runtime_measurements
from .policy import ComponentPolicy, StagePolicy, resolve_stage_policy


class _ProviderArguments(TypedDict, total=False):
    workdir: str | Path | None
    actor_instance_id: str | None
    backend: Any
    component_backend: Any
    video_vae_scope: str
    weight_streaming: Mapping[str, Any] | None
    on_component: Callable[[str, Any, Any], AbstractContextManager[Any]] | None
    on_evict: Callable[[], None] | None


_SUMMARY_MAX_CHARS = 1900


if TYPE_CHECKING:
    from .regional_compile_cache import RegionBank
    from .sglang_env import SglangSession

_NON_MODULE_KINDS = ("processor", "tokenizer")
_REPORT_KEYS = (
    "released_bytes",
    "cuda_synchronized",
    "state",
    "host_bytes",
    "pinned_bytes",
    "seconds",
    "layerwise_managers_trimmed",
    "note",
)


def _visible_index(device: Mapping[str, Any]) -> int | None:
    """CUDA ordinal inside this process (the component host narrows CUDA_VISIBLE_DEVICES to one GPU)."""
    index = device.get("device_index")
    if index is None:
        return None
    narrowed = os.environ.get("PHASYN_ACTOR_CUDA_NARROWED") == "1"
    return 0 if narrowed else int(index)


class SGLangH3Provider:
    """Run native H3 stages against the pinned SGLang implementation."""

    provider_id = PROVIDER_ID
    provider_version = PROVIDER_VERSION

    session: SglangSession | None

    def __init__(
        self, device: Mapping[str, Any], **arguments: Unpack[_ProviderArguments]
    ) -> None:
        """``video_vae_scope`` (orchestration only): which video-VAE half the component loader builds.

        ``weight_streaming`` (orchestration only, decode half): None, or the resolved
        ``provider_options.weight_streaming`` — the loader then builds a streaming shell
        (``stages/vae_weight_streaming.py``).
        ``on_component(kind, run, module)`` wraps every use of a component's module (the host's DiT
        instrumentation); ``on_evict`` runs after every evict (``ComponentRegistry``).
        """
        validate_keywords(arguments, _ProviderArguments)
        workdir = arguments.get("workdir")
        actor_instance_id = arguments.get("actor_instance_id")
        backend = arguments.get("backend")
        component_backend = arguments.get("component_backend")
        video_vae_scope = arguments.get("video_vae_scope", "full")
        weight_streaming = arguments.get("weight_streaming")
        on_component = arguments.get("on_component")
        on_evict = arguments.get("on_evict")
        self._h3_compile_bank: RegionBank | None = None
        self.device = dict(device)
        base = (
            workdir or os.environ.get("PHASYN_ACTOR_WORKDIR") or tempfile.gettempdir()
        )
        self.workdir = Path(base) / "sglang_h3"
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.actor_instance_id = (
            actor_instance_id
            or os.environ.get("PHASYN_ACTOR_INSTANCE_ID")
            or str(uuid.uuid4())
        )
        if backend is None:
            cuda_backend = import_module(
                "phasyn_h3.recipe.runtime.backend"
            ).TorchCudaBackend

            backend = cuda_backend(
                self.device, visible_index=_visible_index(self.device)
            )
        self.backend = backend
        if component_backend is None:
            component_backend = import_module(
                "phasyn_h3.recipe.runtime.loaders"
            ).SglangComponentBackend
            session_type = import_module(
                "phasyn_h3.recipe.runtime.sglang_env"
            ).SglangSession

            self.session = session_type(self.workdir)
            component_backend = component_backend(
                self.session,
                backend,
                self.workdir,
                video_vae_scope=video_vae_scope,
                weight_streaming=weight_streaming,
            )
        else:
            self.session = getattr(component_backend, "session", None)
        self.components = component_backend
        self.registry = ComponentRegistry(
            component_backend,
            actor_instance_id=self.actor_instance_id,
            on_evict=on_evict,
        )
        self._on_component = on_component
        self._last_leases: dict[str, ComponentLease] = {}
        self._stage_h2d_bytes = (
            0  # weight bytes copied host->device during the current stage
        )
        self._environment: dict[str, Any] | None = None

    # ------------------------------------------------------------------ facts
    def environment(self) -> dict[str, Any]:
        """Describe the environment that executes this component."""
        if self._environment is None:
            self._environment = self.backend.environment()
        return dict(self._environment)

    def torch_device(self) -> Any:
        """Return the torch device selected for this runtime."""
        return self.backend.torch_device()

    def server_args(self) -> Any:
        """Return the SGLang arguments for this provider."""
        if self.session is None or self.session.server_args is None:
            raise ShimError(
                "SERVER_ARGS_UNAVAILABLE",
                "SGLang ServerArgs 尚未建立（先載入元件）",
                error_code="INTERNAL",
            )
        return self.session.server_args

    def pipeline_config(self) -> Any:
        """Return the resolved SGLang pipeline configuration."""
        return self.server_args().pipeline_config

    def last_lease(self, kind: str) -> ComponentLease | None:
        """Return the component lease most recently used by the provider."""
        return self._last_leases.get(kind)

    # ------------------------------------------------------------ components
    @staticmethod
    def _variant_key(kind: str, stage_policy: StagePolicy) -> str:
        """What changes a loaded DiT beyond its files: AdaLN mode/sidecar and LoRA identity."""
        if kind != "transformer":
            return ""
        adaln = stage_policy.adaln_mode
        if adaln == "fixed":
            adaln = f"fixed@{(stage_policy.effective_profile.get('adaln') or {}).get('cache_ref')}"
        lora = (
            stage_policy.lora.adapters_signature
            if stage_policy.lora is not None
            else "none"
        )
        # the LoRA identity leaves out the PDD grouping (one file, one sidecar); the fused heads differ per grouping
        specs = stage_policy.lora.specs if stage_policy.lora is not None else ()
        blocks = next((spec.pdd_blocks for spec in specs if spec.pdd_blocks), None)
        if blocks:
            lora = f"{lora};pdd={'-'.join(str(b) for b in blocks)}"
        key = f"adaln={adaln};lora={lora}"
        # online quant: which layers stayed BF16 (acceleration.quant_variant)
        quant = quant_variant(
            (stage_policy.effective_profile.get("components") or {}).get("transformer")
        )
        return f"{key};{quant}" if quant else key

    def _spec_for(
        self, location: Any, policy: ComponentPolicy | None, variant_key: str = ""
    ) -> ComponentLoadSpec:
        return ComponentLoadSpec(
            model_id=location.model_id,
            model_revision=location.model_revision,
            component_id=location.component_id,
            kind=location.kind,
            path=str(location.path),
            weight_format=policy.weight_format if policy else "native",
            compute_dtype=policy.compute_dtype if policy else "native",
            quantization={
                "scheme": policy.quant_scheme,
                "provider": policy.quant_provider,
            }
            if policy
            else {},
            offload=policy.offload if policy else "none",
            resident_layers=policy.resident_layers if policy else 0,
            prefetch_depth=policy.prefetch_depth if policy else 1,
            max_pinned_bytes=policy.max_pinned_bytes if policy else 0,
            device_index=self.device.get("device_index"),
            variant_key=variant_key,
        )

    @contextlib.contextmanager
    def use_component(
        self,
        run: Any,
        kind: str,
        *,
        keep_on_device: bool = False,
        policy_override: ComponentPolicy | None = None,
    ) -> Iterator[Any]:
        """Acquire a component for one stage, then apply its between-use policy.

        ``keep_on_device`` (load_dit) leaves the component on the device for the
        next stage of the same process whatever its policy says.
        """
        locate_component = import_module(
            "phasyn_h3.recipe.runtime.loaders"
        ).locate_component

        location = locate_component(run.plan.get("model") or {}, kind)
        comp_policy = policy_override or run.policy.components.get(kind)
        if kind not in _NON_MODULE_KINDS and comp_policy is None:
            raise UnsupportedCombination(
                "COMPONENT_POLICY_MISSING",
                f"{run.kind} 沒有 {kind} 的 component policy",
            )
        stage_policy: StagePolicy = run.policy
        if policy_override is not None:
            stage_policy = replace(
                stage_policy,
                components={**stage_policy.components, kind: policy_override},
            )
        spec = self._spec_for(
            location, comp_policy, self._variant_key(kind, stage_policy)
        )
        register = getattr(self.components, "register_request", None)
        if callable(register):
            register(spec, policy=stage_policy, location=location)
        self._evict_siblings(run, kind, spec)
        lease = self.registry.acquire(
            spec,
            residency=comp_policy.residency.as_dict()
            if comp_policy is not None
            else None,
        )
        self._last_leases[kind] = lease
        if comp_policy is not None:
            facts = self.registry.entry_facts(lease.component_key)
            transfer = facts.get("last_transfer") or {}
            if transfer:
                run.fact("COMPONENT_ACQUIRED", {"kind": kind, **facts})
                moved = transfer.get(
                    "transferred_bytes", (transfer.get("transfer") or {}).get("bytes")
                )
                if transfer.get("kind") == "load" and moved is None:
                    moved = transfer.get("bytes")
                self._stage_h2d_bytes += int(moved or 0)
        handle = lease.handle
        module = getattr(handle, "module", handle)
        hook = (
            self._on_component(kind, run, module)
            if self._on_component is not None
            else contextlib.nullcontext()
        )
        try:
            with hook:
                yield module
        finally:
            remaining = self.registry.release_reference(lease.component_key)
            if remaining == 0 and comp_policy is not None and not keep_on_device:
                self._apply_after_use(run, kind, lease.component_key, comp_policy)

    def _evict_siblings(self, run: Any, kind: str, spec: ComponentLoadSpec) -> None:
        """One runtime identity per component and process: an idle copy of the same component under other settings (e.g. another decode precision) is evicted before a new one loads, so host and device never hold both."""
        for key in self.registry.siblings(spec):
            with RuntimeObservation() as eviction:
                report = self.registry.evict(key)
            if (exc := eviction.error) is not None:
                run.warn(
                    "COMPONENT_SIBLING_KEPT", f"{kind}: {key} 無法釋放：{exc}"[:500]
                )
                continue
            run.fact(
                "COMPONENT_SIBLING_EVICTED",
                {
                    "kind": kind,
                    **{
                        k: report.get(k)
                        for k in ("component_key", *_REPORT_KEYS)
                        if k in report
                    },
                },
            )

    def _apply_after_use(
        self, run: Any, kind: str, key: str, comp_policy: ComponentPolicy
    ) -> None:
        """Between-use placement after the last reference is dropped.

        Never raises: this runs in ``finally`` (also while a stage failure
        propagates); a failure is reported and the real state still goes
        out with the stage-end ``synchronize_stage`` report.
        """
        requested_after = comp_policy.residency.after_use
        effective = requested_after
        report: dict[str, Any] = {}
        with RuntimeObservation() as residency:
            if requested_after == "device":
                trim = getattr(self.components, "trim", None)
                lease = self.registry.get(key)
                if comp_policy.layerwise and callable(trim) and lease is not None:
                    report = dict(trim(lease.handle, lease.spec) or {})
            elif requested_after == "host":
                try:
                    report = self.registry.offload(key)
                except HostMemoryInsufficient as exc:
                    run.warn(
                        "HOST_RESIDENCY_FALLBACK_DROP",
                        f"{kind}：無法保留 host 副本（{exc.reason_code}：{exc.message}）；改為釋放，下次從 checkpoint 重讀",
                    )
                    report = self.registry.evict(key)
                    effective = "drop"
            else:
                report = self.registry.evict(key)
        if (stage_error := residency.error) is not None:
            run.warn(
                "COMPONENT_RESIDENCY_FAILED",
                f"{kind}：after_use={requested_after} 失敗：{type(stage_error).__name__}: {stage_error}"[
                    :1000
                ],
            )
            return
        run.fact(
            "COMPONENT_RESIDENCY",
            {
                "kind": kind,
                "component_key": key,
                "after_use_requested": requested_after,
                "after_use_effective": effective,
                "source": comp_policy.residency.source,
                **{k: report[k] for k in _REPORT_KEYS if k in report},
            },
        )

    def synchronize_stage(self) -> dict[str, Any]:
        """Stage-end release evidence (``phasyn_h3.host`` records it after every invoke).

        Drops the stage's Python references, synchronizes the device and returns
        cached blocks to the driver, so the stage's transient (incremental) memory
        is really gone; what stays is listed: ``resident_components`` (device,
        becomes component leases) and ``host_cached_components`` (host memory).
        """
        gc.collect()
        synced = bool(self.backend.synchronize())
        flush = getattr(self.backend, "empty_cache_after_collection", None)
        if os.environ.get("PHASYN_H3_SINGLE_STAGE_GC") == "1" and callable(flush):
            flush()  # references were just collected above: skip empty_cache's second gc pass
        else:
            self.backend.empty_cache()
        snap = self.backend.memory_snapshot()
        device, host = self.registry.residency_report(exclude_kinds=_NON_MODULE_KINDS)
        report: dict[str, Any] = {
            "cuda_synchronized": synced,
            "evidence": "synchronized_unload" if synced else "none",
            "device_uuid": self.device.get("device_uuid"),
            "actor_instance_id": self.actor_instance_id,
            "allocated_bytes": snap.get("allocated_bytes"),
            "reserved_bytes": snap.get("reserved_bytes"),
            "resident_components": device,
            "host_cached_components": host,
        }
        return report

    def shutdown(self) -> None:
        """Release the components and resources owned by this host."""
        if self._h3_compile_bank is not None:
            self._h3_compile_bank.close()
            self._h3_compile_bank = None
        self.registry.evict_all()
        self.backend.synchronize()
        self.backend.empty_cache()
        with contextlib.suppress(Exception):
            from sglang.multimodal_gen.runtime.distributed.parallel_state import (  # type: ignore[import-untyped]
                destroy_distributed_environment,
                destroy_model_parallel,
            )

            destroy_model_parallel()
            destroy_distributed_environment()

    def _failed(
        self, exc: BaseException, extra: list[dict[str, Any]], code: str | None = None
    ) -> StageResult:
        code = code or classify_exception(exc)
        diagnostics = list(extra)
        if isinstance(exc, ShimError):
            diagnostics.append(exc.as_diagnostic())
        else:
            # the traceback goes to stderr (the component process log); the diagnostic names the
            # innermost frames so a failure is locatable from the recording alone
            tb = traceback.extract_tb(exc.__traceback__)
            where = " ← ".join(
                f"{Path(f.filename).name}:{f.lineno} {f.name}"
                for f in reversed(tb[-3:])
            )
            sys.stderr.write("".join(traceback.format_exception(exc)) + "\n")
            sys.stderr.flush()
            diagnostics.append(
                diagnostic(code, f"{type(exc).__name__}: {exc}（{where}）"[:2000])
            )
        return StageResult(
            status="failed",
            outputs=[],
            diagnostics=diagnostics,
            active_profile_digest=None,
            error_code=code,
        )

    def _memory_fact(self) -> dict[str, Any]:
        """RUNTIME_MEMORY: device allocator/NVML numbers, the process's host RSS (``peak_host_bytes`` = this stage's VmHWM, ``max_rss_bytes`` = process peak), host copies it keeps (``host_cached_bytes``: host-cached components; ``pinned_host_bytes``: pinned memory of every component, layerwise host stores of device-resident ones included) and this stage's host->device weight transfers (``h2d_bytes``)."""
        snap: dict[str, Any] = dict(self.backend.memory_snapshot())
        _device, host = self.registry.residency_report()
        snap["host_cached_bytes"] = sum(int(c.get("host_bytes") or 0) for c in host)
        _held, pinned = self.registry.held_host_bytes()
        snap["pinned_host_bytes"] = int(pinned)
        snap["h2d_bytes"] = int(self._stage_h2d_bytes)
        return diagnostic(
            "RUNTIME_MEMORY", json.dumps(snap, sort_keys=True)[:2000], severity="info"
        )

    def execute_stage(self, stage: Mapping[str, Any], ctx: StageContext) -> StageResult:
        """Execute a declared native stage and publish its result."""
        stage_runner = import_module("phasyn_h3.recipe.runtime.stages").stage_runner
        stage_run_type = import_module(
            "phasyn_h3.recipe.runtime.stages.common"
        ).StageRun

        kind = str(stage.get("kind"))
        try:
            runner = stage_runner(kind)
        except KeyError:
            return self._failed(
                UnsupportedCombination(
                    "STAGE_KIND_NOT_RUNTIME", f"sglang_h3 不執行 {kind}"
                ),
                [],
            )
        facts = self.backend.facts()
        try:
            policy = resolve_stage_policy(
                ctx.plan,
                kind,
                memory_level=int(ctx.memory_level or 0),
                sm_major=facts.sm_major,
                sm=facts.sm,
            )
        except ShimError as exc:
            return self._failed(exc, [])
        run = stage_run_type(provider=self, stage=stage, ctx=ctx, policy=policy)
        if policy.applied_overrides:
            run.fact(
                "MEMORY_LEVEL_OVERRIDES",
                {"level": policy.memory_level, "overrides": policy.applied_overrides},
            )
        self.backend.reset_peak()
        self._stage_h2d_bytes = 0
        try:
            with RuntimeObservation(Cancelled, ShimError) as stage_call:
                result = runner(run)
        except Cancelled:  # StageCanceled and phasyn_media's MediaCanceled: the host turns it into a cancel
            raise
        except ShimError as exc:
            return self._failed(
                exc,
                [
                    *run.diagnostics,
                    self._memory_fact(),
                    *self._measure_facts(kind, run),
                ],
            )
        if (stage_error := stage_call.error) is not None:
            code = classify_exception(stage_error)
            memory = self._memory_fact()
            if code == "GPU_OOM":
                # drop any partially built tensors before reporting the failure
                gc.collect()
                with contextlib.suppress(Exception):
                    self.backend.synchronize()
                with contextlib.suppress(Exception):
                    self.backend.empty_cache()
            return self._failed(
                stage_error,
                [*run.diagnostics, memory, *self._measure_facts(kind, run)],
                code,
            )
        result.diagnostics.append(self._memory_fact())
        result.diagnostics.extend(self._measure_facts(kind, run))
        return cast("StageResult", result)

    def _measure_facts(self, kind: str, run: Any) -> list[dict[str, Any]]:
        """RUNTIME_COMPUTE, and RUNTIME_COST when the stage recorded ETA work (``StageRun.cost``); for failed stages too, so a failure still reports the size it ran into."""
        facts = [self._compute_fact(kind, run)]
        text = cost_message(kind, list((run.measurements.get("cost") or {}).values()))
        if text is not None:
            facts.append(diagnostic("RUNTIME_COST", text, severity="info"))
        return facts

    def _compute_fact(self, kind: str, run: Any) -> dict[str, Any]:
        """RUNTIME_COMPUTE: the stage's analytic FLOPs and compute timing (``measure.py``), for failed stages too.

        When the JSON would not fit the diagnostic, ``per_step_seconds`` is summarized.
        """
        doc = dict(runtime_measurements(kind, run.measurements))
        text = json.dumps(doc, sort_keys=True, allow_nan=False)
        steps = doc.get("per_step_seconds") or []
        if len(text) > _SUMMARY_MAX_CHARS and steps:
            ordered = sorted(steps)
            doc["per_step_seconds"] = None
            doc["per_step_summary"] = {
                "count": len(steps),
                "first": steps[0],
                "median": ordered[len(ordered) // 2],
                "max": ordered[-1],
            }
            text = json.dumps(doc, sort_keys=True, allow_nan=False)
        return diagnostic("RUNTIME_COMPUTE", text[:2000], severity="info")


__all__ = ["SGLangH3Provider"]
