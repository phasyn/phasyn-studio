"""Opt-in, single-request DiT activity trace; never changes model inputs."""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import importlib.metadata
import json
import os
import resource
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

_ACTIVE: contextvars.ContextVar[Any] = contextvars.ContextVar("phasyn_dit_trace", default=None)
# the component host's step instrumentation (wraps the trace's own step profiler for one use of the DiT)
_STEP_WRAPPER: contextvars.ContextVar[Callable[[Callable[[], Any]], Callable[[], Any]] | None] = contextvars.ContextVar(
    "phasyn_dit_step_wrapper", default=None
)


def _snapshot() -> dict[str, Any]:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    try:
        io = {
            key: int(value)
            for key, value in (line.split(":", 1) for line in Path("/proc/self/io").read_text().splitlines())
        }
    except (OSError, ValueError):
        io = None
    return {
        "monotonic_ns": time.perf_counter_ns(),
        "unix_ns": time.time_ns(),
        "process_cpu_ns": time.process_time_ns(),
        "thread_cpu_ns": time.thread_time_ns(),
        "minor_faults": usage.ru_minflt,
        "major_faults": usage.ru_majflt,
        "process_io": io,
    }


def _safe_snapshot() -> dict[str, Any]:
    try:
        return _snapshot()
    except Exception as exc:
        return {"snapshot_error": f"{type(exc).__name__}: {exc}"}


def scope(name: str) -> Any:
    active = _ACTIVE.get()
    return contextlib.nullcontext() if active is None else active.scope(name)


def step_scope(step: int) -> Any:
    return scope(f"step/{step}")


def _trace_step_profiler() -> Any:
    return step_scope if _ACTIVE.get() is not None else None


def step_profiler() -> Any:
    """The denoise loop's per-step profiler: the trace's (when one is active), wrapped by the host's
    instrumentation inside :func:`wrapped_step_profiler`; ``None`` when neither is active."""
    wrapper = _STEP_WRAPPER.get()
    return _trace_step_profiler() if wrapper is None else wrapper(_trace_step_profiler)()


@contextlib.contextmanager
def wrapped_step_profiler(wrapper: Callable[[Callable[[], Any]], Callable[[], Any]]) -> Iterator[None]:
    """Let ``wrapper`` wrap the step profiler for this context (the host's DiT instrumentation)."""
    token = _STEP_WRAPPER.set(wrapper)
    try:
        yield
    finally:
        _STEP_WRAPPER.reset(token)


class _Trace:
    def __init__(self, record_function: Any) -> None:
        self.record_function = record_function
        self.host_events: list[dict[str, Any]] = []
        self.errors: list[str] = []

    @contextlib.contextmanager
    def scope(self, name: str) -> Any:
        marker = None
        start = cpu_start = None
        try:
            start = time.perf_counter_ns()
            cpu_start = time.thread_time_ns()
            candidate = self.record_function(f"phasyn.dit.{name}")
            candidate.__enter__()
            marker = candidate
        except Exception as exc:
            self.errors.append(f"{name} enter: {type(exc).__name__}: {exc}")
        try:
            yield
        finally:
            # Do not let observer failures replace a model exception or suppress it.
            if marker is not None:
                try:
                    marker.__exit__(*sys.exc_info())
                except Exception as exc:
                    self.errors.append(f"{name} exit: {type(exc).__name__}: {exc}")
            try:
                if start is not None and cpu_start is not None:
                    self.host_events.append(
                        {
                            "name": name,
                            "clock_domain": "host_perf_counter_ns",
                            "start_ns": start,
                            "end_ns": time.perf_counter_ns(),
                            "thread_cpu_ns": time.thread_time_ns() - cpu_start,
                            "classification": "mixed_host_envelope",
                            "bytes": None,
                        }
                    )
            except Exception as exc:
                self.errors.append(f"{name} clock: {type(exc).__name__}: {exc}")


def _disable_after_stop_error(status: dict[str, Any]) -> None:
    # Pinned torch stops after CUDA synchronize. If that raises first, disable
    # Kineto without retrying the failed device sync, then require actor retirement.
    status["actor_restart_required"] = True
    try:
        from torch.autograd import _disable_profiler

        _disable_profiler()
        status["emergency_profiler_disable"] = "completed"
    except Exception as exc:
        status["emergency_profiler_disable_error"] = f"{type(exc).__name__}: {exc}"


