"""Bring an installed deployment to "ready" through the Controller's HTTP API (``phasyn-studio up``).

Ready means more than running processes: the controller answers with this installation's id, the Node is online in
its catalog, the pipelines of the plan exist, every component of the routes to make ready is started, and every one of
those routes has all its steps ready. Each wait polls (a Node can register a moment after its process starts); a
component start that is refused with a transient error before anything happened is sent again with back-off, but a
write whose outcome is unknown is never resent: its state is read back instead.

:func:`check` is the read-only counterpart (``phasyn-studio status``): it sends no write at all.

Weights are only downloaded on an explicit request with the licenses accepted, through the Node's own pinned
download (``/weights/download``); AdaLN sidecars are only built on an explicit request with the documented command.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

READ_TIMEOUT = httpx.Timeout(connect=3.0, read=30.0, write=30.0, pool=5.0)
WRITE_TIMEOUT = httpx.Timeout(connect=3.0, read=90.0, write=30.0, pool=5.0)
POLL_S = 2.0
CATALOG_GRACE_S = 20.0  # four catalog intervals of the template Node (catalog_interval_seconds 5)
RETRY_DELAYS_S = (2.0, 4.0, 8.0, 16.0, 30.0, 30.0)
# refused before anything happened: sending the same start again is safe
RETRY_CODES = frozenset({"NODE_UNREACHABLE", "DEVICE_BUSY", "EXCLUSIVE_GROUP_BUSY", "STATE_CONFLICT", "NOT_FOUND"})
USABLE = frozenset({"ready", "busy"})

HINTS: Mapping[str, str] = {
    "COMPONENT_NOT_CONFIGURED": "model files are missing: read the licenses in the plan, then run "
    "`phasyn-studio up --download-weights --accept-licenses` (or put the files in place by hand)",
    "ADALN_SIDECAR_MISSING": "the DiT's AdaLN sidecar is missing: run `phasyn-studio up --build-sidecars` once the "
    "weights are in place (uses the primary GPU for a few minutes)",
    "PROVIDER_NOT_INSTALLED": "the GPU environment is not built: run `phasyn-studio install` again (runtimes step)",
    "EXCLUSIVE_GROUP_CONFLICT": "another DiT is loaded on this Node: pass --replace-dit to replace it while it is idle",
    "EXCLUSIVE_GROUP_BUSY": "another DiT is loading or rendering: wait for it, then run `phasyn-studio up` again",
    "GPU_MEMORY_INSUFFICIENT": "not enough free GPU memory: stop other programs or components on that GPU",
    "HOST_MEMORY_INSUFFICIENT": "not enough free host memory: stop other programs or components on this machine",
    "UPSTREAM_PATCH_SOURCE_MISMATCH": "the GPU environment does not match its lock: run `phasyn-studio install` again",
    "MODEL_INCOMPATIBLE": "a model file differs from the pinned release: download the pinned files again",
    "LOAD_TIMEOUT": "the load took longer than the Node's load_timeout_seconds",
}


class ApiError(Exception):
    """An HTTP answer with an Error body, or a transport failure (``status`` None)."""

    def __init__(self, code: str, message: str, *, status: int | None, outcome_unknown: bool) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.outcome_unknown = outcome_unknown


class Api:
    """A small client for the Controller's API (no proxy from the environment, no redirects, no retries)."""

    def __init__(self, base_url: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url, transport=transport, trust_env=False, follow_redirects=False, timeout=READ_TIMEOUT
        )

    def close(self) -> None:
        self._client.close()

    def request(self, method: str, path: str, body: Any = None) -> Any:
        write = method != "GET"
        try:
            resp = self._client.request(method, path, json=body, timeout=WRITE_TIMEOUT if write else READ_TIMEOUT)
        except httpx.HTTPError as exc:
            sent = not isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout | httpx.PoolTimeout)
            raise ApiError(
                "CONTROLLER_UNREACHABLE",
                f"{method} {path}: {type(exc).__name__}",
                status=None,
                outcome_unknown=write and sent,
            ) from exc
        try:
            doc = resp.json()
        except ValueError:
            doc = None
        if resp.status_code >= 400:
            if isinstance(doc, dict) and isinstance(doc.get("code"), str):
                raise ApiError(
                    doc["code"],
                    str(doc.get("message", "")),
                    status=resp.status_code,
                    outcome_unknown=bool(doc.get("remote_outcome_unknown")),
                )
            raise ApiError("HTTP_ERROR", f"HTTP {resp.status_code}", status=resp.status_code, outcome_unknown=write)
        return doc


