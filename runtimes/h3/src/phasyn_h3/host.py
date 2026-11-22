"""Run H3 recipe stages inside the component process (``SGLangH3Provider.execute_stage``).

The :class:`~phasyn_h3.recipe.abi.stage.StageContext` is assembled here and the plan comes from
``phasyn_h3.plan``; every stage's RUNTIME_MEMORY / RUNTIME_COMPUTE diagnostics and facts go to the
Recorder, and RUNTIME_COST becomes the recording's ``cost.stages`` (the ETA data).  Stage failures come back as a ``StageResult`` (not an exception) and become a
``ComponentError`` here; a stage stopped at a cancel point raises ``Cancelled`` for a cancel and
``ComponentError("CALL_TIMEOUT")`` for an expired deadline (``reraise_stop``).
"""

from __future__ import annotations

import contextlib
import importlib
import json
import time
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any, NoReturn, cast

from phasyn_components.errors import Cancelled, ComponentError, is_registered
from phasyn_components.recorder import Recorder

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.stage import StageCanceled, StageContext, StageInput


# recipe error codes -> component contract codes; any other code becomes RUNTIME_ERROR unless it is a
# registered contract code (the recipe's own code is always kept in details.runtime_error_code)
ERROR_MAP = {
    "GPU_OOM": "GPU_OOM",
    "HOST_OOM": "HOST_OOM",
    # HostMemoryInsufficient: the host cannot hold a component's host copy; refused before anything moved
    "RESOURCE_EXHAUSTED": "HOST_MEMORY_INSUFFICIENT",
    "INVALID_ARGUMENT": "INVALID_ARGUMENT",
    "UNSUPPORTED_COMBINATION": "UNSUPPORTED_SETTING",
    "INTEGRITY_MISMATCH": "MODEL_INCOMPATIBLE",
    "ENCODER_CONTRACT_MISMATCH": "MODEL_INCOMPATIBLE",
    "MODEL_ERROR": "RUNTIME_ERROR",
    "INTERNAL": "RUNTIME_ERROR",
    "GPU_DEVICE_LOST": "RUNTIME_ERROR",
    "WORKER_UNAVAILABLE": "RUNTIME_ERROR",
}


def contract_code(code: str) -> str:
    """The component contract code for a recipe error code (never an unregistered code on the wire)."""
    mapped = ERROR_MAP.get(code, code)
    return mapped if is_registered(mapped) else "RUNTIME_ERROR"


FACT_LOG_LIMIT = 6000
# 也要出現在紀錄 notes 的 stage 診斷（除了照常記成 log）：實驗參數與釘版「未驗證」警告不能只埋在事件裡
NOTE_CODES = frozenset({"REFERENCE_VIDEO_SHORT_EDGE_UNVERIFIED"})
NOTE_LIMIT = 1000


class _LinkedToken:
    """The stage's cancel signal, linked to the RunContext's cancel/deadline."""

    def __init__(self, cancelled: Any) -> None:
        self._cancelled = cancelled
        self.reason = ""

    def is_set(self) -> bool:
        return bool(self._cancelled())

    def raise_if_set(self) -> None:
        if self.is_set():
            raise StageCanceled("已要求取消")


def reraise_stop(
    exc: Cancelled, check_cancelled: Callable[[], None] | None
) -> NoReturn:
    """A stage stopped at a cancel point: raise what it really was.

    The recipe's cancel signal is ``RunContext.cancelled()``, true for a user cancel *and* for an
    expired call deadline, so the recipe only knows "stop". ``check_cancelled``
    (``RunContext.check_cancelled``) tells them apart: an expired deadline raises
    ``ComponentError("CALL_TIMEOUT")``, a cancel raises ``Cancelled``; otherwise ``exc`` is re-raised.
    """
    if check_cancelled is not None:
        check_cancelled()
    raise exc


def record_cost_entries(rec: Recorder, doc: Any) -> int:
    """``RUNTIME_COST`` → the recording's ``cost.stages`` (ETA data); returns how many were recorded.

    An entry the recorder refuses is a measurement failure (noted on the recording), never a failed call.
    """
    if not isinstance(doc, Mapping):
        if doc is not None:
            rec.measurement_error("RUNTIME_COST 不是 JSON 物件")
        return 0
    recorded = 0
    for entry in doc.get("stages") or []:
        if not isinstance(entry, Mapping):
            continue
        seconds = entry.get("seconds")
        raw_shape = entry.get("shape")
        shape: dict[str, Any] = (
            dict(raw_shape) if isinstance(raw_shape, Mapping) else {}
        )
        try:
            rec.record_cost(
                str(entry.get("stage")),
                work=cast(
                    float, entry.get("work")
                ),  # validated by the recorder (ValueError / TypeError below)
                unit=str(entry.get("unit")),
                compute_ms=None if seconds is None else float(seconds) * 1000.0,
                **shape,
            )
        except (TypeError, ValueError) as exc:
            rec.measurement_error(f"cost {entry.get('stage')}: {exc}")
        else:
            recorded += 1
    if doc.get("dropped"):
        rec.measurement_error(f"RUNTIME_COST 放不下，少記 {doc['dropped']} 個 stage")
    return recorded


