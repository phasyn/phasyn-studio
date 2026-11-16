"""固定 Prompt 片段庫（x-phasyn-extension）：``data_dir/config/studio/_prompt-library.json``。

整個片段庫是一份文件（contract ``StudioPromptLibrary``），所有專案共用。保存以 revision 做樂觀並行控制：
PUT 本文的 revision 必須等於目前 revision（從未保存過為 0），成功後 revision+1 並更新 updated_at；
不符回 409 REVISION_CONFLICT，不自動合併、不覆寫別人的變更，也不重試（由前端重新載入後讓使用者決定）。

檔名以底線開頭：不是合法的本地 ID，所以不會和 Studio 專案 ``<project_id>.json`` 撞名，也不會出現在
專案列表（StudioStore 只讀檔名是本地 ID 的文件）。
"""

from __future__ import annotations

import asyncio
import threading
from collections import Counter
from collections.abc import Iterable
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

from .revisions import require_revision, stored_revision

if TYPE_CHECKING:
    from .state import Controller

LIBRARY_FILE = "_prompt-library.json"
SCHEMA = "StudioPromptLibrary"


def empty_library() -> dict[str, Any]:
    """從未保存過的片段庫（revision 0）。"""
    return {"revision": 0, "updated_at": None, "snippets": []}


def duplicate_snippet_ids(snippets: Iterable[dict[str, Any]]) -> list[str]:
    counts = Counter(str(item["snippet_id"]) for item in snippets)
    return sorted(snippet_id for snippet_id, count in counts.items() if count > 1)


class PromptLibraryStore:
    """單一 JSON 文件；revision 檢查與寫入在同一把鎖內完成（單一主控程序是唯一 writer）。"""

    def __init__(self, root: Path) -> None:
        self.path = Path(root) / LIBRARY_FILE
        self._lock = threading.Lock()

    def _stored(self) -> dict[str, Any] | None:
        try:
            doc = read_json(self.path)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise ComponentError("RUNTIME_ERROR", f"固定 Prompt 片段庫無法讀取：{exception_message(exc)}") from exc
        contracts.validate(SCHEMA, doc, code="RUNTIME_ERROR", what=f"已保存的固定 Prompt 片段庫（{self.path.name}）")
        return dict(doc)

    def get(self) -> dict[str, Any]:
        stored = self._stored()
        return stored if stored is not None else empty_library()

    def put(self, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ComponentError("INVALID_ARGUMENT", "固定 Prompt 片段庫必須是 JSON object")
        contracts.validate(SCHEMA, body, what="固定 Prompt 片段庫")
        duplicates = duplicate_snippet_ids(body["snippets"])
        if duplicates:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"snippet_id 重複：{', '.join(duplicates)}",
                details={"duplicate_snippet_ids": duplicates},
            )
        with self._lock:
            revision = require_revision(
                stored_revision(self._stored()),
                body["revision"],
                what="固定 Prompt 片段庫",
                suffix="請重新載入後再修改",
            )
            doc = {"revision": revision + 1, "updated_at": utc_now(), "snippets": body["snippets"]}
            atomic_write_json(self.path, doc)
        return doc


def routes(ctl: Controller) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/prompt-library")
    async def get_prompt_library() -> JSONResponse:
        return web.json_response(await asyncio.to_thread(ctl.prompt_library.get))

    @router.put("/api/studio/prompt-library")
    async def put_prompt_library(request: Request) -> JSONResponse:
        body = await web.read_json(request, what="固定 Prompt 片段庫")
        return web.json_response(await asyncio.to_thread(ctl.prompt_library.put, body))

    return router


__all__ = ["LIBRARY_FILE", "PromptLibraryStore", "duplicate_snippet_ids", "empty_library", "routes"]