@dataclass
class Clock:
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep


@dataclass
class Report:
    status: str = "not_ready"  # ready | not_ready | failed
    controller: dict[str, Any] = field(default_factory=dict)
    node: dict[str, Any] = field(default_factory=dict)
    pipelines: dict[str, str] = field(default_factory=dict)
    weights: dict[str, Any] = field(default_factory=dict)
    sidecars: list[dict[str, Any]] = field(default_factory=list)
    components: dict[str, dict[str, Any]] = field(default_factory=dict)
    routes: dict[str, dict[str, Any]] = field(default_factory=dict)
    next_steps: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "controller": self.controller,
            "node": self.node,
            "pipelines": self.pipelines,
            "weights": self.weights,
            "sidecars": self.sidecars,
            "components": self.components,
            "routes": self.routes,
            "next_steps": list(dict.fromkeys(self.next_steps)),
            "errors": self.errors,
        }


Log = Callable[[str], None]


# ---------------------------------------------------------------------- waits
def wait_controller(api: Api, expected_id: str, timeout_s: float, clock: Clock, log: Log) -> dict[str, Any]:
    deadline = clock.monotonic() + timeout_s
    last = "no answer"
    while True:
        try:
            info = api.request("GET", "/api/controller")
        except ApiError as exc:
            last = exc.message
        else:
            if isinstance(info, dict) and info.get("controller_id") == expected_id:
                return info
            raise ApiError(
                "WRONG_CONTROLLER",
                f"{api.base_url} answers as controller {info.get('controller_id') if isinstance(info, dict) else '?'}, "
                f"not this installation's {expected_id}",
                status=None,
                outcome_unknown=False,
            )
        if clock.monotonic() >= deadline:
            raise ApiError(
                "CONTROLLER_UNREACHABLE",
                f"no controller at {api.base_url} after {timeout_s:g} s ({last})",
                status=None,
                outcome_unknown=False,
            )
        log(f"waiting for the controller at {api.base_url} …")
        clock.sleep(POLL_S)


def catalog(api: Api) -> dict[str, Any]:
    doc = api.request("GET", "/api/catalog?parts=false")
    if not isinstance(doc, dict):
        raise ApiError("BAD_CATALOG", "the catalog is not a JSON object", status=None, outcome_unknown=False)
    return doc


def node_state(doc: Mapping[str, Any], node_id: str) -> str | None:
    for entry in doc.get("directory") or ():
        if entry.get("node_id") == node_id:
            return str(entry.get("state"))
    return None


def components_of(doc: Mapping[str, Any], node_id: str) -> dict[str, dict[str, Any]]:
    for node in doc.get("nodes") or ():
        if node.get("node_id") == node_id:
            return {c["component_id"]: c for c in node.get("components") or ()}
    return {}


def wait_node(api: Api, node_id: str, timeout_s: float, clock: Clock, log: Log) -> dict[str, Any]:
    """Poll the catalog until the Node is online (a Node may register a moment after its process started)."""
    deadline = clock.monotonic() + timeout_s
    while True:
        doc = catalog(api)
        state = node_state(doc, node_id)
        if state == "online" and components_of(doc, node_id):
            return doc
        if state == "duplicate_node_id":
            raise ApiError(
                "DUPLICATE_NODE_ID", f"two Nodes report node_id {node_id}", status=None, outcome_unknown=False
            )
        if clock.monotonic() >= deadline:
            raise ApiError(
                "NODE_NOT_ONLINE",
                f"Node {node_id} is {state or 'not registered'} after {timeout_s:g} s; read its log "
                "(journalctl --user -u phasyn-studio-node@<instance> or the foreground output)",
                status=None,
                outcome_unknown=False,
            )
        log(f"waiting for Node {node_id[:8]} to come online ({state or 'not registered yet'}) …")
        clock.sleep(POLL_S)


