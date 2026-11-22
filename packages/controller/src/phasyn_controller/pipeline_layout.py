"""元件組合的分類與排序（x-phasyn-extension）：``data_dir/config/pipeline-layout.json``.

整份是一份文件（contract ``PipelineLayout``）：groups（分類，依序；每個分類的 pipeline_ids 依序）+ ungrouped（未分類，依序）。
只決定顯示順序，不修改任何 Pipeline；GET /api/pipelines 依這個順序列出，所以左欄、清單、Studio 的運算路由與推理頁
都跟著使用者排的順序，不需要各自排序。

- GET 依目前已保存的元件組合正規化，但不寫回：略過已刪除的元件組合，沒有列到的元件組合依 pipeline_id 接在
  ungrouped 最後。檔案不存在=revision 0、沒有分類、全部依 pipeline_id 排在 ungrouped。
- PUT 以 revision 做樂觀並行控制（與固定 Prompt 片段庫相同）：本文 revision 必須等於目前 revision，成功後 revision+1
  並更新 updated_at；不符回 409 REVISION_CONFLICT，不自動合併、不覆寫別人的變更、也不重試。名稱、重複或不是已保存
  元件組合的 pipeline_id 回 422 INVALID_ARGUMENT。保存的是正規化後的文件（與回應相同）。
- 刪除元件組合不需要改這份文件：讀取時正規化就會略過它。

檔案在 ``config/``，不在 ``config/pipelines/`` 裡，所以不會被當成元件組合列出。
"""

from __future__ import annotations

import asyncio
import logging
import threading
import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Request
from phasyn_components import contracts
from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json
from phasyn_components.timeutil import utc_now
from phasyn_server import http as web
from starlette.responses import JSONResponse

from .docstore import JsonDocStore
from .revisions import require_revision, stored_revision


if TYPE_CHECKING:
    from .state import Controller

log = logging.getLogger("phasyn_controller.pipeline_layout")

LAYOUT_FILE = "pipeline-layout.json"
SCHEMA = "PipelineLayout"
WHAT = "元件組合分類與排序"


def empty_layout() -> dict[str, Any]:
    """從未保存過的分類與排序（revision 0，沒有分類；正規化後全部元件組合依 ID 排在 ungrouped）."""
    return {"revision": 0, "updated_at": None, "groups": [], "ungrouped": []}


def layout_order(doc: Mapping[str, Any]) -> list[str]:
    """顯示順序：分類依序（組內依序），然後 ungrouped."""
    out: list[str] = []
    for group in doc["groups"]:
        out.extend(str(pid) for pid in group["pipeline_ids"])
    out.extend(str(pid) for pid in doc["ungrouped"])
    return out


def normalize_layout(
    doc: Mapping[str, Any], pipeline_ids: Iterable[str]
) -> dict[str, Any]:
    """依目前已保存的元件組合正規化（revision/updated_at 不變）.

    略過不存在的 pipeline_id 與重複出現的 pipeline_id（保留第一次出現的位置）；沒有列到的元件組合依 ID 排序後
    接在 ungrouped 最後。分類（即使是空的）一律保留。
    """
    known = set(pipeline_ids)
    seen: set[str] = set()

    def keep(ids: Iterable[Any]) -> list[str]:
        kept: list[str] = []
        for raw in ids:
            pid = str(raw)
            if pid in known and pid not in seen:
                seen.add(pid)
                kept.append(pid)
        return kept

    groups = [
        {
            "group_id": group["group_id"],
            "name": group["name"],
            "pipeline_ids": keep(group["pipeline_ids"]),
        }
        for group in doc["groups"]
    ]
    ungrouped = keep(doc["ungrouped"])
    ungrouped.extend(sorted(known - seen))
    return {
        "revision": doc["revision"],
        "updated_at": doc["updated_at"],
        "groups": groups,
        "ungrouped": ungrouped,
    }


def _duplicates(values: Iterable[str]) -> list[str]:
    """重複出現的值（依第一次出現的順序）."""
    counts = Counter(values)
    return [value for value, count in counts.items() if count > 1]


