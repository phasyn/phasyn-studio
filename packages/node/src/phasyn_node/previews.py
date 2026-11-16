"""一次 invoke 內的中間預覽（x-phasyn-extension；非最終結果）。

- 元件程序經 ``PHASYN_PREVIEW_FD`` 指定的獨立 pipe 寫入：一行 JSON header（size_bytes、sha256 …）後緊接
  原始影像 bytes。Node 在背景執行緒讀取、驗證（格式、範圍、大小 ≤ 2 MiB、SHA-256），不阻塞 event loop。
- 每個 active call 只保留最新的一張（記憶體，``ActiveCall.preview``）；呼叫結束（run_call 收尾）即刪除——
  最終輸出才是結果。呼叫已有結果（run_done 已記錄）之後送到的預覽一律丟棄。
- ``GET /api/components/{id}/calls/{call_id}/preview`` 回傳這張影像；沒有 → 404 PREVIEW_NOT_FOUND。
- 呼叫帶 run_id／step_id 時，best-effort 通知主控（只有中繼資料，不含影像）：每個呼叫同時最多一個
  POST，送的永遠是當下最新的一張；失敗只記 log、不重送同一張（下一張預覽會再通知）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, BinaryIO
from urllib.parse import quote

import httpx
from phasyn_components.errors import ComponentError
from phasyn_components.ids import is_uuid
from phasyn_components.preview_pipe import PREVIEW_HEADER_MAX
from phasyn_components.provider import PREVIEW_MAX_BYTES, PREVIEW_MAX_SIDE, PREVIEW_MEDIA_TYPES, PREVIEW_NOTE_MAX
from phasyn_components.timeutil import utc_now

if TYPE_CHECKING:
    from .call import ActiveCall
    from .supervisor import ComponentInstance

log = logging.getLogger("phasyn_node.previews")

NOTICE_TIMEOUT = httpx.Timeout(3.0, connect=1.0)
FAILURE_LOG_INTERVAL_S = 60.0
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_INT = 2**53 - 1

SpawnTask = Callable[..., "asyncio.Task[Any]"]


class PreviewProtocolError(Exception):
    """預覽 pipe 的分框壞掉（header 無法解析或 size_bytes 不合法）：之後的內容無法再對齊。"""


class PreviewRejected(Exception):
    """這一張內容不合格（已完整讀出、分框仍對齊）：丟棄這張，繼續讀下一張。"""


@dataclass(frozen=True)
class NodePreview:
    """Node 保留的一張中間預覽；``at`` 是 Node 收到它的時間（UTC）。"""

    call_id: str
    seq: int
    step: int
    total: int
    media_type: str
    width: int
    height: int
    note: str | None
    size_bytes: int
    sha256: str
    at: str
    data: bytes

    def meta(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "step": self.step,
            "total": self.total,
            "width": self.width,
            "height": self.height,
            "media_type": self.media_type,
            "size_bytes": self.size_bytes,
            "note": self.note,
            "at": self.at,
        }


def _int_field(header: dict[str, Any], name: str, minimum: int, maximum: int) -> int:
    value = header.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise PreviewRejected(f"{name} 不是 {minimum}–{maximum} 的整數：{value!r}")
    return value


def read_preview(src: BinaryIO) -> NodePreview | None:
    """（背景執行緒）讀下一張預覽；EOF（含半張）→ None。分框錯誤 → PreviewProtocolError，內容錯誤 → PreviewRejected。"""
    line = src.readline(PREVIEW_HEADER_MAX + 1)
    if not line:
        return None
    if not line.endswith(b"\n"):
        if len(line) <= PREVIEW_HEADER_MAX:
            return None  # EOF 前的半行：元件程序已結束
        raise PreviewProtocolError(f"預覽 header 超過 {PREVIEW_HEADER_MAX} bytes")
    try:
        header = json.loads(line)
    except ValueError as exc:
        raise PreviewProtocolError(f"預覽 header 不是 JSON：{exc}") from exc
    if not isinstance(header, dict):
        raise PreviewProtocolError("預覽 header 不是 JSON object")
    size = header.get("size_bytes")
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= PREVIEW_MAX_BYTES:
        raise PreviewProtocolError(f"預覽 size_bytes 不合法：{size!r}（上限 {PREVIEW_MAX_BYTES}）")
    data = src.read(size)
    if len(data) != size:
        return None  # 寫到一半元件程序結束
    at = utc_now()
    call_id = header.get("call_id")
    if not is_uuid(call_id):
        raise PreviewRejected(f"call_id 不是 UUID：{call_id!r}")
    total = _int_field(header, "total", 1, _MAX_INT)
    step = _int_field(header, "step", 0, total)
    seq = _int_field(header, "seq", 1, _MAX_INT)
    width = _int_field(header, "width", 1, PREVIEW_MAX_SIDE)
    height = _int_field(header, "height", 1, PREVIEW_MAX_SIDE)
    media_type = header.get("media_type")
    if media_type not in PREVIEW_MEDIA_TYPES:
        raise PreviewRejected(f"media_type 不支援：{media_type!r}")
    note = header.get("note")
    if note is not None and (not isinstance(note, str) or len(note) > PREVIEW_NOTE_MAX):
        raise PreviewRejected("note 必須是 ≤500 字的字串或 null")
    sha = header.get("sha256")
    if not isinstance(sha, str) or not _SHA256_RE.match(sha):
        raise PreviewRejected("sha256 格式錯誤")
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha:
        raise PreviewRejected(f"SHA-256 不符（header {sha[:12]}…，實際 {actual[:12]}…）")
    return NodePreview(
        call_id=str(call_id),
        seq=seq,
        step=step,
        total=total,
        media_type=str(media_type),
        width=width,
        height=height,
        note=note,
        size_bytes=size,
        sha256=sha,
        at=at,
        data=data,
    )


def drain(src: BinaryIO) -> None:
    """分框壞掉後讀到 EOF 丟棄（讓元件程序的寫入不會卡在滿的 pipe）。"""
    while src.read(65536):
        pass


def current_preview(instance: ComponentInstance, call_id: str) -> NodePreview:
    """``call_id`` 已由 require_uuid 轉小寫；InvokeRequest 的 call_id 原樣保存，所以不分大小寫比對。"""
    call = instance.active_call
    preview = call.preview if call is not None and call.call_id.lower() == call_id else None
    if preview is None:
        raise ComponentError(
            "PREVIEW_NOT_FOUND",
            f"元件 {instance.component_id} 的呼叫 {call_id} 目前沒有中間預覽（只在呼叫執行中保留最新一張，呼叫結束即刪除；"
            "最終輸出才是結果）",
            details={"component_id": instance.component_id, "call_id": call_id},
        )
    return preview


def preview_headers(preview: NodePreview) -> dict[str, str]:
    """影像本身之外的中繼資料（ASCII 標頭；note 可能是中文，不放標頭）。"""
    return {
        "Cache-Control": "no-store",
        "ETag": f'"{preview.sha256}"',
        "X-Phasyn-Preview-Seq": str(preview.seq),
        "X-Phasyn-Preview-Step": str(preview.step),
        "X-Phasyn-Preview-Total": str(preview.total),
        "X-Phasyn-Preview-Width": str(preview.width),
        "X-Phasyn-Preview-Height": str(preview.height),
        "X-Phasyn-Preview-At": preview.at,
    }


def notice_body(node_id: str, component_id: str, call_id: str, preview: NodePreview) -> dict[str, Any]:
    """契約 RunStepPreviewNotice（只有中繼資料）。"""
    return {"node_id": node_id, "component_id": component_id, "call_id": call_id, **preview.meta()}


class PreviewNotifier:
    """把「有新預覽」best-effort 通知主控（POST /api/runs/{run_id}/steps/{step_id}/preview）。"""

    def __init__(self, *, node_id: str, controller_url: str, client: httpx.AsyncClient, spawn: SpawnTask) -> None:
        self.node_id = node_id
        self.base_url = controller_url.rstrip("/")
        self._client = client
        self._spawn = spawn
        self.sent = 0
        self.failed = 0
        self._last_failure_log = 0.0

    def published(self, component_id: str, call: ActiveCall) -> None:
        """（event loop）這個呼叫有新預覽：沒有通知在送就開始送；正在送就標記，送完後再送最新的一張。"""
        if not call.run_id or not call.step_id:
            return  # 不是 run 的步驟（例如直接 invoke）：沒有主控狀態可更新
        call.preview_notice_dirty = True
        task = call.preview_notice
        if task is None or task.done():
            call.preview_notice = self._spawn(self._push(component_id, call), name=f"preview-notice-{call.call_id}")

    def discard(self, call: ActiveCall) -> None:
        """呼叫結束：不再通知（主控在步驟結束時自己移除預覽）。"""
        call.preview_notice_dirty = False
        task, call.preview_notice = call.preview_notice, None
        if task is not None and not task.done():
            task.cancel()

    async def _push(self, component_id: str, call: ActiveCall) -> None:
        url = f"{self.base_url}/api/runs/{call.run_id}/steps/{quote(str(call.step_id), safe='')}/preview"
        while call.preview_notice_dirty:
            call.preview_notice_dirty = False
            preview = call.preview
            if preview is None:
                return
            body = notice_body(self.node_id, component_id, call.call_id, preview)
            try:
                response = await self._client.post(url, json=body, timeout=NOTICE_TIMEOUT)
            except httpx.HTTPError as exc:
                self._failed(url, f"{type(exc).__name__}: {exc}")
                continue  # 不重送這一張；送出期間若有更新的預覽才再送
            if response.status_code >= 300:
                self._failed(url, f"HTTP {response.status_code}: {response.text[:200]}")
                continue
            self.sent += 1

    def _failed(self, url: str, reason: str) -> None:
        self.failed += 1
        now = time.monotonic()
        if now - self._last_failure_log >= FAILURE_LOG_INTERVAL_S:
            self._last_failure_log = now
            log.info("中間預覽通知主控失敗（不重送；不影響呼叫）%s：%s", url, reason)


__all__ = [
    "NodePreview",
    "PreviewNotifier",
    "PreviewProtocolError",
    "PreviewRejected",
    "current_preview",
    "drain",
    "notice_body",
    "preview_headers",
    "read_preview",
]
