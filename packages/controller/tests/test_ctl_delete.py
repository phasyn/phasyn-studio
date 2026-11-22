"""刪除與封存（x-phasyn-extension）：永久刪除 run（dry run 只列這個 run 的產物、Node 刪檔、紀錄副本、
Studio 參照、run 紀錄）、Node 刪檔失敗 → 502 且其餘不動、執行中拒絕、封存與列表篩選分頁、刪除紀錄副本與接線草稿。"""

from __future__ import annotations

import asyncio
import copy
import json
import threading
import uuid
from pathlib import Path
from typing import Any

import pytest
from controller_support import (
    ENDPOINT_A,
    NODE_A,
    TYPE,
    FakeNode,
    Harness,
    descriptor,
    pipeline,
    step,
    wait_until,
)
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.recorder import Recorder

from phasyn_controller.purge import produced_files


OPENAPI = json.loads(
    (contracts.contracts_dir() / contracts.OPENAPI_FILE).read_text(encoding="utf-8")
)
PURGE = "/api/runs/{run_id}"


def assert_shape(path: str, method: str, body: Any) -> None:
    """回應符合 contracts/openapi.json 的 inline 200 schema（additionalProperties=false）。"""
    schema = OPENAPI["paths"][path][method]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]
    contracts.validate_with_schema(
        schema, body, code="RUNTIME_ERROR", what=f"{method.upper()} {path}"
    )


def file_node(tmp_path: Path) -> FakeNode:
    node = FakeNode(
        NODE_A,
        ENDPOINT_A,
        [descriptor(NODE_A, "gen"), descriptor(NODE_A, "echo", resource_group="cpu-2")],
    )
    node.files = FileStore(tmp_path / "node-a", NODE_A)
    return node


async def produced_run(
    h: Harness, node: FakeNode
) -> tuple[dict[str, Any], dict[str, Any]]:
    """gen 步驟在 Node 上產生檔案；echo 步驟把 run 請求帶入的檔案原樣輸出（那個檔案不屬於這個 run）。"""
    source = node.publish_file(b"another run's video", "video/mp4")
    pipe = pipeline(
        [
            step("gen", NODE_A, "gen", params={"produce": True}),
            step(
                "echo",
                NODE_A,
                "echo",
                value={"literal": {"type_id": TYPE, "file": source}},
            ),
        ]
    )
    run = await h.wait_run((await h.start_run(pipe))["run_id"])
    assert run["state"] == "succeeded", run
    assert run["steps"]["echo"]["outputs"]["value"]["file"] == source
    return run, source


def produced_keys(run: dict[str, Any]) -> set[tuple[str, str]]:
    out = run["steps"]["gen"]["outputs"]
    refs = [
        out["video_latent"]["file"],
        out["audio_latent"]["file"],
        out["asset"]["value"]["file"],
    ]
    refs.append(
        out["video_latent"]["file"]["metadata"]["links"]["blob"]
    )  # 兩個 manifest 共用的附件只算一次
    return {(ref["node_id"], ref["file_id"]) for ref in refs}


async def publish_recording(
    h: Harness, root: Path, run_id: str | None
) -> tuple[str, dict[str, Any]]:
    """Node 上報一份 invoke recording（真的 Recorder 產生的 context/events/summary）。"""
    rid = str(uuid.uuid4())
    published: list[dict[str, Any]] = []

    def publish(record: dict[str, Any]) -> bool:
        published.append(record)
        return True

    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id="runtime",
        node_id=NODE_A,
        component_id="gen",
        provider_id="test.echo",
        process_instance_id=str(uuid.uuid4()),
        operation="invoke",
        run_id=run_id,
        call_id=str(uuid.uuid4()),
        config={"mode": "detailed"},
        publish=publish,
    )
    rec.write_context(settings=None, input_summary={}, environment={"test": True})
    rec.log("info", "事件")
    rec.finalize("succeeded")
    batch = {
        "node_id": NODE_A,
        "contexts": [r["data"] for r in published if r["record"] == "context"],
        "events": [r["data"] for r in published if r["record"] == "event"],
        "summaries": [r["data"] for r in published if r["record"] == "summary"],
    }
    resp = await h.client.post("/api/telemetry/batches", json=batch)
    assert resp.status_code == 200 and resp.json()["accepted_events"] > 0, resp.text
    return rid, batch


