"""Component lifecycle: single-flight load, refcounted leases, evidence-backed release.

States: ``absent → loading → resident_idle → in_use → evicting → absent``; any state may
go to ``failed``.  ``host_cached`` holds a component whose device copy was released while its
weights stay in host memory (pinned where the profile allows); acquiring it
restores the device copy (``loading`` again, single-flight) instead of reading
the checkpoint.  The registry is torch-free; the actual load/unload/offload/
restore work is delegated to a :class:`ComponentBackend` (the torch/SGLang
implementation lives in ``loaders``; tests inject a fake).

Rules enforced here:

* one load (or restore) per ``ComponentLoadSpec.single_flight_key`` — concurrent
  acquirers wait for the in-flight one instead of loading twice;
* ``evict``/``offload`` refuse while references are held (active-reference
  eviction is rejected);
* a release reports measured bytes and whether CUDA was synchronized; the
  registry never claims a release the backend did not confirm;
* a failed restore keeps the host copy (state back to ``host_cached``).

Residency reports (``residency_report``, the stage-end ``resident_components`` /
``host_cached_components``) carry ``last_used_at`` (RFC 3339 wall clock of the last
acquire/release, for the scheduler's idle-component LRU) and the host memory a
component holds — also while it is on the device (``host_bytes``/``pinned_bytes``:
the backend's ``host_footprint`` hook when it has one, e.g. layerwise host stores;
``None`` when the backend cannot tell).
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from phasyn_h3.recipe.abi.component import ComponentLease, ComponentLoadSpec
from phasyn_h3.recipe.abi.timeutil import to_rfc3339

from ._observations import RuntimeObservation
from .errors import ComponentBusy, ShimError


ABSENT = "absent"
LOADING = "loading"
RESIDENT_IDLE = "resident_idle"
IN_USE = "in_use"
EVICTING = "evicting"
FAILED = "failed"
HOST_CACHED = "host_cached"

_TRANSITIONS = {
    ABSENT: {LOADING},
    # LOADING -> HOST_CACHED: a restore failed and rolled back to the host copy
    LOADING: {IN_USE, FAILED, ABSENT, HOST_CACHED},
    RESIDENT_IDLE: {IN_USE, EVICTING},
    IN_USE: {IN_USE, RESIDENT_IDLE, FAILED},
    # EVICTING covers both unload (-> ABSENT) and offload to host (-> HOST_CACHED);
    # EVICTING -> RESIDENT_IDLE: an offload was refused before anything moved
    EVICTING: {ABSENT, FAILED, HOST_CACHED, RESIDENT_IDLE},
    FAILED: {LOADING, ABSENT},
    HOST_CACHED: {LOADING, EVICTING},
}


@dataclass
class LoadResult:
    """Report the component loaded into a runtime."""

    handle: Any
    allocated_bytes: int | None
    peak_loading_bytes: int | None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class UnloadResult:
    """Report the result of releasing a resident component."""

    released_bytes: int
    cuda_synchronized: bool
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class OffloadResult:
    """Device copy released, weights kept in host memory."""

    released_bytes: int
    cuda_synchronized: bool
    host_bytes: int
    pinned_bytes: int
    seconds: float
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class RestoreResult:
    """Device copy rebuilt from the host copy (host -> device transfer)."""

    allocated_bytes: int | None
    transferred_bytes: int
    seconds: float
    details: dict[str, Any] = field(default_factory=dict)


class HostMemoryInsufficientError(ShimError):
    """The host cannot hold the component; raised before anything moved."""

    error_code = "RESOURCE_EXHAUSTED"


HostMemoryInsufficientError.__name__ = "HostMemoryInsufficient"
HostMemoryInsufficientError.__qualname__ = "HostMemoryInsufficient"
HostMemoryInsufficient = HostMemoryInsufficientError


class ComponentBackend(Protocol):
    """Define component loading and unloading on a device."""

    def load(self, spec: ComponentLoadSpec) -> LoadResult:
        """Load the component described by the specification."""
        ...

    def unload(self, handle: Any, spec: ComponentLoadSpec) -> UnloadResult:
        """Release the loaded component from its execution device."""
        ...


def component_key_for(spec: ComponentLoadSpec) -> str:
    """Stable, contract-safe key (component-residency.schema.json pattern, <=128)."""
    digest = hashlib.sha256(spec.single_flight_key.encode("utf-8")).hexdigest()[:24]
    base = (
        "".join(ch if ch.isalnum() or ch in "_.-" else "-" for ch in spec.component_id)[
            :90
        ]
        or "component"
    )
    if not base[0].isalnum():
        base = "c" + base
    return f"{base}:{digest}"


def _held_host_bytes(footprint: Any, entry: Any) -> tuple[int, int] | None:
    """(host, pinned) bytes the component holds in host memory: the backend's ``host_footprint(handle)`` hook (``None`` = cannot tell), else the registry's own record (host copy from an offload or a component-offload store)."""
    if not callable(footprint):
        return int(entry.host_bytes), int(entry.pinned_bytes)
    if entry.handle is None:
        return None
    with RuntimeObservation() as telemetry:
        held = footprint(entry.handle)
    if telemetry.error is not None:
        return None
    if not isinstance(held, Mapping):
        return None
    host, pinned = held.get("host_bytes"), held.get("pinned_bytes")
    if (
        not isinstance(host, int)
        or not isinstance(pinned, int)
        or host < 0
        or pinned < 0
    ):
        return None
    return host, pinned


@dataclass
class _Entry:
    key: str
    spec: ComponentLoadSpec
    state: str = ABSENT
    refcount: int = 0
    handle: Any = None
    allocated_bytes: int | None = None  # device bytes while on the device
    peak_loading_bytes: int | None = None
    host_bytes: int = 0
    pinned_bytes: int = 0
    error: str | None = None
    flight_error: str | None = (
        None  # the last load/restore flight failed (waiters raise)
    )
    loaded_at: float | None = None
    last_used_at: float | None = None
    last_used_wall: float | None = (
        None  # time.time() of the last acquire/release (reports)
    )
    load_details: dict[str, Any] = field(default_factory=dict)
    last_transfer: dict[str, Any] = field(default_factory=dict)
    residency: dict[str, Any] = field(default_factory=dict)
    done: threading.Event = field(default_factory=threading.Event)


class ComponentRegistry:
    """Track loaded components and their usage across stages."""

    def __init__(
        self,
        backend: ComponentBackend,
        *,
        actor_instance_id: str,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        on_evict: Callable[[], None] | None = None,
    ):
        """``on_evict`` runs after every :meth:`evict` (also a failed one), e.g. to drop process-wide caches of the evicted model's code (the component host clears SGLang's shared RoPE cache)."""
        self._backend = backend
        self._actor = actor_instance_id
        self._on_evict = on_evict
        self._clock = clock
        self._wall_clock = wall_clock
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}
        self.load_calls = 0  # observable for tests / evidence
        self.restore_calls = 0

    # -- helpers ---------------------------------------------------------
    def _set_state(self, entry: _Entry, new: str) -> None:
        if new not in _TRANSITIONS[entry.state]:
            raise ShimError(
                "ILLEGAL_COMPONENT_TRANSITION",
                f"{entry.key}: {entry.state} → {new} 不合法",
                error_code="INTERNAL",
            )
        entry.state = new

    def _lease(self, entry: _Entry) -> ComponentLease:
        return ComponentLease(
            component_key=entry.key,
            spec=entry.spec,
            actor_instance_id=self._actor,
            state=entry.state,
            reference_count=entry.refcount,
            allocated_bytes=entry.allocated_bytes,
            peak_loading_bytes=entry.peak_loading_bytes,
            handle=entry.handle,
        )

    # -- public API ------------------------------------------------------
    def acquire(
        self,
        spec: ComponentLoadSpec,
        *,
        timeout_s: float | None = None,
        residency: Mapping[str, Any] | None = None,
    ) -> ComponentLease:
        """Take a reference; loads (absent) or restores (host_cached) single-flight.

        ``residency`` is the between-use policy of the requesting stage
        (``ResidencyPolicy.as_dict``); the latest one is what reports carry.
        """
        key = component_key_for(spec)
        while True:
            with self._lock:
                entry = _acquire_entry(self, key, spec, residency)
                if entry.state in (RESIDENT_IDLE, IN_USE):
                    self._set_state(entry, IN_USE)
                    entry.refcount += 1
                    entry.last_used_at = self._clock()
                    entry.last_used_wall = self._wall_clock()
                    entry.last_transfer = {}
                    return self._lease(entry)
                if entry.state == EVICTING:
                    raise ComponentBusy(
                        "COMPONENT_EVICTING", f"{key} 正在釋放，請稍後重試"
                    )
                flight: str | None = None
                if entry.state in (ABSENT, FAILED, HOST_CACHED):
                    flight = "restore" if entry.state == HOST_CACHED else "load"
                    self._set_state(entry, LOADING)
                    entry.error = None
                    entry.flight_error = None
                    entry.done = threading.Event()
                    waiter = None
                else:  # LOADING by someone else: single-flight wait
                    waiter = entry.done
            if flight == "load":
                return self._do_load(entry)
            if flight == "restore":
                return self._do_restore(entry)
            _await_load(waiter, timeout_s, key, self, entry)
            # loop: resident now -> take a reference

    def _do_load(self, entry: _Entry) -> ComponentLease:
        self.load_calls += 1
        try:
            result = self._backend.load(entry.spec)
        except BaseException as exc:  # includes OOM; the stage classifies
            with self._lock:
                entry.state = FAILED
                entry.error = entry.flight_error = f"{type(exc).__name__}: {exc}"[:2000]
                entry.handle = None
                entry.done.set()
            raise
        with self._lock:
            entry.handle = result.handle
            entry.allocated_bytes = result.allocated_bytes
            entry.peak_loading_bytes = result.peak_loading_bytes
            entry.load_details = dict(result.details)
            entry.last_transfer = {
                "kind": "load",
                **dict(result.details.get("transfer") or {}),
            }
            host = result.details.get("host_store") or {}
            entry.host_bytes = int(host.get("host_bytes") or 0)
            entry.pinned_bytes = int(host.get("pinned_bytes") or 0)
            entry.loaded_at = self._clock()
            entry.last_used_at = entry.loaded_at
            entry.last_used_wall = self._wall_clock()
            self._set_state(entry, IN_USE)
            entry.refcount += 1
            entry.done.set()
            return self._lease(entry)

    def _do_restore(self, entry: _Entry) -> ComponentLease:
        self.restore_calls += 1
        restore = getattr(self._backend, "restore", None)
        try:
            result = _restore_component(restore, entry)
        except BaseException as exc:
            with self._lock:
                # the backend rolled back: the host copy is still the truth
                entry.state = HOST_CACHED
                entry.error = entry.flight_error = (
                    f"restore: {type(exc).__name__}: {exc}"[:2000]
                )
                entry.done.set()
            raise
        with self._lock:
            entry.allocated_bytes = result.allocated_bytes
            entry.last_transfer = {
                "kind": "restore",
                "transferred_bytes": int(result.transferred_bytes),
                "seconds": round(float(result.seconds), 6),
                **dict(result.details),
            }
            entry.last_used_at = self._clock()
            entry.last_used_wall = self._wall_clock()
            self._set_state(entry, IN_USE)
            entry.refcount += 1
            entry.done.set()
            return self._lease(entry)

    def release_reference(self, component_key: str) -> int:
        """Drop one stage reference; returns the remaining refcount."""
        with self._lock:
            entry = self._entries.get(component_key)
            if entry is None or entry.state != IN_USE or entry.refcount <= 0:
                raise ShimError(
                    "COMPONENT_NOT_IN_USE",
                    f"{component_key} 沒有可釋放的引用",
                    error_code="STATE_CONFLICT",
                )
            entry.refcount -= 1
            entry.last_used_wall = self._wall_clock()  # end of this use
            if entry.refcount == 0:
                self._set_state(entry, RESIDENT_IDLE)
            return entry.refcount

    def offload(self, component_key: str) -> dict[str, Any]:
        """Release the device copy of an idle component; weights stay in host memory.

        Raises :class:`HostMemoryInsufficient` (state unchanged) when the backend
        refuses before moving anything; the caller then decides to evict.
        """
        with self._lock:
            entry = self._entries.get(component_key)
            if entry is None or entry.state == ABSENT:
                return {
                    "component_key": component_key,
                    "state": ABSENT,
                    "released_bytes": 0,
                    "note": "not resident",
                }
            if entry.state == HOST_CACHED:
                return {
                    "component_key": component_key,
                    "state": HOST_CACHED,
                    "released_bytes": 0,
                    "cuda_synchronized": False,
                    "note": "already host cached",
                }
            if entry.refcount > 0 or entry.state in (IN_USE, LOADING):
                raise ComponentBusy(
                    "ACTIVE_REFERENCE_EVICTION",
                    f"{component_key} 仍有 {entry.refcount} 個引用（state={entry.state}），拒絕 offload",
                )
            if entry.state == FAILED:
                raise ShimError(
                    "COMPONENT_FAILED",
                    f"{component_key} 處於 failed，只能 evict",
                    error_code="STATE_CONFLICT",
                )
            self._set_state(entry, EVICTING)
            handle, spec = entry.handle, entry.spec
        offload = getattr(self._backend, "offload", None)
        try:
            result = _offload_component(offload, handle, spec)
        except HostMemoryInsufficient:
            with self._lock:
                self._set_state(entry, RESIDENT_IDLE)
            raise
        except BaseException as exc:
            with self._lock:
                entry.state = FAILED
                entry.error = f"offload: {type(exc).__name__}: {exc}"[:2000]
            raise
        with self._lock:
            entry.allocated_bytes = 0
            entry.host_bytes = int(result.host_bytes)
            entry.pinned_bytes = int(result.pinned_bytes)
            entry.last_transfer = {
                "kind": "offload",
                "seconds": round(float(result.seconds), 6),
                **result.details,
            }
            self._set_state(entry, HOST_CACHED)
        return {
            "component_key": component_key,
            "released_bytes": int(result.released_bytes),
            "cuda_synchronized": bool(result.cuda_synchronized),
            "evidence": "synchronized_unload",
            "state": HOST_CACHED,
            "host_bytes": int(result.host_bytes),
            "pinned_bytes": int(result.pinned_bytes),
            "seconds": round(float(result.seconds), 6),
            **({"details": result.details} if result.details else {}),
        }

    def evict(self, component_key: str) -> dict[str, Any]:
        """Unload a resident or host-cached component with no references (release evidence)."""
        try:
            return self._evict(component_key)
        finally:
            if self._on_evict is not None:
                self._on_evict()

    def _evict(self, component_key: str) -> dict[str, Any]:
        with self._lock:
            entry = self._entries.get(component_key)
            if entry is None or entry.state == ABSENT:
                return {
                    "component_key": component_key,
                    "released_bytes": 0,
                    "cuda_synchronized": False,
                    "evidence": "synchronized_unload",
                    "state": ABSENT,
                    "note": "not resident",
                }
            if entry.refcount > 0 or entry.state in (IN_USE, LOADING):
                raise ComponentBusy(
                    "ACTIVE_REFERENCE_EVICTION",
                    f"{component_key} 仍有 {entry.refcount} 個引用（state={entry.state}），拒絕 evict",
                )
            if entry.state == FAILED:
                entry.state = ABSENT
                self._entries.pop(component_key, None)
                return {
                    "component_key": component_key,
                    "released_bytes": 0,
                    "cuda_synchronized": False,
                    "evidence": "synchronized_unload",
                    "state": ABSENT,
                    "note": "failed load cleared",
                }
            self._set_state(entry, EVICTING)
            handle, spec = entry.handle, entry.spec
        try:
            result = self._backend.unload(handle, spec)
        except BaseException as exc:
            with self._lock:
                entry.state = FAILED
                entry.error = f"unload: {type(exc).__name__}: {exc}"[:2000]
            raise
        with self._lock:
            entry.handle = None
            self._set_state(entry, ABSENT)
            self._entries.pop(component_key, None)
        return {
            "component_key": component_key,
            "released_bytes": int(result.released_bytes),
            "cuda_synchronized": bool(result.cuda_synchronized),
            "evidence": "synchronized_unload",
            "state": ABSENT,
            **({"details": result.details} if result.details else {}),
        }

    def get(self, component_key: str) -> ComponentLease | None:
        """Look up the component registered under the supplied key."""
        with self._lock:
            entry = self._entries.get(component_key)
            return None if entry is None else self._lease(entry)

    def entry_facts(self, component_key: str) -> dict[str, Any]:
        """Last transfer / host-copy facts of one component (stage diagnostics)."""
        with self._lock:
            entry = self._entries.get(component_key)
            if entry is None:
                return {"component_key": component_key, "state": ABSENT}
            return {
                "component_key": entry.key,
                "state": entry.state,
                "allocated_bytes": entry.allocated_bytes,
                "host_bytes": entry.host_bytes,
                "pinned_bytes": entry.pinned_bytes,
                "last_transfer": dict(entry.last_transfer),
            }

    def snapshot(self) -> list[dict[str, Any]]:
        """Snapshot the current component residency state."""
        with self._lock:
            return [
                {
                    "component_key": e.key,
                    "component_id": e.spec.component_id,
                    "model_id": e.spec.model_id,
                    "model_revision": e.spec.model_revision,
                    "state": e.state,
                    "reference_count": e.refcount,
                    "observed_allocated_bytes": e.allocated_bytes,
                    "host_bytes": e.host_bytes,
                    "pinned_bytes": e.pinned_bytes,
                    "weight_format": e.spec.weight_format,
                    "compute_dtype": e.spec.compute_dtype,
                    "offload": e.spec.offload,
                    "residency": dict(e.residency),
                }
                for e in sorted(self._entries.values(), key=lambda x: x.key)
            ]

    def residency_report(
        self, *, exclude_kinds: tuple[str, ...] = ()
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """(device-resident, host-cached) components for stage-end release evidence.

        Device entries feed ``resident_components``; host entries hold no device memory.  CPU-only
        objects (processor/tokenizer) are excluded by the caller.  Both carry
        ``last_used_at``; device entries also the host memory they still hold
        (``host_bytes``/``pinned_bytes``, ``None`` = unknown).
        """
        device: list[dict[str, Any]] = []
        host: list[dict[str, Any]] = []
        footprint = getattr(self._backend, "host_footprint", None)
        with self._lock:
            for e in sorted(self._entries.values(), key=lambda x: x.key):
                if e.spec.kind in exclude_kinds:
                    continue
                doc: dict[str, Any] = {
                    "component_key": e.key,
                    "component_id": e.spec.component_id,
                    "model_id": e.spec.model_id,
                    "model_revision": e.spec.model_revision,
                    "kind": e.spec.kind,
                    "state": e.state,
                    "reference_count": e.refcount,
                    "weight_format": e.spec.weight_format,
                    "compute_dtype": e.spec.compute_dtype,
                    "offload": e.spec.offload,
                    "after_use": e.residency.get("after_use"),
                }
                if "idle_unload_seconds" in e.residency:
                    doc["idle_unload_seconds"] = e.residency["idle_unload_seconds"]
                doc["last_used_at"] = (
                    None
                    if e.last_used_wall is None
                    else to_rfc3339(datetime.fromtimestamp(e.last_used_wall, UTC))
                )
                if e.state not in (RESIDENT_IDLE, IN_USE, HOST_CACHED):
                    continue
                held = _held_host_bytes(footprint, e)
                if e.state == HOST_CACHED:
                    # never None here: the report counts a host entry by these bytes
                    host_bytes, pinned_bytes = (
                        held if held is not None else (e.host_bytes, e.pinned_bytes)
                    )
                    host.append(
                        {**doc, "host_bytes": host_bytes, "pinned_bytes": pinned_bytes}
                    )
                else:
                    device.append(
                        {
                            **doc,
                            "allocated_bytes": int(e.allocated_bytes or 0),
                            "host_bytes": None if held is None else held[0],
                            "pinned_bytes": None if held is None else held[1],
                        }
                    )
        return device, host

    def keys(self) -> list[str]:
        """Return the keys of registered components."""
        with self._lock:
            return sorted(self._entries)

    def held_host_bytes(self) -> tuple[int, int]:
        """(host, pinned) bytes all components hold in host memory now (known parts only)."""
        footprint = getattr(self._backend, "host_footprint", None)
        host = pinned = 0
        with self._lock:
            for e in self._entries.values():
                if e.state not in (RESIDENT_IDLE, IN_USE, HOST_CACHED):
                    continue
                held = _held_host_bytes(footprint, e)
                if held is None and e.state == HOST_CACHED:
                    held = (e.host_bytes, e.pinned_bytes)
                if held is not None:
                    host += held[0]
                    pinned += held[1]
        return host, pinned

    def siblings(self, spec: ComponentLoadSpec) -> list[str]:
        """Idle entries of the same component under another runtime identity."""
        key = component_key_for(spec)
        with self._lock:
            return sorted(
                e.key
                for e in self._entries.values()
                if e.key != key
                and e.spec.component_id == spec.component_id
                and e.spec.model_revision == spec.model_revision
                and e.refcount == 0
                and e.state in (RESIDENT_IDLE, HOST_CACHED, FAILED)
            )

    def evict_all(self) -> list[dict[str, Any]]:
        """Shutdown path: force references to zero, then unload everything."""
        reports = []
        for key in self.keys():
            with self._lock:
                entry = self._entries.get(key)
                if entry is None:
                    continue
                if entry.state == IN_USE:
                    entry.refcount = 0
                    entry.state = RESIDENT_IDLE
                if entry.state == LOADING:
                    continue
            with RuntimeObservation() as eviction:
                reports.append(self.evict(key))
            if (exc := eviction.error) is not None:
                reports.append({"component_key": key, "error": str(exc)[:500]})
        return reports


__all__ = [
    "ABSENT",
    "EVICTING",
    "FAILED",
    "HOST_CACHED",
    "IN_USE",
    "LOADING",
    "RESIDENT_IDLE",
    "ComponentBackend",
    "ComponentRegistry",
    "HostMemoryInsufficient",
    "LoadResult",
    "OffloadResult",
    "RestoreResult",
    "UnloadResult",
    "component_key_for",
]


def _acquire_entry(
    self: ComponentRegistry,
    key: Any,
    spec: ComponentLoadSpec,
    residency: Mapping[str, Any] | None,
) -> Any:
    entry = self._entries.get(key)
    if entry is None:
        entry = _Entry(key=key, spec=spec)
        self._entries[key] = entry
    if residency is not None:
        entry.residency = dict(residency)
    return entry


def _await_load(
    waiter: Any, timeout_s: float | None, key: Any, self: ComponentRegistry, entry: Any
) -> None:
    if waiter is None:
        raise RuntimeError("waiter is unavailable in this stage")
    if not waiter.wait(timeout_s):
        raise ShimError(
            "COMPONENT_LOAD_TIMEOUT",
            f"等待 {key} 載入逾時",
            error_code="WORKER_UNAVAILABLE",
        )
    with self._lock:
        if entry.flight_error is not None or entry.state == FAILED:
            raise ShimError(
                "COMPONENT_LOAD_FAILED",
                f"{key} 載入失敗：{entry.flight_error or entry.error}",
                error_code="MODEL_ERROR",
            )


def _restore_component(restore: Any, entry: _Entry) -> RestoreResult:
    if not callable(restore):
        raise ShimError(
            "RESTORE_NOT_SUPPORTED",
            "component backend 沒有 restore",
            error_code="INTERNAL",
        )
    result: RestoreResult = restore(entry.handle, entry.spec)
    return result


def _offload_component(offload: Any, handle: Any, spec: Any) -> OffloadResult:
    if not callable(offload):
        raise HostMemoryInsufficient(
            "OFFLOAD_NOT_SUPPORTED", "component backend 沒有 host offload"
        )
    result: OffloadResult = offload(handle, spec)
    return result
