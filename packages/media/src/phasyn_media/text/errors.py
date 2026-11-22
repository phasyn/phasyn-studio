"""The error of the text renderer as the rest of the product sees it (parent side).

The worker and the validation only know stable reasons (``model.TextFailure``); the user-facing
messages and the media error codes are decided here. A message is a fixed Traditional Chinese
text; what varies (a code point, a field, an exit status) travels in ``detail`` and ``actual``
and never contains a path.
"""

from __future__ import annotations

from ..errors import MediaError
from .model import TextFailure


_MESSAGES = {
    "text_renderer_unavailable": "這台主機無法排版文字（需要系統的 FreeType、HarfBuzz 與 Fontconfig 函式庫）",
    "text_font_missing": "這台主機沒有可以用來排版文字的字型",
    "text_direction_unsupported": "文字含有由右至左書寫的內容，匯出目前無法排版",
    "text_too_large": "文字圖層超過上限（數量、字數、畫面尺寸或輸出大小）",
    "text_render_failed": "文字圖層產生失敗",
}
# Reasons the user can act on by changing the text or the sequence; the others are the host's or the tool's.
_INPUT_REASONS = frozenset({"text_direction_unsupported", "text_too_large"})
_INVALID_ARGUMENT = "INVALID_ARGUMENT"
_TOOL_FAILED = "MEDIA_TOOL_FAILED"


class TextRenderError(MediaError):
    """A text item could not be rendered.

    ``reason`` is one of ``text_renderer_unavailable``, ``text_font_missing``,
    ``text_direction_unsupported``, ``text_too_large`` and ``text_render_failed``; ``job_id`` names
    the title or caption track job when the failure belongs to one and ``item`` the caption event
    inside a track job; ``detail`` is a short diagnostic (also available as ``actual``). ``code`` is
    ``INVALID_ARGUMENT`` when the request is at fault and ``MEDIA_TOOL_FAILED`` otherwise; only a
    failed run (``text_render_failed``) may succeed when tried again.
    """

    def __init__(
        self,
        reason: str,
        *,
        job_id: str | None = None,
        item: int | None = None,
        detail: str | None = None,
        invalid_request: bool = False,
    ) -> None:
        """Store the text-rendering diagnostic and its cause."""
        if reason not in _MESSAGES:
            raise ValueError(f"unknown text failure reason: {reason}")
        code = (
            _INVALID_ARGUMENT
            if invalid_request or reason in _INPUT_REASONS
            else _TOOL_FAILED
        )
        retryable = reason == "text_render_failed" and code == _TOOL_FAILED
        super().__init__(code, _MESSAGES[reason], retryable=retryable, actual=detail)
        self.reason = reason
        self.job_id = job_id
        self.item = item
        self.detail = detail

    @classmethod
    def from_failure(
        cls, failure: TextFailure, *, invalid_request: bool = False
    ) -> TextRenderError:
        """Translate a text rendering failure into a component error."""
        return cls(
            failure.reason,
            job_id=failure.job_id,
            item=failure.item,
            detail=failure.detail,
            invalid_request=invalid_request,
        )