def run_stage(run: Any, execute: Any) -> Any:
    requested = run.plan.get("requested") or {}
    selector = os.environ.get("PHASYN_H3_DIT_TRACE_REQUEST_ID")
    directory = os.environ.get("PHASYN_H3_DIT_TRACE_DIR")
    if not selector or not directory or selector != requested.get("client_request_id"):
        return execute(run)

    profiler = None
    token = None
    trace = None
    target = None
    status: dict[str, Any] = {
        "schema_version": "phasyn.dit_activity_trace.v1",
        "job_id": str(run.ctx.assignment.get("job_id", "")),
        "attempt_id": str(run.ctx.assignment.get("attempt_id", "")),
        "client_request_id": selector,
        "plan_digest": run.plan_digest(),
        "pid": os.getpid(),
        "device": str(run.provider.torch_device()),
        "geometry": dict(run.geometry),
        "observer_enabled": True,
        "profiler_settings": {
            "activities": ["CPU", "CUDA"],
            "record_shapes": False,
            "profile_memory": False,
            "with_stack": False,
            "with_flops": False,
            "profile_all_threads": True,
            "enable_cuda_sync_events": True,
            "trace_only": True,
            "performance_events": [],
        },
        "pure_kernel_seconds": None,
        "cache_state": "see_run_load_metrics_and_actor_identity",
        "limitations": [
            "Profiler overhead is present and has no matched unprofiled control in this run.",
            "Host and CUDA-event elapsed scopes include waits; neither is pure kernel time.",
            "GPU interval analysis requires actual kernel and memcpy events in the exported trace.",
            "Process read_bytes is not disk service time; page-cache reads may report zero.",
        ],
    }
    try:
        root = Path(directory)
        if not root.is_absolute():
            raise ValueError("trace directory must be absolute")
        root.mkdir(parents=True, exist_ok=True)
        # Request ID is matched against configuration and hashed, never used as a path.
        key = hashlib.sha256(selector.encode()).hexdigest()[:24]
        candidate = root / key
        candidate.mkdir(exist_ok=False)  # at most one attempt per selected request
        target = candidate
        from torch._C._profiler import _ExperimentalConfig
        from torch.profiler import ProfilerActivity, profile, record_function

        status["torch_version"] = importlib.metadata.version("torch")
        for distribution in ("nvidia-cuda-cupti", "nvidia-cuda-cupti-cu13"):
            try:
                status["cupti_version"] = importlib.metadata.version(distribution)
                break
            except importlib.metadata.PackageNotFoundError:
                pass
        profiler = profile(
            activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
            record_shapes=False,
            profile_memory=False,
            with_stack=False,
            with_flops=False,
            with_modules=False,
            experimental_config=_ExperimentalConfig(
                performance_events=[],
                enable_cuda_sync_events=True,
                profile_all_threads=True,
                disable_external_correlation=False,
                trace_only=True,
            ),
        )
        observer_start = time.perf_counter_ns()
        profiler.start()
        status["observer_start_ns"] = time.perf_counter_ns() - observer_start
        trace = _Trace(record_function)
        token = _ACTIVE.set(trace)
        status["before"] = _safe_snapshot()
    except Exception as exc:
        status["capture_setup_error"] = f"{type(exc).__name__}: {exc}"
        if profiler is not None:
            try:
                profiler.stop()
            except Exception:
                _disable_after_stop_error(status)
        profiler = None
        run.warn("DIT_TRACE_UNAVAILABLE", status["capture_setup_error"])

    result = None
    diagnostics_before_finish = None
    try:
        with scope("stage"):
            result = execute(run)
        diagnostics_before_finish = len(run.diagnostics)
    finally:
        if token is not None:
            _ACTIVE.reset(token)
        status["after"] = _safe_snapshot()
        if trace is not None:
            status["host_events"] = trace.host_events
            status["observer_range_errors"] = trace.errors
            if trace.errors:
                run.warn("DIT_TRACE_RANGE_INCOMPLETE", "; ".join(trace.errors[:4]))
        if profiler is not None and target is not None:  # the profiler starts only after the target exists
            try:
                observer_stop = time.perf_counter_ns()
                try:
                    profiler.stop()
                except Exception:
                    _disable_after_stop_error(status)
                    raise
                status["observer_stop_ns"] = time.perf_counter_ns() - observer_stop
                export_start = time.perf_counter_ns()
                profiler.export_chrome_trace(str(target / "trace.json"))
                status["observer_export_ns"] = time.perf_counter_ns() - export_start
                status["trace_size_bytes"] = (target / "trace.json").stat().st_size
                status["capture_exported"] = True
            except Exception as exc:
                status["capture_finish_error"] = f"{type(exc).__name__}: {exc}"
                run.warn("DIT_TRACE_INCOMPLETE", status["capture_finish_error"])
        if target is not None:
            try:
                (target / "metadata.json").write_text(json.dumps(status, indent=2) + "\n")
            except OSError as exc:
                run.warn("DIT_TRACE_METADATA_UNAVAILABLE", str(exc))

    if result is not None and diagnostics_before_finish is not None:
        result.diagnostics.extend(run.diagnostics[diagnostics_before_finish:])
    return result
