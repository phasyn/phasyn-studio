"""元件組合分類與排序：缺檔＝revision 0、保存 0→1、過期 409、驗證 422、讀取正規化（不寫回）、GET /api/pipelines 的順序、契約鏡像。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from controller_support import NODE_A, Harness, pipeline, step
from phasyn_components import contracts

URL = "/api/pipeline-layout"


def layout(revision: int, groups: list[dict[str, Any]], ungrouped: list[str]) -> dict[str, Any]:
    return {"revision": revision, "updated_at": None, "groups": groups, "ungrouped": ungrouped}


def group(group_id: str, name: str, *pipeline_ids: str) -> dict[str, Any]:
    return {"group_id": group_id, "name": name, "pipeline_ids": list(pipeline_ids)}


async def save_pipelines(h: Harness, *pipeline_ids: str) -> None:
    for pid in pipeline_ids:
        resp = await h.client.put(f"/api/pipelines/{pid}", json=pipeline([step("s", NODE_A, "echo")], pipeline_id=pid))
        assert resp.status_code == 200, resp.text


async def listed_ids(h: Harness) -> list[str]:
    listing = (await h.client.get("/api/pipelines")).json()
    contracts.validate("ListPipelines", listing)
    return [item["pipeline_id"] for item in listing["items"]]


def test_pipeline_layout_round_trip_conflict_and_order(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            await save_pipelines(h, "t2va", "fl2va", "ref2va")
            empty = await h.client.get(URL)
            assert empty.status_code == 200
            assert empty.json() == layout(0, [], ["fl2va", "ref2va", "t2va"])  # 缺檔：全部依 ID 排在未分類
            contracts.validate("PipelineLayout", empty.json())
            assert await listed_ids(h) == ["fl2va", "ref2va", "t2va"]

            body = layout(0, [group("g-prod", "正式", "t2va", "ref2va"), group("g-lab", "實驗")], ["fl2va"])
            created = await h.client.put(URL, json=body)
            assert created.status_code == 200, created.text
            saved = created.json()
            contracts.validate("PipelineLayout", saved)
            assert saved["revision"] == 1 and saved["updated_at"] is not None
            assert saved["groups"] == body["groups"] and saved["ungrouped"] == ["fl2va"]
            assert (await h.client.get(URL)).json() == saved
            stored = h.config.data_dir / "config" / "pipeline-layout.json"
            assert json.loads(stored.read_text(encoding="utf-8")) == saved
            # 清單（Studio 運算路由、推理頁、左欄）依分類順序：分類依序、組內依序，然後未分類
            assert await listed_ids(h) == ["t2va", "ref2va", "fl2va"]

            stale = await h.client.put(URL, json={**body, "groups": []})
            assert stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
            assert stale.json()["details"] == {"stored_revision": 1, "expected_revision": 0}
            assert (await h.client.get(URL)).json() == saved  # 被拒絕的寫入不改變已保存的文件

            # 沒有列到的已保存元件組合接在未分類最後（保存的是正規化後的文件）
            partial = await h.client.put(URL, json=layout(1, [group("g-prod", "正式", "ref2va")], []))
            assert partial.status_code == 200, partial.text
            assert partial.json()["revision"] == 2
            assert partial.json()["ungrouped"] == ["fl2va", "t2va"]
            assert await listed_ids(h) == ["ref2va", "fl2va", "t2va"]

    asyncio.run(scenario())


def test_pipeline_layout_normalizes_without_writing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            await save_pipelines(h, "a", "b", "c")
            body = layout(0, [group("g1", "正式", "c", "a")], ["b"])
            saved = (await h.client.put(URL, json=body)).json()
            stored = h.config.data_dir / "config" / "pipeline-layout.json"
            before = stored.read_text(encoding="utf-8")

            assert (await h.client.delete("/api/pipelines/a")).status_code == 200  # 刪除不會讓分類壞掉
            await save_pipelines(h, "aa", "0-new")
            got = (await h.client.get(URL)).json()
            contracts.validate("PipelineLayout", got)
            assert got == {**saved, "groups": [group("g1", "正式", "c")], "ungrouped": ["b", "0-new", "aa"]}
            assert stored.read_text(encoding="utf-8") == before  # 讀取不寫回
            assert await listed_ids(h) == ["c", "b", "0-new", "aa"]

            # 以同一個 revision 保存正規化後的內容：已刪除的不再出現
            again = await h.client.put(URL, json=got)
            assert again.status_code == 200 and again.json()["revision"] == 2
            assert "a" not in json.loads(stored.read_text(encoding="utf-8"))["groups"][0]["pipeline_ids"]

            # 已保存的檔案損毀：分類 API 回 500，清單仍可用（依 ID 排序）
            stored.write_text("{not json", encoding="utf-8")
            broken = await h.client.get(URL)
            assert broken.status_code == 500 and broken.json()["code"] == "RUNTIME_ERROR"
            assert await listed_ids(h) == ["0-new", "aa", "b", "c"]
            rejected = await h.client.put(URL, json=got)
            assert rejected.status_code == 500 and rejected.json()["code"] == "RUNTIME_ERROR"

    asyncio.run(scenario())