# ---------------------------------------------------------------------- pipelines
def ensure_pipelines(api: Api, pipelines: Mapping[str, Mapping[str, Any]], log: Log) -> dict[str, str]:
    """created | present | kept (exists with other content: never overwritten) | unknown | failed: <code>."""
    out: dict[str, str] = {}
    for pid, doc in pipelines.items():
        path = f"/api/pipelines/{quote(pid, safe='')}"
        try:
            current = api.request("GET", path)
        except ApiError as exc:
            if exc.status != 404:
                out[pid] = f"failed: {exc.code}"
                continue
            current = None
        if current is not None:
            out[pid] = "present" if current == doc else "kept"
            continue
        try:
            api.request("PUT", path, doc)
            out[pid] = "created"
            log(f"pipeline {pid} created")
        except ApiError as exc:
            if not exc.outcome_unknown:
                out[pid] = f"failed: {exc.code}"
                continue
            try:  # outcome unknown: read back instead of sending again
                out[pid] = "created" if api.request("GET", path) == doc else "unknown"
            except ApiError:
                out[pid] = "unknown"
    return out


def served_pipelines(api: Api, pipelines: Mapping[str, Mapping[str, Any]]) -> dict[str, Mapping[str, Any] | None]:
    """The controller's saved version of every planned pipeline; None when it is missing or cannot be read (a route
    is then never judged ready from the plan's copy)."""
    out: dict[str, Mapping[str, Any] | None] = {}
    for pid in pipelines:
        try:
            current = api.request("GET", f"/api/pipelines/{quote(pid, safe='')}")
        except ApiError:
            current = None
        out[pid] = current if isinstance(current, dict) and current.get("steps") else None
    return out


# ---------------------------------------------------------------------- weights
def weights_view(api: Api, node_id: str, component_id: str) -> dict[str, Any]:
    doc = api.request("GET", f"/api/nodes/{node_id}/components/{quote(component_id, safe='')}/weights")
    return doc if isinstance(doc, dict) else {}


def weights_status(api: Api, node_id: str, component_ids: Iterable[str]) -> dict[str, Any]:
    """Every pinned weight set the components need, merged by set id, with its license and what is missing."""
    sets: dict[str, dict[str, Any]] = {}
    notes: list[str] = []
    for cid in component_ids:
        try:
            view = weights_view(api, node_id, cid)
        except ApiError as exc:
            notes.append(f"{cid}: {exc.code} {exc.message}")
            continue
        for item in view.get("sets") or ():
            entry = sets.setdefault(
                item["set_id"],
                {
                    "set_id": item["set_id"],
                    "label": item.get("label"),
                    "repo": item.get("repo"),
                    "revision": item.get("revision"),
                    "license": item.get("license"),
                    "bytes_total": item.get("bytes_total"),
                    "bytes_missing": item.get("bytes_missing"),
                    "components": [],
                },
            )
            entry["components"].append(cid)
        notes += [f"{cid}: {note}" for note in view.get("notes") or ()]
    missing = sum(int(s.get("bytes_missing") or 0) for s in sets.values())
    return {"sets": list(sets.values()), "bytes_missing": missing, "notes": list(dict.fromkeys(notes))}


def download_weights(api: Api, node_id: str, status: Mapping[str, Any], clock: Clock, log: Log) -> list[str]:
    """Download every missing set, one at a time (one download per Node); returns errors. Never resent."""
    errors: list[str] = []
    for item in status["sets"]:
        if not item.get("bytes_missing"):
            continue
        cid = item["components"][0]
        path = f"/api/nodes/{node_id}/components/{quote(cid, safe='')}/weights"
        log(f"downloading {item['label']} ({(item['bytes_missing'] or 0) / 1024**3:.1f} GiB) through {cid} …")
        try:
            api.request("POST", f"{path}/download", {"accept_licenses": True, "sets": [item["set_id"]]})
        except ApiError as exc:
            if not exc.outcome_unknown:
                errors.append(f"{item['set_id']}: {exc.code} {exc.message}")
                continue
            log(f"{item['set_id']}: the reply was lost; reading the download state instead of sending it again")
        while True:
            view = api.request("GET", path)
            job = view.get("job") if isinstance(view, dict) else None
            if not job or job.get("state") != "running":
                break
            done, total = job.get("bytes_done") or 0, job.get("bytes_total") or 0
            log(f"  {item['set_id']}: {done / 1024**3:.1f} / {total / 1024**3:.1f} GiB")
            clock.sleep(10.0)
        if job and job.get("state") != "succeeded":
            err = job.get("error") or {}
            errors.append(
                f"{item['set_id']}: download {job.get('state')}: {err.get('code', '')} {err.get('message', '')}"
            )
    return errors