def rope_cache_reset() -> Callable[[], None]:
    """The registry's ``on_evict``: clear SGLang's process-wide ``_ROPE_DICT``.

    SGLang 以程序全域 ``_ROPE_DICT`` 共用 RotaryEmbedding；元件被 evict 時共用 buffer 會被清掉，
    同程序重新載入的模型拿到 cos_sin_cache=None（例如 TE after_use=drop 後第二次 forward TypeError）。
    evict 後清空這個快取，讓重新載入時重建 RoPE buffer；不改任何數值。``_ROPE_DICT`` 是私有符號：
    載入時先確認它還在（``pins.ROPE_CACHE_ATTRS``），不在就明確失敗，不讓這個修正悄悄失效。
    """
    from phasyn_h3.recipe.runtime.errors import ShimError  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
    from phasyn_h3.recipe.runtime.pins import (  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
        ROPE_CACHE_ATTRS,
        ROPE_CACHE_MODULE,
        check_attrs,
    )

    try:
        factory = importlib.import_module(ROPE_CACHE_MODULE)
    except (
        ImportError
    ) as exc:  # the pinned module moved: a source mismatch, not a runtime crash
        raise ComponentError(
            "UPSTREAM_PATCH_SOURCE_MISMATCH",
            f"SGLang 沒有 {ROPE_CACHE_MODULE}（evict 後清除 RoPE 快取需要它）",
            details={"expected": ROPE_CACHE_MODULE, "actual": type(exc).__name__},
        ) from exc
    try:
        check_attrs(factory, ROPE_CACHE_ATTRS, what="evict 後清除 RoPE 快取")
    except ShimError as exc:
        raise ComponentError(
            exc.reason_code,
            exc.message,
            details={"expected": exc.expected, "actual": exc.actual},
        ) from exc

    def clear() -> None:
        factory._ROPE_DICT.clear()

    return clear


def _parse_diag(diag: Mapping[str, Any]) -> Any:
    try:
        return json.loads(str(diag.get("message") or ""))
    except ValueError:
        return None


