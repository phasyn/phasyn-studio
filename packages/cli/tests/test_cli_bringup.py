"""``phasyn-studio up``: ready means Node online, components started and routes ready; writes are never resent when
their outcome is unknown, and an edited pipeline is never overwritten. A fake controller (httpx.MockTransport)
stands in for the services; nothing real is started.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from phasyn_cli import bringup
from phasyn_components.testing.ids import CONTROLLER_ID, NODE_A_ID

PIPELINE = {
    "pipeline_id": "t2va-local",
    "label": "t2va",
    "inputs": [],
    "steps": [
        {"step_id": "te", "node_id": NODE_A_ID, "component_id": "te-gpu0", "inputs": {}},
        {"step_id": "dit", "node_id": NODE_A_ID, "component_id": "dit-fl2va-fp8-pai8", "inputs": {}},
        {"step_id": "mux", "node_id": NODE_A_ID, "component_id": "mux", "inputs": {}},
    ],
    "outputs": {},
}
PLAN = {"components": [{"component_id": "te-gpu0"}, {"component_id": "dit-fl2va-fp8-pai8"}], "sidecars": []}


class FakeController:
    """Node registers after ``late_polls`` catalog reads; starts answer from ``start_replies`` first."""

    def __init__(
        self, *, late_polls: int = 0, start_replies: dict[str, list[tuple[int, dict[str, Any]]]] | None = None
    ) -> None:
        self.late_polls = late_polls
        self.start_replies = start_replies or {}
        self.states = {"te-gpu0": "stopped", "dit-fl2va-fp8-pai8": "stopped", "mux": "ready"}
        self.errors: dict[str, dict[str, Any] | None] = {}
        self.pipelines: dict[str, Any] = {}
        self.posts: list[str] = []
        self.puts: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/controller":
            return httpx.Response(200, json={"controller_id": CONTROLLER_ID, "protocol_version": "4.0"})
        if path == "/api/catalog":
            if self.late_polls > 0:
                self.late_polls -= 1
                return httpx.Response(200, json={"nodes": [], "directory": [], "observed_at": "x"})
            comps = [
                {"component_id": cid, "state": state, "last_error": self.errors.get(cid)}
                for cid, state in self.states.items()
            ]
            return httpx.Response(
                200,
                json={
                    "nodes": [{"node_id": NODE_A_ID, "components": comps}],
                    "directory": [{"node_id": NODE_A_ID, "state": "online"}],
                    "observed_at": "x",
                },
            )
        if path.startswith("/api/pipelines/"):
            pid = path.rsplit("/", 1)[1]
            if request.method == "PUT":
                self.puts.append(pid)
                self.pipelines[pid] = json.loads(request.content)
                return httpx.Response(200, json=self.pipelines[pid])
            if pid in self.pipelines:
                return httpx.Response(200, json=self.pipelines[pid])
            return httpx.Response(404, json={"code": "NOT_FOUND", "message": "no pipeline"})
        if path.endswith("/weights"):
            return httpx.Response(200, json={"sets": [], "notes": [], "job": None})
        if path.endswith("/control"):
            cid = path.split("/")[-2]
            self.posts.append(cid)
            queued = self.start_replies.get(cid)
            if queued:
                status, body = queued.pop(0)
                if status >= 400:
                    if body.get("remote_outcome_unknown"):
                        self.states[cid] = "ready"  # it did start; only the reply was lost
                    return httpx.Response(status, json=body)
            self.states[cid] = "ready"
            return httpx.Response(200, json={"component_id": cid, "state": "loading"})
        return httpx.Response(404, json={"code": "NOT_FOUND", "message": path})


class FakeClock(bringup.Clock):
    def __init__(self) -> None:
        self.now = 0.0
        super().__init__(monotonic=lambda: self.now, sleep=self._sleep)

    def _sleep(self, seconds: float) -> None:
        self.now += seconds


def run(fake: FakeController, **kwargs: Any) -> bringup.Report:
    api = bringup.Api("http://127.0.0.1:8080", transport=httpx.MockTransport(fake.handle))
    return bringup.bring_up(
        api,
        PLAN,
        {"t2va-local": PIPELINE},
        controller_id=CONTROLLER_ID,
        node_id=NODE_A_ID,
        routes=["t2va-local"],
        clock=FakeClock(),
        **kwargs,
    )


def test_a_late_node_and_a_transient_refusal_still_end_ready() -> None:
    unreachable = {"code": "NODE_UNREACHABLE", "message": "offline; not sent", "remote_outcome_unknown": False}
    fake = FakeController(late_polls=3, start_replies={"te-gpu0": [(503, unreachable)]})
    report = run(fake)
    assert report.status == "ready", report.to_dict()
    assert report.routes["t2va-local"]["ready"] and fake.puts == ["t2va-local"]
    assert fake.posts.count("te-gpu0") == 2  # refused before anything happened: sent again after a back-off
    assert fake.posts.index("dit-fl2va-fp8-pai8") > fake.posts.index("te-gpu0")  # the DiT loads last


def test_a_start_with_an_unknown_outcome_is_read_back_not_resent() -> None:
    lost = {"code": "NODE_UNREACHABLE", "message": "reply lost", "remote_outcome_unknown": True}
    fake = FakeController(start_replies={"dit-fl2va-fp8-pai8": [(503, lost)]})
    report = run(fake)
    assert fake.posts.count("dit-fl2va-fp8-pai8") == 1
    assert report.status == "ready"


def test_missing_weights_end_not_ready_with_the_next_step_and_an_edited_pipeline_is_kept() -> None:
    refused = {"code": "COMPONENT_NOT_CONFIGURED", "message": "MiniMax-H3/FL2VA/transformer missing"}
    fake = FakeController(start_replies={"dit-fl2va-fp8-pai8": [(409, refused)]})
    fake.pipelines["t2va-local"] = {**PIPELINE, "label": "edited by the user"}
    report = run(fake)
    assert report.status == "not_ready" and not report.routes["t2va-local"]["ready"]
    assert report.pipelines == {"t2va-local": "kept"} and fake.puts == []
    assert report.components["dit-fl2va-fp8-pai8"]["error"]["code"] == "COMPONENT_NOT_CONFIGURED"
    assert any("--download-weights --accept-licenses" in step for step in report.to_dict()["next_steps"])
    assert fake.posts.count("dit-fl2va-fp8-pai8") == 1  # a definite refusal is not retried


def test_a_node_that_never_registers_fails_with_a_clear_error() -> None:
    report = run(FakeController(late_polls=10**6), node_timeout_s=10.0)
    assert report.status == "failed" and report.errors and "NODE_NOT_ONLINE" in report.errors[0]


def test_a_pipeline_that_could_not_be_created_is_never_reported_ready() -> None:
    fake = FakeController()
    original = fake.handle

    def refuse_put(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            return httpx.Response(422, json={"code": "INVALID_ARGUMENT", "message": "bad pipeline"})
        return original(request)

    fake.handle = refuse_put  # type: ignore[method-assign]
    report = run(fake)
    assert report.status == "not_ready" and not report.routes["t2va-local"]["ready"]
    assert any("could not be created" in e for e in report.errors)


def test_status_check_only_reads() -> None:
    fake = FakeController()
    methods: list[str] = []
    original = fake.handle

    def record(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        return original(request)

    api = bringup.Api("http://127.0.0.1:8080", transport=httpx.MockTransport(record))
    report = bringup.check(
        api, PLAN, {"t2va-local": PIPELINE}, controller_id=CONTROLLER_ID, node_id=NODE_A_ID, routes=["t2va-local"]
    )
    assert set(methods) == {"GET"}
    assert report.status == "not_ready" and report.pipelines == {"t2va-local": "missing"}
    assert any("phasyn-studio up" in step for step in report.next_steps)
    down = bringup.check(
        bringup.Api(
            "http://127.0.0.1:8080",
            transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused"))),
        ),
        PLAN,
        {"t2va-local": PIPELINE},
        controller_id=CONTROLLER_ID,
        node_id=NODE_A_ID,
        routes=["t2va-local"],
    )
    assert down.status == "down"


def test_a_stopping_component_is_started_once_it_has_stopped() -> None:
    fake = FakeController()
    fake.states["te-gpu0"] = "stopping"
    reads = {"n": 0}
    original = fake.handle

    def settle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/catalog":
            reads["n"] += 1
            if reads["n"] == 4:
                fake.states["te-gpu0"] = "stopped"
        return original(request)

    fake.handle = settle  # type: ignore[method-assign]
    report = run(fake)
    assert report.status == "ready" and fake.posts.count("te-gpu0") == 1
