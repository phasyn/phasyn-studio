"""以本地 ID 為檔名的 JSON 文件（pipeline 草稿、preset、Studio 專案）。單一 writer、原子替換。"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import is_local_id, require_local_id

log = logging.getLogger("phasyn_controller.docstore")


class JsonDocStore:
    def __init__(self, root: Path, *, id_field: str, what: str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.id_field = id_field
        self.what = what

    def path(self, doc_id: str) -> Path:
        return self.root / f"{require_local_id(doc_id, self.id_field)}.json"

    def list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for entry in sorted(self.root.glob("*.json")):
            if not is_local_id(entry.stem):
                continue
            try:
                doc = read_json(entry)
            except (OSError, ValueError) as exc:
                log.warning("略過無法讀取的%s %s：%s", self.what, entry.name, exc)
                continue
            if isinstance(doc, dict) and doc.get(self.id_field) == entry.stem:
                out.append(doc)
        return out

    def get(self, doc_id: str) -> dict[str, Any]:
        path = self.path(doc_id)
        try:
            doc = read_json(path)
        except FileNotFoundError as exc:
            raise ComponentError("NOT_FOUND", f"找不到{self.what} {doc_id}", details={self.id_field: doc_id}) from exc
        except (OSError, ValueError) as exc:
            raise ComponentError("RUNTIME_ERROR", f"{self.what} {doc_id} 無法讀取：{exception_message(exc)}") from exc
        if not isinstance(doc, dict):
            raise ComponentError("RUNTIME_ERROR", f"{self.what} {doc_id} 內容不是 JSON object")
        return doc

    def put(self, doc_id: str, doc: dict[str, Any]) -> dict[str, Any]:
        atomic_write_json(self.path(doc_id), doc)
        return doc

    def delete(self, doc_id: str) -> bool:
        """刪除文件檔；不存在 → False。"""
        try:
            self.path(doc_id).unlink()
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise ComponentError("RUNTIME_ERROR", f"{self.what} {doc_id} 無法刪除：{exception_message(exc)}") from exc
        return True


__all__ = ["JsonDocStore"]
