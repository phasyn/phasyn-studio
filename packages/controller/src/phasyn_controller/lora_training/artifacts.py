"""Small JSON artifacts of a training job: read from the Node that produced them, written to the Controller.

Reads are bounded and verified (size and SHA-256 of the FileRef) before parsing; nothing else is fetched. The
documents the Controller writes (the encodings list the trainer reads) live in the Controller's own file
store, where every Node can download them like an upload.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import httpx
from phasyn_components.errors import ComponentError


if TYPE_CHECKING:
    from ..state import Controller

MAX_JSON_BYTES = 64 * 1024 * 1024
READ_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0)


def _check(ref: Mapping[str, Any], data: bytes) -> None:
    if len(data) != int(ref.get("size_bytes") or -1) or hashlib.sha256(
        data
    ).hexdigest() != ref.get("sha256"):
        raise ComponentError(
            "FILE_HASH_MISMATCH", "訓練資料檔的大小或 SHA-256 與紀錄不同"
        )


async def read_json(ctl: Controller, ref: Mapping[str, Any]) -> Any:
    """The parsed JSON document of a FileRef (Controller-local or on a Node)."""
    size = int(ref.get("size_bytes") or 0)
    if size > MAX_JSON_BYTES:
        raise ComponentError("INPUT_TOO_LARGE", "訓練資料檔太大")
    node_id, file_id = str(ref["node_id"]), str(ref["file_id"])
    if node_id == ctl.instance_id:
        data = await asyncio.to_thread(ctl.files.payload_path(file_id).read_bytes)
    else:
        endpoint = ctl.catalog.endpoint_for_read(node_id)
        try:
            resp = await ctl.http.get(
                f"{endpoint}/api/files/{file_id}", timeout=READ_TIMEOUT
            )
        except httpx.HTTPError as exc:
            raise ComponentError(
                "NODE_UNREACHABLE",
                "無法從 Node 讀取訓練資料檔",
                details={"node_id": node_id},
            ) from exc
        if resp.status_code != httpx.codes.OK:
            raise ComponentError(
                "FILE_NOT_FOUND",
                "Node 上找不到訓練資料檔",
                details={"node_id": node_id},
            )
        data = resp.content
    _check(ref, data)
    return json.loads(data)


def write_json(
    ctl: Controller,
    doc: Any,
    *,
    media_type: str = "application/json",
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Publish a JSON document in the Controller's file store and return its FileRef."""
    data = json.dumps(doc, ensure_ascii=False, allow_nan=False).encode("utf-8")
    writer = ctl.files.new_writer(media_type, dict(meta or {}))
    try:
        writer.write(data)
        return writer.commit(expected_size=len(data))
    except BaseException:
        writer.abort()
        raise


__all__ = ["read_json", "write_json"]