def project(pid: str, run_id: str, other_run: str) -> dict[str, Any]:
    take = {
        "take_id": "t1", "run_id": run_id, "output_key": "final", "created_at": "2026-10-17T00:00:00.000Z",
        "state": "succeeded", "prompt": "cat", "seed": 42, "frames": 124, "width": 768, "height": 448, "route": "route-a",
        "steps": None, "asset": None, "video_latent": None, "error": None, "timings_ms": {},
    }  # fmt: skip
    shot = {
        "shot_id": "s1", "title": "鏡頭", "prompt": "A cat", "frames": 124, "seed": 42, "seed_locked": False,
        "route": "route-a", "steps": None, "video_shift": None, "audio_shift": None, "enabled": True, "in_frame": 0,
        "out_frame": None, "takes": [take, {**take, "take_id": "t2", "run_id": other_run}], "active_take_id": "t1",
        "note": "",
    }  # fmt: skip
    export = {
        "export_id": "x1", "run_id": run_id, "created_at": "2026-10-17T00:00:00.000Z", "state": "succeeded",
        "shot_ids": ["s1"], "asset": None, "error": None, "frames": None,
    }  # fmt: skip
    return {
        "project_id": pid, "title": f"專案 {pid}", "revision": 0, "created_at": "2026-10-17T00:00:00.000Z",
        "updated_at": "2026-10-17T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
        "defaults": {"frames": 124, "route": "route-a", "steps": None},
        # 複製的鏡頭：新的 take_id、同一個 run
        "shots": [shot, {**shot, "shot_id": "s2", "takes": [{**take, "take_id": "t3"}], "active_take_id": "t3"}],
        "exports": [export, {**export, "export_id": "x2", "run_id": other_run}],
    }  # fmt: skip


async def save_project(h: Harness, doc: dict[str, Any]) -> dict[str, Any]:
    resp = await h.client.put(f"/api/studio/projects/{doc['project_id']}", json=doc)
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


async def assert_purged_projects(
    h: Harness, p1: dict[str, Any], p2: dict[str, Any]
) -> None:
    edited = (await h.client.get("/api/studio/projects/p1")).json()
    contracts.validate("StudioProject", edited)
    assert edited["revision"] == p1["revision"] + 1
    assert [t["take_id"] for t in edited["shots"][0]["takes"]] == ["t2"]
    assert (
        edited["shots"][0]["active_take_id"] is None
        and edited["shots"][1]["takes"] == []
    )
    assert edited["shots"][1]["active_take_id"] is None
    assert [x["export_id"] for x in edited["exports"]] == ["x2"]
    stale = await h.client.put(
        "/api/studio/projects/p1", json=p1
    )  # 開著的編輯器下次保存
    assert stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
    assert (await h.client.get("/api/studio/projects/p2")).json()["revision"] == p2[
        "revision"
    ]


