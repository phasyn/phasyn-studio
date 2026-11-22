"""Studio write receipts: a failure before the commit point frees the key, every write finishes before shutdown, and
the timeline export is one write-once command whose project cap is reserved under the store lock."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

import pytest
from controller_support import Harness
from phasyn_components.errors import ComponentError
from starlette.requests import Request
from test_ctl_studio_timeline import (
    PROJECTS,
    export_node,
    read,
    rendered_project,
    saved,
)

from phasyn_controller import studio_timeline
from phasyn_controller.studio_writes import StudioWrites
from phasyn_controller.studio_writes.ledger import key_identity


def _request(key: str | None) -> Request:
    headers = [] if key is None else [(b"idempotency-key", key.encode())]
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/studio/projects/p1/edit",
            "raw_path": b"/api/studio/projects/p1/edit",
            "query_string": b"",
            "headers": headers,
            "scheme": "http",
            "server": ("test", 80),
            "root_path": "",
        }
    )


def _state(writes: StudioWrites, key: str) -> str | None:
    try:
        return str(writes.ledger.read(key_identity(key), "p1")["state"])
    except ComponentError as exc:
        assert exc.code == "NOT_FOUND"
        return None


def test_a_failure_before_the_commit_point_frees_the_receipt_key(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        writes = StudioWrites(tmp_path / "receipts.sqlite")
        body = {"revision": 1}
        calls: list[str] = []

        async def offline() -> dict[str, Any]:
            calls.append("probe")
            raise ComponentError("NODE_UNREACHABLE", "source node offline")

        async def crashed() -> dict[str, Any]:
            raise RuntimeError("probe bug")

        async def write() -> dict[str, Any]:
            writes.committing()
            calls.append("write")
            return {"revision": 2}

        for failure in (offline, crashed):
            with pytest.raises((ComponentError, RuntimeError)):
                await writes.perform(_request("k1"), "p1", body, failure)
            assert _state(writes, "k1") is None
        done = await writes.perform(_request("k1"), "p1", body, write)
        assert done.status_code == 200 and _state(writes, "k1") == "committed"
        replay = await writes.perform(_request("k1"), "p1", body, write)
        assert replay.headers["X-Phasyn-Receipt-Replay"] == "1"
        assert calls == ["probe", "write"]

    asyncio.run(scenario())


def test_a_failure_after_the_commit_point_keeps_the_outcome_unknown(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        writes = StudioWrites(tmp_path / "receipts.sqlite")

        async def lost() -> dict[str, Any]:
            writes.committing()
            raise ComponentError("NODE_UNREACHABLE", "lost after the write began")

        async def refused() -> dict[str, Any]:
            raise ComponentError("INVALID_ARGUMENT", "bad request")

        with pytest.raises(ComponentError):
            await writes.perform(_request("k2"), "p1", {}, lost)
        assert _state(writes, "k2") == "reserved"
        with pytest.raises(ComponentError) as retry:
            await writes.perform(_request("k2"), "p1", {}, lost)
        assert retry.value.code == "STATE_CONFLICT"
        assert retry.value.remote_outcome_unknown
        # A deterministic refusal stays terminal and is replayed.
        with pytest.raises(ComponentError):
            await writes.perform(_request("k3"), "p1", {}, refused)
        assert _state(writes, "k3") == "rejected"
        replay = await writes.perform(_request("k3"), "p1", {}, refused)
        assert replay.status_code == 422

    asyncio.run(scenario())


def test_a_write_without_a_key_is_tracked_until_it_finishes(tmp_path: Path) -> None:
    async def scenario() -> None:
        writes = StudioWrites(tmp_path / "receipts.sqlite")
        gate = asyncio.Event()
        finished: list[bool] = []

        async def slow() -> dict[str, Any]:
            await gate.wait()
            finished.append(True)
            return {}

        caller = asyncio.create_task(writes.perform(_request(None), "p1", {}, slow))
        await asyncio.sleep(0)
        assert len(writes.pending) == 1
        caller.cancel()  # the client disconnects
        with contextlib.suppress(asyncio.CancelledError):
            await caller
        assert len(writes.pending) == 1 and not finished
        gate.set()
        await writes.drain()
        assert finished == [True] and not writes.pending

    asyncio.run(scenario())


def test_an_export_with_a_receipt_key_starts_one_run_and_replays_it(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            await saved(h, rendered_project())
            await h.add_node(export_node(tmp_path))
            url = f"{PROJECTS}/p1/timeline/export"
            headers = {"Idempotency-Key": "export-once"}
            first = await h.client.post(url, json={"revision": 1}, headers=headers)
            assert first.status_code == 202, first.text
            again = await h.client.post(url, json={"revision": 1}, headers=headers)
            assert again.status_code == 202
            assert again.headers["X-Phasyn-Receipt-Replay"] == "1"
            assert again.json() == first.json()
            runs = (await h.client.get("/api/runs")).json()["items"]
            assert [r["run_id"] for r in runs] == [first.json()["run_id"]]
            assert len((await read(h))["exports"]) == 1
            await h.wait_run(first.json()["run_id"])

    asyncio.run(scenario())


def test_the_export_cap_is_reserved_before_the_run_and_never_leaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(studio_timeline, "MAX_EXPORTS", 1)

    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            await saved(h, rendered_project())
            store = h.ctl.studio
            assert store.reserve_export("p1", 1)
            assert not store.reserve_export(
                "p1", 1
            )  # a concurrent export sees the held slot
            store.release_export("p1")
            url = f"{PROJECTS}/p1/timeline/export"
            # A refusal after the slot was taken (no exporter yet) returns it.
            unconfigured = await h.client.post(url, json={"revision": 1})
            assert unconfigured.json()["code"] == "COMPONENT_NOT_CONFIGURED"
            await h.add_node(export_node(tmp_path))
            started = await h.client.post(url, json={"revision": 1})
            assert started.status_code == 202, started.text
            await h.wait_run(started.json()["run_id"])
            full = await h.client.post(url, json={"revision": 2})
            assert (full.status_code, full.json()["details"]["reason"]) == (
                422,
                "limit_exceeded",
            )
            assert len((await h.client.get("/api/runs")).json()["items"]) == 1
            assert not store.reserve_export("p1", 1)
            assert store._export_holds == {}

    asyncio.run(scenario())
