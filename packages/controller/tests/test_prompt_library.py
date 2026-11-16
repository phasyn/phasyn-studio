"""固定 Prompt 片段庫：缺檔＝revision 0、保存 0→1、過期 409、契約與重複 ID 驗證、損毀檔回 RUNTIME_ERROR。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from controller_support import Harness
from phasyn_components import contracts

URL = "/api/studio/prompt-library"


def snippet(snippet_id: str = "snip-style", **extra: Any) -> dict[str, Any]:
    return {
        "snippet_id": snippet_id, "title": "風格範例", "text": "合成示例：手繪動畫風格。",
        "category": "風格", "created_at": "2026-10-17T00:00:00.000Z", "updated_at": "2026-10-17T00:00:00.000Z",
        **extra,
    }  # fmt: skip


def library(revision: int, *snippets: dict[str, Any]) -> dict[str, Any]:
    return {"revision": revision, "updated_at": None, "snippets": list(snippets)}


def test_prompt_library_revision_conflict_and_validation(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Harness(tmp_path / "ctl") as h:
            empty = await h.client.get(URL)
            assert empty.status_code == 200
            assert empty.json() == {"revision": 0, "updated_at": None, "snippets": []}
            contracts.validate("StudioPromptLibrary", empty.json())

            created = await h.client.put(URL, json=library(0, snippet()))
            assert created.status_code == 200, created.text
            saved = created.json()
            contracts.validate("StudioPromptLibrary", saved)
            assert saved["revision"] == 1 and saved["updated_at"] is not None and saved["snippets"] == [snippet()]
            assert (await h.client.get(URL)).json() == saved

            stale = await h.client.put(URL, json=library(0, snippet(title="別人的版本")))
            assert stale.status_code == 409 and stale.json()["code"] == "REVISION_CONFLICT"
            assert stale.json()["details"] == {"stored_revision": 1, "expected_revision": 0}

            duplicate = await h.client.put(URL, json=library(1, snippet(), snippet(title="同 ID")))
            assert duplicate.status_code == 422 and duplicate.json()["code"] == "INVALID_ARGUMENT"
            assert duplicate.json()["details"]["duplicate_snippet_ids"] == ["snip-style"]
            invalid = await h.client.put(URL, json=library(1, snippet(title="")))
            assert invalid.status_code == 422 and invalid.json()["code"] == "INVALID_ARGUMENT"
            not_object = await h.client.put(URL, json=[snippet()])
            assert not_object.status_code == 422 and not_object.json()["code"] == "INVALID_ARGUMENT"
            assert (await h.client.get(URL)).json() == saved  # 被拒絕的寫入不改變已保存的文件

            cleared = await h.client.put(URL, json={**saved, "snippets": []})
            assert cleared.status_code == 200 and cleared.json()["revision"] == 2

            # 片段庫與 Studio 專案同目錄，但不會出現在專案列表、也不可能和專案撞名
            stored = h.config.data_dir / "config" / "studio" / "_prompt-library.json"
            assert stored.is_file()
            assert (await h.client.get("/api/studio/projects")).json() == {"items": []}

            stored.write_text("{not json", encoding="utf-8")
            broken = await h.client.get(URL)
            assert broken.status_code == 500 and broken.json()["code"] == "RUNTIME_ERROR"

    asyncio.run(scenario())