class H3Host:
    """One host per component process; owns the SGLangH3Provider (component registry and SGLang process state)."""

    def __init__(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
        self,
        *,
        device: Mapping[str, Any],
        work_dir: Path,
        process_instance_id: str,
        instrumentation: Any = None,
        video_vae_scope: str = "full",
        weight_streaming: Mapping[str, Any] | None = None,
    ) -> None:
        # CUDA_VISIBLE_DEVICES 已由 Node 設成此元件的 GPU UUID；程序內可見 index 為 0
        """Configure the stage backend and its recording callbacks."""
        work_dir.mkdir(parents=True, exist_ok=True)
        from phasyn_h3.recipe.runtime.sglang_env import apply_process_environment  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        apply_process_environment(work_dir / "sglang_h3")
        from phasyn_h3.recipe.runtime.provider import SGLangH3Provider  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        self.device = {"device_uuid": str(device.get("id")), "device_index": 0}
        self.instrumentation = instrumentation
        # orchestration only (which video VAE half is built and read; numerics unchanged, recipe loaders.py)
        self.video_vae_scope = video_vae_scope
        # orchestration only (h3.video_decode provider_options.weight_streaming; same values, recipe
        # stages/vae_weight_streaming.py); None keeps the resident decode
        self.weight_streaming = (
            dict(weight_streaming) if weight_streaming is not None else None
        )
        self.provider = SGLangH3Provider(
            self.device,
            workdir=work_dir,
            actor_instance_id=process_instance_id,
            video_vae_scope=video_vae_scope,
            weight_streaming=self.weight_streaming,
            on_component=self._on_component,
            on_evict=rope_cache_reset(),
        )
        self.work_dir = work_dir

    @contextlib.contextmanager
    def _on_component(self, kind: str, run: Any, module: Any) -> Iterator[None]:
        """Around each use of a component: the DiT of a denoise stage gets the recorder hooks."""
        instr = self.instrumentation
        if (
            instr is None
            or kind != "transformer"
            or getattr(run, "kind", None) != "denoise_av"
        ):
            yield
            return
        from phasyn_h3.recipe.runtime.dit_trace import wrapped_step_profiler  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
        from phasyn_h3.recipe.runtime.pins import LAYERWISE_MANAGER_ATTRS  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        with (
            wrapped_step_profiler(instr.wrap_step_profiler),
            instr.attach(module, manager_attrs=LAYERWISE_MANAGER_ATTRS),
        ):
            yield

    # ------------------------------------------------------------------ stages
    def stage(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
        self,
        kind: str,
        plan: Mapping[str, Any],
        *,
        inputs: Mapping[str, Path],
        attachments: Mapping[str, Path],
        out_dir: Path,
        rec: Recorder,
        cancelled: Any,
        check_cancelled: Callable[[], None] | None = None,
        allocator: Any = None,
        progress: Any = None,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """``options``：stage 的編排選項（例如 encode_references 的 ``reference_scope``），放進 stage dict.

        ``cancelled`` is the recipe's stop signal; ``check_cancelled`` classifies a stop (``reraise_stop``).
        """
        out_dir.mkdir(parents=True, exist_ok=True)
        stage = {**dict(options or {}), "kind": kind, "stage_id": kind, "inputs": []}
        progress_sink = progress or (lambda _doc: None)
        ctx = StageContext(
            assignment={"stage_id": kind, "plan_digest": canonical_digest(dict(plan))},
            plan=plan,
            stage=stage,
            inputs={k: StageInput(k, Path(v), None) for k, v in inputs.items()},
            output_dir=out_dir,
            cancel=_LinkedToken(cancelled),
            progress=progress_sink,
            log=lambda *_a: None,
            device=self.device,
            grant={},
            runtime=self.provider,
            memory_level=0,
            attachments={k: Path(v) for k, v in attachments.items()},
        )
        phase = (
            "load"
            if kind == "load_dit"
            else ("encode" if kind == "decode_video" else None)
        )
        t0 = time.perf_counter_ns()
        with rec.span(f"h3.{kind}", part=f"stage.{kind}", phase=phase):
            try:
                result = self.provider.execute_stage(
                    stage, ctx
                )  # cancellation propagates as Cancelled
            except Cancelled as exc:
                reraise_stop(exc, check_cancelled)
        host_ms = (time.perf_counter_ns() - t0) / 1e6
        self._record_diagnostics(kind, result.diagnostics, rec, allocator)
        if result.status != "succeeded":
            raise self._error(kind, result)
        outputs = {o.name: o for o in result.outputs}
        rec.log(
            "info",
            f"stage {kind} 完成",
            host_ms=round(host_ms, 3),
            outputs=sorted(outputs),
        )
        return outputs

    def _error(self, kind: str, result: Any) -> ComponentError:
        code = str(result.error_code or "RUNTIME_ERROR")
        errors = [
            d for d in result.diagnostics if d.get("severity", "error") == "error"
        ]
        message = (
            "; ".join(str(d.get("message")) for d in errors[:3]) or f"stage {kind} 失敗"
        )
        return ComponentError(
            contract_code(code),
            f"H3 stage {kind} 失敗（{code}）：{message}"[:4000],
            details={
                "stage": kind,
                "runtime_error_code": code,
                "diagnostics": [
                    {
                        k: d.get(k)
                        for k in ("code", "message", "field_paths", "severity")
                    }
                    for d in result.diagnostics[:20]
                ],
            },
        )

    def _record_diagnostics(
        self,
        kind: str,
        diagnostics: list[dict[str, Any]],
        rec: Recorder,
        allocator: Any,
    ) -> None:
        for diag in diagnostics:
            code = str(diag.get("code"))
            if code == "RUNTIME_MEMORY":
                _record_runtime_memory(diag, kind, rec, allocator)
            elif code == "RUNTIME_COST":
                record_cost_entries(rec, _parse_diag(diag))
            elif code == "RUNTIME_COMPUTE":
                doc = _parse_diag(diag) or {}
                seconds = doc.get("compute_seconds")
                if isinstance(seconds, (int, float)):
                    rec.set_metric(
                        f"h3.{kind}.compute_ms",
                        float(seconds) * 1000,
                        unit="ms",
                        scope=f"stage:{kind}",
                        method="host_monotonic_synchronized_boundary",
                    )
                flop = doc.get("analytic_flop")
                if isinstance(flop, (int, float)):
                    rec.set_metric(
                        f"analytic_flops.{kind}",
                        float(flop),
                        unit="FLOP",
                        quality="derived",
                        scope="model_formula",
                        method="cost_model",
                        reason=None,
                    )
                rec.log(
                    "debug",
                    f"{kind} RUNTIME_COMPUTE",
                    compute={k: v for k, v in doc.items() if k != "per_step_seconds"},
                )
            else:
                severity = str(diag.get("severity", "info"))
                level = (
                    "warning"
                    if severity == "warning"
                    else ("error" if severity == "error" else "info")
                )
                message = str(diag.get("message") or "")
                parsed = _parse_diag(diag)
                fields: dict[str, Any] = {"code": code, "stage": kind}
                if isinstance(parsed, dict):
                    fields["fact"] = parsed
                    message = f"{code}"
                rec.log(level, f"{kind}: {message}"[:FACT_LOG_LIMIT], **fields)
                if code in NOTE_CODES:
                    rec.note(f"{kind}：{message}"[:NOTE_LIMIT])

    def end_invoke(self, rec: Recorder) -> dict[str, Any]:
        """Call 結束：gc\N{FULLWIDTH PLUS SIGN}同步\N{FULLWIDTH PLUS SIGN}empty_cache；回傳常駐元件事實（after_use 已套用）."""
        with rec.span("h3.synchronize_stage", part="runtime.release"):
            report = self.provider.synchronize_stage()
        rec.log(
            "info",
            "stage 結束釋放",
            resident=report.get("resident_components"),
            host_cached=report.get("host_cached_components"),
            allocated_bytes=report.get("allocated_bytes"),
            reserved_bytes=report.get("reserved_bytes"),
        )
        return dict(report)

    def warm(
        self, plan: Mapping[str, Any], stage_kind: str, component: str, rec: Recorder
    ) -> None:
        """只載入權重、不跑 stage（load 階段）；after_use 規則照常套用.

        stage 自己驗證的元件以外（encode_references 裡的 audio VAE）用 stage 執行時相同的
        ``component_policy_for`` 解析，載入身分與之後 invoke 取用的完全一致（不會重載）。
        """
        from phasyn_h3.recipe.runtime.policy import (  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
            component_policy_for,
            resolve_stage_policy,
        )
        from phasyn_h3.recipe.runtime.stages.common import StageRun  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        facts = self.provider.backend.facts()
        policy = resolve_stage_policy(
            dict(plan),
            stage_kind,
            memory_level=0,
            adapter_overrides=None,
            sm_major=facts.sm_major,
            sm=facts.sm,
        )
        override = (
            None
            if component in policy.components
            else component_policy_for(policy, component)
        )
        ctx = StageContext(
            assignment={"stage_id": "warm"},
            plan=plan,
            stage={"kind": stage_kind, "stage_id": "warm"},
            inputs={},
            output_dir=self.work_dir / "warm",
            cancel=_LinkedToken(lambda: False),
            progress=lambda _d: None,
            log=lambda *_a: None,
            device=self.device,
            grant={},
            runtime=self.provider,
            memory_level=0,
            attachments={},
        )
        run = StageRun(
            provider=self.provider,
            stage={"kind": stage_kind, "stage_id": "warm"},
            ctx=ctx,
            policy=policy,
        )
        with (
            rec.span(f"h3.warm.{component}", part=component, phase="load"),
            self.provider.use_component(run, component, policy_override=override),
        ):
            pass
        for diag in run.diagnostics:
            rec.log(
                "info",
                f"warm {component}: {diag.get('code')}",
                fact=_parse_diag(diag) or diag.get("message"),
            )

    def shutdown(self) -> None:
        """Release the components and resources owned by this host."""
        with contextlib.suppress(Exception):
            self.provider.shutdown()


__all__ = [
    "ERROR_MAP",
    "H3Host",
    "contract_code",
    "record_cost_entries",
    "reraise_stop",
]


def _record_runtime_memory(
    diag: dict[str, Any], kind: str, rec: Recorder, allocator: Any
) -> None:
    doc = _parse_diag(diag) or {}
    if allocator is not None:
        allocator.merge_peaks(
            doc.get("max_allocated_bytes"), doc.get("max_reserved_bytes")
        )
    if doc.get("max_rss_bytes") is not None:
        rec.max_metric(
            "host_lifetime_peak_bytes",
            int(doc["max_rss_bytes"]),
            quality="instrumented",
            scope="actor_process_lifetime",
            method="getrusage_ru_maxrss",
        )
    if doc.get("pinned_host_bytes") is not None:
        rec.max_metric(
            "owned_pinned_host_bytes",
            int(doc["pinned_host_bytes"]),
            scope="component_owned_payload",
        )
    h2d = int(doc.get("h2d_bytes") or 0)
    if h2d:
        rec.transfer(
            "weight_h2d",
            direction="H2D",
            submitted_bytes=h2d,
            part=f"stage.{kind}",
            byte_basis="logical_tensor",
            src="pinned_host",
            dst="device",
            src_memory_kind="pinned",
            dst_memory_kind="device",
            reason="component offload materialize／host restore（registry 量測）",
        )
    rec.log("debug", f"{kind} RUNTIME_MEMORY", memory=doc)