def test_purge_plans_produced_files_then_deletes_everything(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = file_node(tmp_path)
            await h.add_node(node)
            run, source = await produced_run(h, node)
            rid = run["run_id"]
            other = await h.wait_run(
                (await h.start_run(pipeline([step("only", NODE_A, "echo")])))["run_id"]
            )
            node_rec, _ = await publish_recording(h, tmp_path / "node-recordings", rid)
            other_rec, _ = await publish_recording(
                h, tmp_path / "node-recordings", other["run_id"]
            )
            p1 = await save_project(h, project("p1", rid, other["run_id"]))
            p2 = await save_project(h, project("p2", other["run_id"], other["run_id"]))
            expected = produced_keys(run)
            assert len(expected) == 4 and (NODE_A, source["file_id"]) not in expected

            resp = await h.client.delete(f"/api/runs/{rid}", params={"dry_run": "true"})
            assert resp.status_code == 200, resp.text
            plan = resp.json()
            assert_shape(PURGE, "delete", plan)
            assert (plan["run_id"], plan["dry_run"], plan["deleted"]) == (
                rid,
                True,
                False,
            )
            assert {
                (f["node_id"], f["file_id"]) for f in plan["files"]
            } == expected  # 不含 run 請求帶入的檔案
            assert {f["status"] for f in plan["files"]} == {"planned"} and all(
                f["size_bytes"] for f in plan["files"]
            )
            assert plan["recordings"] == {
                "planned": 2,
                "deleted": 0,
            }  # 主控 recording+Node 上報的副本
            assert plan["projects"] == [
                {"project_id": "p1", "title": "專案 p1", "takes_removed": ["t1", "t3"], "exports_removed": ["x1"],
                 "revision": None}
            ]  # fmt: skip
            assert node.file_deletes == []  # dry run 不改任何東西
            assert (await h.client.get(f"/api/runs/{rid}")).status_code == 200
            assert (await h.client.get("/api/studio/projects/p1")).json()[
                "revision"
            ] == p1["revision"]

            resp = await h.client.delete(f"/api/runs/{rid}")
            assert resp.status_code == 200, resp.text
            result = resp.json()
            assert_shape(PURGE, "delete", result)
            assert (result["dry_run"], result["deleted"]) == (False, True)
            assert [f["file_id"] for f in result["files"]] == [
                f["file_id"] for f in plan["files"]
            ]
            assert {f["status"] for f in result["files"]} == {"deleted"}
            assert result["recordings"] == {"planned": 2, "deleted": 2}
            assert result["projects"] == [
                {**plan["projects"][0], "revision": p1["revision"] + 1}
            ]
            assert node.files is not None
            assert all(node.files.meta(fid) is None for _, fid in expected)
            assert node.files.meta(source["file_id"]) is not None  # 別人的檔案不刪

            assert (await h.client.get(f"/api/runs/{rid}")).json()[
                "code"
            ] == "NOT_FOUND"
            listed = (
                await h.client.get("/api/runs", params={"archived": "include"})
            ).json()
            assert [r["run_id"] for r in listed["items"]] == [other["run_id"]]
            for gone in (run["recording_ids"][0], node_rec):
                assert (
                    await h.client.get(f"/api/recordings/{gone}")
                ).status_code == 404
            assert (
                await h.client.get(f"/api/recordings/{other_rec}")
            ).status_code == 200
            await assert_purged_projects(h, p1, p2)

            again = await h.client.delete(f"/api/runs/{rid}")
            assert again.status_code == 404 and again.json()["code"] == "NOT_FOUND"
            assert (
                await h.client.delete(f"/api/runs/{rid}", params={"dry_run": "yes"})
            ).status_code == 422
            data_dir = h.config.data_dir
            assert not (data_dir / "runs" / rid).exists()
            assert not [
                *(data_dir / "runs").glob(".deleted-*"),
                *(data_dir / "recordings").glob(".deleted-*"),
            ]

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["node_error", "unreachable"])
def test_purge_stops_at_failed_node_file_and_changes_nothing_else(
    tmp_path: Path, failure: str
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = file_node(tmp_path)
            await h.add_node(node)
            run, _ = await produced_run(h, node)
            rid = run["run_id"]
            node_rec, _ = await publish_recording(h, tmp_path / "node-recordings", rid)
            p1 = await save_project(h, project("p1", rid, str(uuid.uuid4())))
            plan = (
                await h.client.delete(f"/api/runs/{rid}", params={"dry_run": "true"})
            ).json()
            if failure == "node_error":  # 第二個檔案刪除失敗：第一個已刪，其餘不再送出
                node.file_delete_errors[plan["files"][1]["file_id"]] = ComponentError(
                    "RUNTIME_ERROR", "假 Node：磁碟錯誤"
                )
                expected = (
                    "RUNTIME_ERROR",
                    ["deleted", "failed", "planned", "planned"],
                )
            else:
                h.router.unmount(ENDPOINT_A)
                expected = (
                    "NODE_UNREACHABLE",
                    ["failed", "planned", "planned", "planned"],
                )

            resp = await h.client.delete(f"/api/runs/{rid}")
            assert resp.status_code == 502, resp.text
            err = resp.json()
            contracts.validate("Error", err)
            details = err["details"]
            assert_shape(PURGE, "delete", details)  # Error.details=同一份計畫的當下狀態
            assert (err["code"], [f["status"] for f in details["files"]]) == expected
            failed = next(f for f in details["files"] if f["status"] == "failed")
            assert failed["code"] == expected[0] and failed["message"]
            assert details["deleted"] is False and details["recordings"] == {
                "planned": 2,
                "deleted": 0,
            }
            assert details["projects"][0]["revision"] is None

            if failure == "unreachable":
                h.router.mount(ENDPOINT_A, node.app)
            assert (
                await h.client.get(f"/api/runs/{rid}")
            ).status_code == 200  # 紀錄、專案、run 都沒動
            assert (
                await h.client.get(f"/api/recordings/{node_rec}")
            ).status_code == 200
            assert (await h.client.get("/api/studio/projects/p1")).json()[
                "revision"
            ] == p1["revision"]

            node.file_delete_errors.clear()  # 使用者稍後再刪一次（主控不自動重試）
            retry = await h.client.delete(f"/api/runs/{rid}")
            assert retry.status_code == 200, retry.text
            done = retry.json()
            already = ["missing"] if failure == "node_error" else ["deleted"]
            assert [f["status"] for f in done["files"]] == [
                *already,
                "deleted",
                "deleted",
                "deleted",
            ]
            assert done["deleted"] is True and done["recordings"]["deleted"] == 2
            assert done["projects"][0]["revision"] == p1["revision"] + 1

    asyncio.run(scenario())


def test_running_runs_cannot_be_deleted_archived_or_lose_recordings(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = file_node(tmp_path)
            await h.add_node(node)
            finished, _ = await produced_run(h, node)
            video = finished["steps"]["gen"]["outputs"]["asset"]["value"]["file"]
            # 執行中的 run 以 finished 的產物當輸入：等它結束前不刪 finished（刪了它的步驟會讀不到檔案）
            busy = [
                step(
                    "hang",
                    NODE_A,
                    "gen",
                    params={"hang": True},
                    value={"literal": {"type_id": TYPE, "file": video}},
                )
            ]
            run = await h.start_run(pipeline(busy))
            rid, controller_rec = run["run_id"], run["recording_ids"][0]
            await wait_until(lambda: len(node.calls) == 3)
            for method, url, body in (
                ("DELETE", f"/api/runs/{rid}", None),
                ("DELETE", f"/api/runs/{rid}?dry_run=true", None),
                ("POST", f"/api/runs/{rid}/archive", {"archived": True}),
                ("DELETE", f"/api/recordings/{controller_rec}", None),
            ):
                resp = await h.client.request(method, url, json=body)
                assert (
                    resp.status_code == 409 and resp.json()["code"] == "STATE_CONFLICT"
                ), (url, resp.text)
                assert "仍在執行" in resp.json()["message"]
            in_use = await h.client.delete(f"/api/runs/{finished['run_id']}")
            assert (
                in_use.status_code == 409
                and in_use.json()["details"]["active_run_id"] == rid
            ), in_use.text
            assert in_use.json()["details"]["files"] == [
                {"node_id": NODE_A, "file_id": video["file_id"]}
            ]
            assert node.file_deletes == []

            assert (await h.client.post(f"/api/runs/{rid}/cancel")).status_code == 200
            done = await h.wait_run(rid)
            assert done["state"] == "cancelled"
            assert (
                await h.client.delete(f"/api/recordings/{controller_rec}")
            ).json() == {
                "recording_id": controller_rec,
                "deleted": True,
            }
            assert (await h.client.delete(f"/api/runs/{finished['run_id']}")).json()[
                "deleted"
            ] is True

            # run.json 仍寫著 running，但 runner 沒有在執行它（例如最後一次寫入失敗）：不刪、不封存
            ghost = copy.deepcopy(done)
            ghost.update(run_id=str(uuid.uuid4()), state="running")
            path = h.config.data_dir / "runs" / ghost["run_id"] / "run.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(ghost), encoding="utf-8")
            for resp in (
                await h.client.delete(f"/api/runs/{ghost['run_id']}"),
                await h.client.post(
                    f"/api/runs/{ghost['run_id']}/archive", json={"archived": True}
                ),
            ):
                assert (
                    resp.status_code == 409
                    and resp.json()["details"]["state"] == "running"
                ), resp.text
            assert path.is_file()

    asyncio.run(scenario())


def test_run_reads_finished_only_once_it_can_be_deleted(tmp_path: Path) -> None:
    """最後一次 run.json 寫入還在進行：run 仍讀為 running，刪除與封存回 409（state=running）；
    一旦讀到結束，立刻可以刪除（不會有「已 succeeded 卻仍在執行」的 409）。"""

    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = file_node(tmp_path)
            await h.add_node(node)
            write, reached, proceed = (
                h.ctl.runs.write,
                threading.Event(),
                threading.Event(),
            )

            def gated_write(run_id: str, data: bytes) -> None:
                if (
                    json.loads(data)["state"] != "running"
                ):  # 最後一次寫入（終態）停在這裡，直到測試放行
                    reached.set()
                    proceed.wait(10)
                write(run_id, data)

            h.ctl.runs.write = gated_write
            try:
                rid = (await h.start_run(pipeline([step("only", NODE_A, "echo")])))[
                    "run_id"
                ]
                await wait_until(reached.is_set)
                assert (await h.client.get(f"/api/runs/{rid}")).json()[
                    "state"
                ] == "running"
                for resp in (
                    await h.client.delete(
                        f"/api/runs/{rid}", params={"dry_run": "true"}
                    ),
                    await h.client.post(
                        f"/api/runs/{rid}/archive", json={"archived": True}
                    ),
                ):
                    assert (
                        resp.status_code == 409
                        and resp.json()["details"]["state"] == "running"
                    ), resp.text
            finally:
                proceed.set()
            assert (await h.wait_run(rid))["state"] == "succeeded"
            plan = await h.client.delete(f"/api/runs/{rid}", params={"dry_run": "true"})
            assert plan.status_code == 200, plan.text

    asyncio.run(scenario())


def test_delete_recording_copy_and_pipeline_draft(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            rid, batch = await publish_recording(h, tmp_path / "node-recordings", None)
            resp = await h.client.delete(f"/api/recordings/{rid}")
            assert resp.status_code == 200 and resp.json() == {
                "recording_id": rid,
                "deleted": True,
            }
            assert_shape("/api/recordings/{recording_id}", "delete", resp.json())
            assert (await h.client.get(f"/api/recordings/{rid}")).json()[
                "code"
            ] == "RECORDING_NOT_FOUND"
            assert (await h.client.get("/api/recordings")).json()["items"] == []
            assert not (h.config.data_dir / "recordings" / rid).exists()
            again = await h.client.delete(f"/api/recordings/{rid}")
            assert (
                again.status_code == 404
                and again.json()["code"] == "RECORDING_NOT_FOUND"
            )
            assert (
                await h.client.delete("/api/recordings/not-a-uuid")
            ).status_code == 422
            # Node 本機紀錄不受影響：之後再上報（或 fetch-history）同一 recording 會重新出現
            assert (await h.client.post("/api/telemetry/batches", json=batch)).json()[
                "accepted_events"
            ] > 0
            assert (await h.client.get(f"/api/recordings/{rid}")).status_code == 200

            pipe = pipeline([step("s", NODE_A, "echo")], pipeline_id="draft")
            assert (
                await h.client.put("/api/pipelines/draft", json=pipe)
            ).status_code == 200
            resp = await h.client.delete("/api/pipelines/draft")
            assert resp.status_code == 200 and resp.json() == {
                "pipeline_id": "draft",
                "deleted": True,
            }
            assert_shape("/api/pipelines/{pipeline_id}", "delete", resp.json())
            assert (await h.client.get("/api/pipelines/draft")).status_code == 404
            assert (await h.client.get("/api/pipelines")).json()["items"] == []
            again = await h.client.delete("/api/pipelines/draft")
            assert again.status_code == 404 and again.json()["code"] == "NOT_FOUND"
            assert (await h.client.delete("/api/pipelines/bad%20id")).status_code == 422

    asyncio.run(scenario())


def test_produced_files_include_files_inside_inline_values() -> None:
    """inline 值裡內嵌的 FileRef（例如 image.asset.v1）也算 run 的產物；run 請求帶入的檔案仍排除。"""

    def ref(fid: str) -> dict[str, Any]:
        return {
            "node_id": NODE_A,
            "file_id": fid,
            "size_bytes": 3,
            "sha256": "0" * 64,
            "media_type": "image/png",
        }

    image, white, source = (str(uuid.uuid4()) for _ in range(3))
    run = {
        "request": {
            "inputs": {"ref": {"type_id": "media.image.v1", "file": ref(source)}}
        },
        "steps": {
            "compose": {
                "outputs": {
                    "image": {
                        "type_id": "image.asset.v1",
                        "value": {"asset_id": "a", "file": ref(image)},
                    },
                    "image_white": {"type_id": "media.image.v1", "file": ref(white)},
                    "echo": {"type_id": "media.image.v1", "file": ref(source)},
                }
            }
        },
    }
    assert [f["file_id"] for f in produced_files(run)] == [image, white]


def test_purge_keeps_files_used_by_a_project_library(tmp_path: Path) -> None:
    """加入 Studio 素材庫的產物不刪：dry run 標 kept，實際刪除時跳過該檔，其餘照刪，run 與 take 照常移除。"""

    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            node = file_node(tmp_path)
            await h.add_node(node)
            run, _source = await produced_run(h, node)
            rid = run["run_id"]
            asset_ref = run["steps"]["gen"]["outputs"]["asset"]["value"]["file"]
            doc = project("p1", rid, rid)
            doc["library"] = [
                {
                    "item_id": "lib-1", "kind": "video", "name": "成品", "file": asset_ref,
                    "created_at": "2026-10-17T00:00:00.000Z", "duration_seconds": 1.0, "width": 8, "height": 8,
                    "has_audio": False,
                }
            ]  # fmt: skip
            await save_project(h, doc)
            kept = (asset_ref["node_id"], asset_ref["file_id"])

            resp = await h.client.delete(f"/api/runs/{rid}", params={"dry_run": "true"})
            assert resp.status_code == 200, resp.text
            plan = resp.json()
            assert_shape(PURGE, "delete", plan)
            status = {(f["node_id"], f["file_id"]): f["status"] for f in plan["files"]}
            assert status[kept] == "kept" and {
                s for k, s in status.items() if k != kept
            } == {"planned"}

            resp = await h.client.delete(f"/api/runs/{rid}")
            assert resp.status_code == 200, resp.text
            result = resp.json()
            assert_shape(PURGE, "delete", result)
            assert result["deleted"] is True
            assert (
                node.files is not None and node.files.meta(kept[1]) is not None
            )  # 素材庫的檔案還在
            others = [k for k in status if k != kept]
            assert others and all(node.files.meta(fid) is None for _, fid in others)
            edited = (await h.client.get("/api/studio/projects/p1")).json()
            assert edited["library"][0]["file"]["file_id"] == kept[1]
            assert edited["shots"][0]["takes"] == []

    asyncio.run(scenario())