def build_sidecars(sidecars: Sequence[Mapping[str, Any]], log: Log) -> list[str]:
    """Run the documented sidecar commands for the missing ones (GPU work, opt-in); returns errors."""
    errors: list[str] = []
    for item in sidecars:
        if os.path.isfile(item["path"]):
            continue
        log(f"building AdaLN sidecar {item['cache_ref']} (GPU) …")
        env = {**os.environ, **item["env"]}
        # the child's output goes to stderr: stdout carries only the JSON result
        result = subprocess.run(list(item["command"]), env=env, stdout=sys.stderr, stderr=sys.stderr, check=False)
        if result.returncode != 0:
            errors.append(f"sidecar {item['cache_ref']}: exit {result.returncode}")
    return errors


# ---------------------------------------------------------------------- components and routes
def start_component(
    api: Api,
    node_id: str,
    component_id: str,
    *,
    replace_dit: bool,
    load_timeout_s: float,
    clock: Clock,
    log: Log,
) -> dict[str, Any]:
    """Start one component and wait until it is ready; {"state", "error"}. Transient refusals are retried."""
    path = f"/api/nodes/{node_id}/components/{quote(component_id, safe='')}/control"
    current = components_of(catalog(api), node_id).get(component_id)
    if current is None:
        return {"state": "missing", "error": {"code": "NOT_FOUND", "message": "not in the Node's catalog"}}
    stop_deadline = clock.monotonic() + load_timeout_s
    while current.get("state") == "stopping":  # let a stop finish, then start it again
        if clock.monotonic() >= stop_deadline:
            return {"state": "stopping", "error": {"code": "LOAD_TIMEOUT", "message": "still stopping"}}
        clock.sleep(POLL_S)
        current = components_of(catalog(api), node_id).get(component_id) or {}
    if current.get("state") in USABLE:
        return {"state": current["state"], "error": None}
    sent_at: float | None = None
    if current.get("state") != "loading":
        body: dict[str, Any] = {"action": "start"}
        if replace_dit:
            body["replace_exclusive"] = True
        for attempt, delay in enumerate((0.0, *RETRY_DELAYS_S)):
            if delay:
                clock.sleep(delay)
            try:
                reply = api.request("POST", path, body)
                sent_at = clock.monotonic()
                if isinstance(reply, dict) and reply.get("state") in USABLE:
                    return {"state": reply["state"], "error": None}
                break
            except ApiError as exc:
                if exc.outcome_unknown:
                    log(f"{component_id}: the start reply was lost; reading its state instead of sending it again")
                    sent_at = clock.monotonic()
                    break
                if exc.code in RETRY_CODES and attempt < len(RETRY_DELAYS_S):
                    log(f"{component_id}: {exc.code}, trying again in {RETRY_DELAYS_S[attempt]:g} s")
                    continue
                return {"state": current.get("state"), "error": {"code": exc.code, "message": exc.message}}
        log(f"{component_id}: loading …")
    deadline = clock.monotonic() + load_timeout_s
    while True:
        comp = components_of(catalog(api), node_id).get(component_id) or {}
        state = comp.get("state")
        if state in USABLE:
            return {"state": state, "error": None}
        # The catalog is reported every few seconds: right after a start it may still show the old state.
        settled = sent_at is None or clock.monotonic() - sent_at >= CATALOG_GRACE_S
        if state in ("error", "stopped") and settled:
            return {
                "state": state,
                "error": comp.get("last_error") or {"code": "RUNTIME_START_FAILED", "message": state},
            }
        if clock.monotonic() >= deadline:
            return {
                "state": state,
                "error": {"code": "LOAD_TIMEOUT", "message": f"still {state} after {load_timeout_s:g} s"},
            }
        clock.sleep(POLL_S)


