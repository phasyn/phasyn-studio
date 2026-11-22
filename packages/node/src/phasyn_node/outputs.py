"""Publishing the output files of a call, and taking them back when the call will not report them.

A runtime reserves its output files (``.part``) and reports them in ``run_done``; the Node publishes them only
for a call that succeeded within its deadline. A publish that fails halfway, or that finishes after the
deadline, is withdrawn, so no published file stays visible without a reference.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.typed import check_typed_value


log = logging.getLogger("phasyn_node.invoke")


def publish_outputs(
    store: FileStore, done: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    """（在執行緒內）發布 run_done.files 的每個待發布檔，並把 pending_file 換成 FileRef."""
    published: dict[str, dict[str, Any]] = {}

    def publish(pending: Mapping[str, Any]) -> dict[str, Any]:
        file_id = str(pending["file_id"])
        if file_id not in published:
            if pending.get("sha256") is None:
                raise ComponentError(
                    "RUNTIME_ERROR",
                    f"元件程序回報的輸出檔 {file_id} 沒有 SHA-256（尚未完成寫入）",
                )
            published[file_id] = store.publish_reserved(
                file_id,
                media_type=str(pending.get("media_type") or "application/octet-stream"),
                metadata=dict(pending.get("metadata") or {}),
                size=int(pending["size_bytes"]),
                sha256=str(pending["sha256"]),
            )
        return published[file_id]

    for pending in done.get("files") or []:
        publish(pending)
    outputs: dict[str, dict[str, Any]] = {}
    for port, item in (done.get("outputs") or {}).items():
        if not isinstance(item, Mapping):
            raise ComponentError("RUNTIME_ERROR", f"元件程序回報的輸出 {port} 格式錯誤")
        if "pending_file" in item:
            value: dict[str, Any] = {
                "type_id": item["type_id"],
                "file": publish(item["pending_file"]),
            }
        else:
            value = {"type_id": item["type_id"], "value": item.get("value")}
        check_typed_value(value, where=f"輸出 {port}")
        outputs[str(port)] = value
    return outputs


def withdraw_outputs(store: FileStore, done: Mapping[str, Any] | None) -> None:
    """(thread) Remove every output file of a call that will not report them.

    Reserved ``.part`` files are discarded; files already published (a publish that failed halfway or finished
    after the call's deadline) are deleted, so nothing stays visible without a reference.
    """
    for pending in (done or {}).get("files") or []:
        file_id = str(pending.get("file_id"))
        try:
            if store.meta(file_id) is not None:
                store.delete(file_id)
            else:
                store.discard_reserved(file_id)
        except (ComponentError, OSError):
            log.warning("無法清除呼叫未採用的輸出檔 %s", file_id, exc_info=True)


def publish_or_withdraw(
    store: FileStore, done: Mapping[str, Any]
) -> dict[str, dict[str, Any]]:
    """(thread) ``publish_outputs``; when it fails partway the files published so far are withdrawn."""
    try:
        return publish_outputs(store, done)
    except BaseException:
        withdraw_outputs(store, done)
        raise


__all__ = ["publish_or_withdraw", "publish_outputs", "withdraw_outputs"]