def check_layout(body: Mapping[str, Any]) -> None:
    """契約以外的規則（契約已檢查型別、長度與 local ID 格式）.

    分類名稱：不能有前後空白、換行或控制字元，不分大小寫不可重複；group_id 不可重複；每個 pipeline_id 在
    groups 與 ungrouped 中最多出現一次。
    """
    for group in body["groups"]:
        name = str(group["name"])
        if name != name.strip():
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"分類名稱前後不能有空白：{name!r}",
                details={"group_id": group["group_id"], "field": "name"},
            )
        if any(unicodedata.category(char) in ("Cc", "Zl", "Zp") for char in name):
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"分類名稱不能包含換行或控制字元：{name!r}",
                details={"group_id": group["group_id"], "field": "name"},
            )
    names = _duplicates(str(group["name"]).lower() for group in body["groups"])
    if names:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"分類名稱重複（不分大小寫）：{'、'.join(names)}",
            details={"duplicate_group_names": names},
        )
    group_ids = _duplicates(str(group["group_id"]) for group in body["groups"])
    if group_ids:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"group_id 重複：{', '.join(group_ids)}",
            details={"duplicate_group_ids": group_ids},
        )
    pipeline_ids = _duplicates(layout_order(body))
    if pipeline_ids:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"同一個元件組合只能出現一次：{', '.join(pipeline_ids)}",
            details={"duplicate_pipeline_ids": pipeline_ids},
        )


class PipelineLayoutStore:
    """單一 JSON 文件；revision 檢查、pipeline_id 檢查與寫入在同一把鎖內完成（單一主控程序是唯一 writer）."""

    def __init__(self, root: Path, pipelines: JsonDocStore) -> None:
        """Set the local path for the saved pipeline folder layout."""
        self.path = Path(root) / LAYOUT_FILE
        self.pipelines = pipelines
        self._lock = threading.Lock()

    def _stored(self) -> dict[str, Any] | None:
        try:
            doc = read_json(self.path)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "RUNTIME_ERROR", f"{WHAT}無法讀取：{exception_message(exc)}"
            ) from exc
        contracts.validate(
            SCHEMA,
            doc,
            code="RUNTIME_ERROR",
            what=f"已保存的{WHAT}（{self.path.name}）",
        )
        return dict(doc)

    def _pipeline_ids(self) -> list[str]:
        return [str(doc["pipeline_id"]) for doc in self.pipelines.list()]

    def get(self, pipeline_ids: Iterable[str] | None = None) -> dict[str, Any]:
        """正規化後的分類與排序（不寫回）."""
        ids = list(pipeline_ids) if pipeline_ids is not None else self._pipeline_ids()
        return normalize_layout(self._stored() or empty_layout(), ids)

    def order(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """GET /api/pipelines 的順序。分類檔損毀時記 log 並退回依 ID 排序：清單本身仍可用（錯誤由 GET 分類 API 呈現）."""
        by_id = {str(item["pipeline_id"]): item for item in items}
        try:
            layout = self.get(list(by_id))
        except ComponentError as exc:
            log.warning("%s無法使用，元件組合依 ID 排序：%s", WHAT, exc.message)
            layout = normalize_layout(empty_layout(), by_id)
        return [by_id[pid] for pid in layout_order(layout)]

    def put(self, body: Any) -> dict[str, Any]:
        """Validate and save the pipeline folder layout."""
        if not isinstance(body, dict):
            raise ComponentError("INVALID_ARGUMENT", f"{WHAT}必須是 JSON object")
        contracts.validate(SCHEMA, body, what=WHAT)
        check_layout(body)
        with self._lock:
            revision = require_revision(
                stored_revision(self._stored()),
                body["revision"],
                what=WHAT,
                suffix="請重新載入後再修改",
            )
            ids = self._pipeline_ids()
            known = set(ids)
            unknown = list(
                dict.fromkeys(pid for pid in layout_order(body) if pid not in known)
            )
            if unknown:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"不是已保存的元件組合（可能已被刪除）：{', '.join(unknown)}",
                    details={"unknown_pipeline_ids": unknown},
                )
            doc = normalize_layout(
                {**body, "revision": revision + 1, "updated_at": utc_now()}, ids
            )
            atomic_write_json(self.path, doc)
        return doc


def routes(ctl: Controller) -> APIRouter:
    """Build the Controller routes for pipeline layout."""
    router = APIRouter()

    @router.get("/api/pipeline-layout")
    async def get_pipeline_layout() -> JSONResponse:
        return web.json_response(await asyncio.to_thread(ctl.pipeline_layout.get))

    @router.put("/api/pipeline-layout")
    async def put_pipeline_layout(request: Request) -> JSONResponse:
        body = await web.read_json(request, what=WHAT)
        return web.json_response(await asyncio.to_thread(ctl.pipeline_layout.put, body))

    return router


__all__ = [
    "LAYOUT_FILE",
    "PipelineLayoutStore",
    "check_layout",
    "empty_layout",
    "layout_order",
    "normalize_layout",
    "routes",
]