def route_status(doc: Mapping[str, Any], pipeline: Mapping[str, Any] | None) -> dict[str, Any]:
    """A route is ready when every step's Node is online and its component is ready or busy (the Studio's rule)."""
    if pipeline is None:
        return {"ready": False, "problems": ["the pipeline is missing on the controller or cannot be read"]}
    problems: list[str] = []
    for step in pipeline.get("steps") or ():
        nid, cid = step.get("node_id"), step.get("component_id")
        if node_state(doc, str(nid)) != "online":
            problems.append(f"{step.get('step_id')}: Node {str(nid)[:8]} is not online")
            continue
        comp = components_of(doc, str(nid)).get(str(cid))
        if comp is None:
            problems.append(f"{step.get('step_id')}: component {cid} not found")
        elif comp.get("state") not in USABLE:
            problems.append(f"{step.get('step_id')}: {cid} is {comp.get('state')}")
    return {"ready": not problems, "problems": problems}


def route_components(pipelines: Mapping[str, Mapping[str, Any] | None], route_ids: Iterable[str]) -> list[str]:
    """The components of these routes, DiTs last (the heaviest load comes after the light ones are up)."""
    ids: list[str] = []
    for pid in route_ids:
        pipeline = pipelines.get(pid)
        for step in pipeline["steps"] if pipeline else ():
            if step["component_id"] not in ids:
                ids.append(step["component_id"])
    return sorted(ids, key=lambda cid: "dit" in cid.split("-"))


def bring_up(
    api: Api,
    plan: Mapping[str, Any],
    pipelines: Mapping[str, Mapping[str, Any]],
    *,
    controller_id: str,
    node_id: str,
    routes: Sequence[str],
    load: bool = True,
    download: bool = False,
    sidecars: bool = False,
    replace_dit: bool = False,
    controller_timeout_s: float = 60.0,
    node_timeout_s: float = 120.0,
    load_timeout_s: float = 2100.0,
    clock: Clock | None = None,
    log: Log = lambda _msg: None,
) -> Report:
    clock = clock or Clock()
    report = Report()
    try:
        report.controller = wait_controller(api, controller_id, controller_timeout_s, clock, log)
        wait_node(api, node_id, node_timeout_s, clock, log)
        report.node = {"node_id": node_id, "state": "online"}
        report.pipelines = ensure_pipelines(api, pipelines, log)
        for pid, state in report.pipelines.items():
            if state.startswith("failed") or state == "unknown":
                message = f"pipeline {pid} could not be created ({state})"
                (report.errors if pid in routes else report.next_steps).append(message)
        served = served_pipelines(api, pipelines)  # an edited pipeline is judged as it is saved
        gpu_components = [c["component_id"] for c in plan["components"]]
        wanted = [cid for cid in route_components(served, routes) if cid in gpu_components]
        report.weights = weights_status(api, node_id, wanted)
        if download and report.weights["bytes_missing"]:
            report.errors += download_weights(api, node_id, report.weights, clock, log)
            report.weights = weights_status(api, node_id, wanted)
        planned_sidecars = [s for s in plan.get("sidecars") or () if s["for_component"] in wanted]
        if sidecars and planned_sidecars and not report.weights["bytes_missing"]:
            report.errors += build_sidecars(planned_sidecars, log)
        report.sidecars = [
            {"cache_ref": s["cache_ref"], "path": s["path"], "present": os.path.isfile(s["path"])}
            for s in planned_sidecars
        ]
        targets = route_components(served, routes)
        if load:
            for cid in targets:
                result = start_component(
                    api, node_id, cid, replace_dit=replace_dit, load_timeout_s=load_timeout_s, clock=clock, log=log
                )
                report.components[cid] = result
                error = result.get("error")
                if error:
                    log(f"{cid}: {error.get('code')} {error.get('message', '')}")
                    hint = HINTS.get(str(error.get("code")))
                    if hint:
                        report.next_steps.append(hint)
        _assess(api, report, served, node_id, targets, routes)
    except ApiError as exc:
        report.status = "failed"
        report.errors.append(f"{exc.code}: {exc.message}")
        return report
    if report.weights.get("bytes_missing") and not download:
        report.next_steps.append(HINTS["COMPONENT_NOT_CONFIGURED"])
    if any(not s["present"] for s in report.sidecars) and not sidecars:
        report.next_steps.append(HINTS["ADALN_SIDECAR_MISSING"])
    if not load:
        report.next_steps.append("components were not started (--no-load): run `phasyn-studio up` to load them")
    _verdict(report, routes)
    return report


