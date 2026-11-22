"""Storage cleanup (x-phasyn-extension) boundary tests: what the reference graph protects and what it deletes.

Destructive paths on temporary data directories: referenced runs and files are never planned, pinned runs and files
are never collected, young uploads are protected, an apply deletes only listed items that are still eligible (a file
an active run started using since the dry run stays), a second apply changes nothing, a node keeps what its running
calls use, remote copies go only when they can be fetched again (or nothing needs them), a decoded take's latent is
removed from the project before its files go, and the project-scoped cleanup removes only media no other project
names.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from controller_support import (
    ENDPOINT_A,
    ENDPOINT_B,
    NODE_A,
    NODE_B,
    TYPE,
    FakeNode,
    Harness,
    descriptor,
    pipeline,
    step,
    wait_until,
)
from phasyn_components import contracts
from phasyn_components.files import FileStore

from phasyn_controller.storage import plan as plan_module


CATEGORIES = ["runs", "files", "remote_cache", "latents", "recordings"]


class _Later(datetime):
    """``datetime.now`` 400 days ahead: everything on disk is old enough for every rule."""

    @classmethod
    def now(cls, tz: Any = None) -> _Later:  # type: ignore[override]
        base = datetime.now(tz or UTC) + timedelta(days=400)
        return cls.fromtimestamp(base.timestamp(), tz or UTC)


@pytest.fixture
def later(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(plan_module, "datetime", _Later)
    yield


def node_with_files(
    tmp_path: Path,
    node_id: str = NODE_A,
    endpoint: str = ENDPOINT_A,
    name: str = "node-a",
) -> FakeNode:
    node = FakeNode(
        node_id,
        endpoint,
        [
            descriptor(node_id, "gen"),
            descriptor(node_id, "echo", resource_group="cpu-2"),
        ],
    )
    node.files = FileStore(tmp_path / name, node_id)
    return node


async def finished_run(
    h: Harness,
    node: FakeNode,
    *,
    note: str | None = None,
    inputs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    extra: dict[str, Any] = {"origin": {"note": note}} if note else {}
    body_inputs = (
        inputs if inputs is not None else {"text": {"type_id": TYPE, "value": "hi"}}
    )
    pipe = pipeline([step("gen", node.node_id, "gen", params={"produce": True})])
    run = await h.wait_run((await h.start_run(pipe, body_inputs, **extra))["run_id"])
    assert run["state"] == "succeeded", run
    return run


def produced(run: dict[str, Any]) -> set[str]:
    out = run["steps"]["gen"]["outputs"]
    return {
        out["video_latent"]["file"]["file_id"],
        out["audio_latent"]["file"]["file_id"],
        out["video_latent"]["file"]["metadata"]["links"]["blob"]["file_id"],
        out["asset"]["value"]["file"]["file_id"],
    }


def take(run: dict[str, Any], take_id: str, *, latent: bool = False) -> dict[str, Any]:
    out = run["steps"]["gen"]["outputs"]
    return {
        "take_id": take_id, "run_id": run["run_id"], "output_key": "final", "created_at": "2026-10-17T00:00:00.000Z",
        "state": "succeeded", "prompt": "cat", "seed": 42, "frames": 124, "width": 768, "height": 448, "route": "route-a",
        "steps": None, "asset": out["asset"]["value"] if latent else None,
        "video_latent": out["video_latent"]["file"] if latent else None, "error": None, "timings_ms": {},
    }  # fmt: skip


def project(
    pid: str, takes: list[dict[str, Any]], library: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    shot = {
        "shot_id": "s1", "title": "鏡頭", "prompt": "A cat", "frames": 124, "seed": 42, "seed_locked": False,
        "route": "route-a", "steps": None, "video_shift": None, "audio_shift": None, "enabled": True, "in_frame": 0,
        "out_frame": None, "takes": takes, "active_take_id": takes[0]["take_id"] if takes else None, "note": "",
    }  # fmt: skip
    doc: dict[str, Any] = {
        "project_id": pid, "title": f"專案 {pid}", "revision": 0, "created_at": "2026-10-17T00:00:00.000Z",
        "updated_at": "2026-10-17T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": [shot], "exports": [],
    }  # fmt: skip
    if library:
        doc["library"] = library
    return doc


def library_item(item_id: str, ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "item_id": item_id, "kind": "image", "name": "參考", "file": ref, "created_at": "2026-10-17T00:00:00.000Z",
        "duration_seconds": None, "width": 8, "height": 8, "has_audio": False,
    }  # fmt: skip


async def save(h: Harness, doc: dict[str, Any]) -> dict[str, Any]:
    resp = await h.client.put(f"/api/studio/projects/{doc['project_id']}", json=doc)
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def clean(h: Harness, body: dict[str, Any], status: int = 200) -> dict[str, Any]:
    resp = await h.client.post("/api/storage/clean", json=body)
    assert resp.status_code == status, resp.text
    doc = dict(resp.json())
    if status == 200:
        contracts.validate("StorageCleanResult", doc)
    return doc


def ids(result: dict[str, Any], category: str | None = None) -> set[str]:
    return {
        i["item_id"]
        for i in result["items"]
        if category is None or i["category"] == category
    }


async def upload(h: Harness, data: bytes) -> dict[str, Any]:
    resp = await h.client.post(
        "/api/files", content=data, params={"media_type": "image/png"}
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


@pytest.mark.usefixtures("later")
def test_reference_graph_plan_apply_and_repeat(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            kept_run = await finished_run(h, node, note="p1/render")
            orphan = await finished_run(h, node, note="gone/render")
            standalone = await finished_run(h, node)
            pinned = await finished_run(h, node, note="gone/pinned")
            loose = node.publish_file(b"nobody", "image/png")
            pinned_file = node.publish_file(b"pinned", "image/png")
            in_library = node.publish_file(b"library", "image/png")
            upload_ref = await upload(h, b"controller upload")
            await save(
                h,
                project(
                    "p1", [take(kept_run, "t1")], [library_item("lib", in_library)]
                ),
            )
            resp = await h.client.post(
                "/api/storage/pins",
                json={"add": [{"kind": "run", "run_id": pinned["run_id"], "note": "evidence"},
                              {"kind": "file", "node_id": NODE_A, "file_id": pinned_file["file_id"]}]},
            )  # fmt: skip
            assert resp.status_code == 200 and len(resp.json()["items"]) == 2, resp.text

            plan = await clean(h, {"categories": ["runs", "files"], "dry_run": True})
            assert ids(plan, "runs") == {f"run:{orphan['run_id']}"}
            assert ids(plan, "files") == {
                f"file:{NODE_A}/{loose['file_id']}",
                f"file:{upload_ref['node_id']}/{upload_ref['file_id']}",
            }
            assert all(i["status"] == "planned" for i in plan["items"])
            # Nothing changed by the dry run
            assert (
                node.files is not None and node.files.meta(loose["file_id"]) is not None
            )
            assert (
                await h.client.get(f"/api/runs/{orphan['run_id']}")
            ).status_code == 200

            wide = await clean(
                h,
                {
                    "categories": ["runs"],
                    "dry_run": True,
                    "options": {"include_standalone_runs": True},
                },
            )
            assert ids(wide) == {
                f"run:{orphan['run_id']}",
                f"run:{standalone['run_id']}",
            }

            result = await clean(
                h,
                {
                    "categories": ["runs", "files"],
                    "dry_run": False,
                    "items": sorted(ids(plan)),
                },
            )
            assert {
                i["item_id"]: i["status"] for i in result["items"]
            } == dict.fromkeys(ids(plan), "deleted")
            assert (
                await h.client.get(f"/api/runs/{orphan['run_id']}")
            ).status_code == 404
            assert all(node.files.meta(fid) is None for fid in produced(orphan))
            assert node.files.meta(loose["file_id"]) is None
            assert h.ctl.files.meta(upload_ref["file_id"]) is None
            # Referenced, pinned and standalone things are untouched
            for run in (kept_run, standalone, pinned):
                assert (
                    await h.client.get(f"/api/runs/{run['run_id']}")
                ).status_code == 200
                assert all(node.files.meta(fid) is not None for fid in produced(run))
            assert node.files.meta(pinned_file["file_id"]) is not None
            assert node.files.meta(in_library["file_id"]) is not None
            assert (await h.client.get("/api/studio/projects/p1")).json()[
                "revision"
            ] == 1
            audit = (
                (h.ctl.data_dir / "config" / "storage" / "audit.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )
            assert len(audit) == 1 and json.loads(audit[0])["counts"]["runs"] == {
                "deleted": 1
            }

            again = await clean(
                h,
                {
                    "categories": ["runs", "files"],
                    "dry_run": False,
                    "items": sorted(ids(plan)),
                },
            )
            assert {i["status"] for i in again["items"]} == {"skipped"}

            usage = (await h.client.get("/api/storage")).json()
            contracts.validate("StorageUsage", usage)
            assert usage["pins"] == 2
            assert [p["project_id"] for p in usage["projects"]] == ["p1"]

    asyncio.run(scenario())


def test_young_uploads_are_protected_and_min_age_needs_a_scope(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            upload_ref = await upload(h, b"just uploaded")
            plan = await clean(h, {"categories": ["files"], "dry_run": True})
            assert plan["items"] == []
            refused = await clean(
                h,
                {
                    "categories": ["files"],
                    "dry_run": True,
                    "options": {"min_age_hours": 0},
                },
                422,
            )
            assert refused["code"] == "INVALID_ARGUMENT"
            missing_items = await clean(
                h, {"categories": ["files"], "dry_run": False}, 422
            )
            assert missing_items["code"] == "INVALID_ARGUMENT"
            assert h.ctl.files.meta(upload_ref["file_id"]) is not None

    asyncio.run(scenario())


@pytest.mark.usefixtures("later")
def test_apply_rechecks_active_runs_busy_nodes_and_one_cleanup_at_a_time(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            used_later = node.publish_file(b"input of a later run", "image/png")
            node_busy = node.publish_file(b"read by a running call", "image/png")
            plan = await clean(h, {"categories": ["files"], "dry_run": True})
            assert ids(plan) == {
                f"file:{NODE_A}/{used_later['file_id']}",
                f"file:{NODE_A}/{node_busy['file_id']}",
            }

            # A run starts using one file after the dry run; the node reports the other as busy
            gated = pipeline(
                [
                    step(
                        "hold",
                        NODE_A,
                        "echo",
                        params={"gate": "g"},
                        value={"literal": {"type_id": TYPE, "file": used_later}},
                    )
                ]
            )
            started = await h.start_run(gated)
            await wait_until(lambda: node.started("hold"))
            node.clean_busy.add((NODE_A, node_busy["file_id"]))
            result = await clean(
                h,
                {"categories": ["files"], "dry_run": False, "items": sorted(ids(plan))},
            )
            status = {i["item_id"]: i["status"] for i in result["items"]}
            assert status[f"file:{NODE_A}/{used_later['file_id']}"] == "skipped"
            assert status[f"file:{NODE_A}/{node_busy['file_id']}"] == "kept"
            assert node.files is not None
            assert node.files.meta(used_later["file_id"]) is not None
            assert node.files.meta(node_busy["file_id"]) is not None

            await h.ctl.storage.lock.acquire()
            try:
                busy = await clean(
                    h, {"categories": ["files"], "dry_run": False, "items": []}, 409
                )
                assert busy["code"] == "STATE_CONFLICT"
            finally:
                h.ctl.storage.lock.release()
            node.gate("g").set()
            await h.wait_run(started["run_id"])

    asyncio.run(scenario())


@pytest.mark.usefixtures("later")
def test_remote_copies_only_when_fetchable_or_unneeded(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            origin = node_with_files(tmp_path)
            holder = node_with_files(tmp_path, NODE_B, ENDPOINT_B, "node-b")
            await h.add_node(origin)
            await h.add_node(holder)
            still_there = origin.publish_file(b"origin keeps it", "image/png")
            gone_needed = origin.publish_file(b"only copy left", "image/png")
            gone_unneeded = origin.publish_file(b"nobody needs it", "image/png")
            assert holder.files is not None and origin.files is not None
            for ref in (still_there, gone_needed, gone_unneeded):
                writer = holder.files.remote_writer(ref)
                writer.write(origin.files.payload_path(ref["file_id"]).read_bytes())
                writer.commit()
            origin.files.delete(gone_needed["file_id"])
            origin.files.delete(gone_unneeded["file_id"])
            await save(
                h,
                project(
                    "p1",
                    [],
                    [
                        library_item("lib", gone_needed),
                        library_item("lib2", still_there),
                    ],
                ),
            )

            plan = await clean(h, {"categories": ["remote_cache"], "dry_run": True})
            assert ids(plan) == {
                f"remote:{NODE_B}/{NODE_A}/{still_there['file_id']}",
                f"remote:{NODE_B}/{NODE_A}/{gone_unneeded['file_id']}",
            }
            result = await clean(
                h,
                {
                    "categories": ["remote_cache"],
                    "dry_run": False,
                    "items": sorted(ids(plan)),
                },
            )
            assert {i["status"] for i in result["items"]} == {"deleted"}
            assert holder.files.remote_copy(still_there) is None
            assert holder.files.remote_copy(gone_needed) is not None
            assert origin.files.meta(still_there["file_id"]) is not None

    asyncio.run(scenario())


@pytest.mark.usefixtures("later")
def test_latent_leaves_the_project_before_its_files(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            mine = await finished_run(h, node, note="p1/render")
            shared = await finished_run(h, node, note="p1/render")
            await save(
                h,
                project(
                    "p1",
                    [take(mine, "t1", latent=True), take(shared, "t2", latent=True)],
                ),
            )
            await save(h, project("p2", [take(shared, "t9", latent=True)]))

            plan = await clean(h, {"categories": ["latents"], "dry_run": True})
            assert ids(plan) == {"latent:p1/s1/t1"}  # t2's latent is also t9's
            out = mine["steps"]["gen"]["outputs"]
            latent_files = {
                out["video_latent"]["file"]["file_id"],
                out["video_latent"]["file"]["metadata"]["links"]["blob"]["file_id"],
                out["audio_latent"]["file"]["file_id"],
            }
            result = await clean(
                h,
                {
                    "categories": ["latents"],
                    "dry_run": False,
                    "items": ["latent:p1/s1/t1"],
                },
            )
            assert [i["status"] for i in result["items"]] == ["deleted"]
            edited = (await h.client.get("/api/studio/projects/p1")).json()
            assert edited["revision"] == 2
            takes = {t["take_id"]: t for t in edited["shots"][0]["takes"]}
            assert (
                takes["t1"]["video_latent"] is None and takes["t1"]["asset"] is not None
            )
            assert takes["t2"]["video_latent"] is not None
            assert node.files is not None
            assert all(node.files.meta(fid) is None for fid in latent_files)
            assert node.files.meta(out["asset"]["value"]["file"]["file_id"]) is not None

    asyncio.run(scenario())


def test_project_scope_removes_only_its_exclusive_media(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            await h.add_node(node)
            run = await finished_run(h, node, note="p1/render")
            own = await upload(h, b"only p1")
            both = await upload(h, b"p1 and p2")
            doc = await save(
                h,
                project(
                    "p1",
                    [take(run, "t1")],
                    [library_item("a", own), library_item("b", both)],
                ),
            )
            await save(h, project("p2", [], [library_item("b", both)]))
            resp = await h.client.delete(
                "/api/studio/projects/p1", params={"revision": doc["revision"]}
            )
            assert resp.status_code == 200, resp.text

            scope = {
                "project_ids": ["p1"],
                "run_ids": [run["run_id"]],
                "files": [
                    {"node_id": r["node_id"], "file_id": r["file_id"]}
                    for r in (own, both)
                ],
            }
            body = {
                "categories": ["runs", "files"],
                "dry_run": True,
                "options": {"min_age_hours": 0},
                "scope": scope,
            }
            plan = await clean(h, body)
            assert ids(plan) == {
                f"run:{run['run_id']}",
                f"file:{own['node_id']}/{own['file_id']}",
            }
            result = await clean(
                h, {**body, "dry_run": False, "items": sorted(ids(plan))}
            )
            assert {i["status"] for i in result["items"]} == {"deleted"}
            assert h.ctl.files.meta(own["file_id"]) is None
            assert h.ctl.files.meta(both["file_id"]) is not None
            assert node.files is not None and all(
                node.files.meta(fid) is None for fid in produced(run)
            )

    asyncio.run(scenario())


@pytest.mark.usefixtures("later")
def test_old_node_without_storage_api_is_reported_not_guessed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = node_with_files(tmp_path)
            node.storage_supported = False
            await h.add_node(node)
            node.publish_file(b"unknown to the controller", "image/png")
            plan = await clean(h, {"categories": CATEGORIES, "dry_run": True})
            assert plan["items"] == []
            assert [n["state"] for n in plan["nodes"]] == ["unsupported"]

    asyncio.run(scenario())


def test_usage_reports_each_nodes_work_directories(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            new = node_with_files(tmp_path)
            new.storage_work = {
                "count": 3,
                "size_bytes": 7000,
                "enabled": True,
                "ttl_hours": 24,
                "last_sweep": {
                    "at": "2026-11-21T12:00:00Z",
                    "removed": 2,
                    "freed_bytes": 5000,
                    "failed": 0,
                },
            }
            old = node_with_files(tmp_path, NODE_B, ENDPOINT_B, "node-b")
            await h.add_node(new)
            await h.add_node(old)
            usage = (await h.client.get("/api/storage")).json()
            contracts.validate("StorageUsage", usage)
            work = {row["node_id"]: row["work"] for row in usage["nodes"]}
            assert work[NODE_A] == new.storage_work
            assert work[NODE_B] is None  # an older Node does not report it

    asyncio.run(scenario())