def _assess(
    api: Api,
    report: Report,
    served: Mapping[str, Mapping[str, Any] | None],
    node_id: str,
    targets: Sequence[str],
    routes: Sequence[str],
) -> None:
    doc = catalog(api)
    comps = components_of(doc, node_id)
    for cid in targets:
        comp = comps.get(cid) or {}
        error = comp.get("last_error") if comp.get("state") not in USABLE else None
        report.components.setdefault(cid, {"state": comp.get("state"), "error": error})
    for pid, pipeline in served.items():
        report.routes[pid] = {**route_status(doc, pipeline), "target": pid in routes}


def _verdict(report: Report, routes: Sequence[str]) -> None:
    target_ready = bool(routes) and all(report.routes.get(pid, {}).get("ready") for pid in routes)
    report.status = "ready" if (target_ready or not routes) and not report.errors else "not_ready"


def check(
    api: Api,
    plan: Mapping[str, Any],
    pipelines: Mapping[str, Mapping[str, Any]],
    *,
    controller_id: str,
    node_id: str,
    routes: Sequence[str],
) -> Report:
    """Read-only status: GET requests only, nothing is started, created or changed.

    ``status``: ready | not_ready | down (no controller answers) | failed (another installation answers).
    """
    report = Report()
    try:
        info = api.request("GET", "/api/controller")
    except ApiError as exc:
        report.status = "down"
        report.errors.append(f"{exc.code}: {exc.message}")
        report.next_steps.append("the services are not running: `phasyn-studio up` starts them")
        return report
    if not isinstance(info, dict) or info.get("controller_id") != controller_id:
        report.status = "failed"
        report.errors.append(f"WRONG_CONTROLLER: {api.base_url} is another installation's controller")
        return report
    report.controller = info
    try:
        doc = catalog(api)
        state = node_state(doc, node_id)
        report.node = {"node_id": node_id, "state": state or "not_registered"}
        served = served_pipelines(api, pipelines)
        report.pipelines = {
            pid: "missing" if doc_ is None else ("present" if doc_ == pipelines[pid] else "edited")
            for pid, doc_ in served.items()
        }
        gpu_components = [c["component_id"] for c in plan["components"]]
        wanted = [cid for cid in route_components(served, routes) if cid in gpu_components]
        if state == "online":
            report.weights = weights_status(api, node_id, wanted)
        planned = [s for s in plan.get("sidecars") or () if s["for_component"] in wanted]
        report.sidecars = [
            {"cache_ref": s["cache_ref"], "path": s["path"], "present": os.path.isfile(s["path"])} for s in planned
        ]
        _assess(api, report, served, node_id, route_components(served, routes), routes)
    except ApiError as exc:
        report.status = "failed"
        report.errors.append(f"{exc.code}: {exc.message}")
        return report
    if state != "online":
        report.errors.append(f"Node {node_id[:8]} is {state or 'not registered'}")
    if report.weights.get("bytes_missing"):
        report.next_steps.append(HINTS["COMPONENT_NOT_CONFIGURED"])
    if any(not s["present"] for s in report.sidecars):
        report.next_steps.append(HINTS["ADALN_SIDECAR_MISSING"])
    if any(p == "missing" for p in report.pipelines.values()) or any(
        c.get("state") not in USABLE for c in report.components.values()
    ):
        report.next_steps.append("`phasyn-studio up` creates missing pipelines and starts the components")
    _verdict(report, routes)
    return report


__all__ = [
    "HINTS",
    "RETRY_CODES",
    "Api",
    "ApiError",
    "Clock",
    "Report",
    "bring_up",
    "catalog",
    "check",
    "ensure_pipelines",
    "route_components",
    "route_status",
    "start_component",
    "wait_controller",
    "wait_node",
    "weights_status",
]
