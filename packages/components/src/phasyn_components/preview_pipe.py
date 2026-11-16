"""The intermediate-preview pipe from a component process to its Node.

``RunContext.publish_preview`` frames go through a dedicated pipe whose FD the Node passes in
``PHASYN_PREVIEW_FD``, never through the control channel, so a large preview cannot hold up
``run_done``, ``cancel_ack`` or ``resolve``. Each record is one JSON header line followed by exactly
``size_bytes`` raw image bytes (no base64). Without the FD, previews are disabled.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from dataclasses import dataclass

from .preview import PreviewFrame
from .recorder import Recorder
from .runtime_env import PREVIEW_FD_ENV
from .timeutil import mono_ns

PREVIEW_HEADER_MAX = 16 * 1024
PREVIEW_END_WAIT_S = 2.0


def encode_preview_header(seq: int, frame: PreviewFrame, sha256: str) -> bytes:
    """預覽 pipe 的一筆＝一行 JSON header，之後緊接 ``size_bytes`` 個原始影像 bytes（不 base64）。"""
    doc = {
        "call_id": frame.call_id,
        "seq": seq,
        "step": frame.step,
        "total": frame.total,
        "media_type": frame.media_type,
        "width": frame.width,
        "height": frame.height,
        "note": frame.note,
        "size_bytes": len(frame.data),
        "sha256": sha256,
    }
    return (json.dumps(doc, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


@dataclass
class _PreviewCall:
    call_id: str
    recorder: Recorder
    seq: int = 0
    accepting: bool = True


class PreviewForwarder:
    """provider 的中間預覽 → Node 的預覽 pipe（一個 runtime 程序一個，背景執行緒寫入）。

    最多一張傳送中＋一張待送：新的預覽取代還沒送出的舊預覽（被取代的計入 ``preview.dropped_count``）；
    ``offer`` 永不阻塞。寫入失敗（Node 已關閉讀端）→ 通道停用，之後都回 False。每張寫完記一筆
    ``preview_published`` log 事件（step、bytes、ms＝publish_preview 到寫完的時間），不記影像本身。
    """

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._cv = threading.Condition()
        self._call: _PreviewCall | None = None
        self._pending: tuple[_PreviewCall, int, PreviewFrame] | None = None
        self._in_flight: tuple[_PreviewCall, int, PreviewFrame] | None = None
        self._broken: str | None = None
        self._closed = False
        self._thread = threading.Thread(target=self._loop, name="preview-forwarder", daemon=True)
        self._thread.start()

    @classmethod
    def from_env(cls) -> PreviewForwarder | None:
        raw = os.environ.pop(PREVIEW_FD_ENV, None)  # 不讓 provider 啟動的子程序看到
        if not raw:
            return None
        try:
            fd = int(raw)
            os.fstat(fd)
        except (ValueError, OSError) as exc:
            print(f"[runtime_host] {PREVIEW_FD_ENV}={raw!r} 無效，中間預覽停用：{exc}", file=sys.stderr, flush=True)
            return None
        return cls(fd)

    @property
    def available(self) -> bool:
        return self._broken is None and not self._closed

    @property
    def busy(self) -> bool:
        """True while a frame is being written to the pipe."""
        with self._cv:
            return self._in_flight is not None

    def begin_call(self, call_id: str, recorder: Recorder) -> None:
        with self._cv:
            self._call = _PreviewCall(call_id, recorder)

    def offer(self, frame: PreviewFrame) -> bool:
        """RunContext 的 preview_sink：放進待送槽（取代未送出的舊預覽）並喚醒寫入執行緒。"""
        with self._cv:
            call = self._call
            if (
                self._closed
                or self._broken is not None
                or call is None
                or not call.accepting
                or frame.call_id != call.call_id
            ):
                return False
            call.seq += 1
            replaced = self._pending
            self._pending = (call, call.seq, frame)
            self._cv.notify_all()
        if replaced is not None:
            replaced[0].recorder.count("preview.dropped_count")
        return True

    def end_call(self, call_id: str, *, timeout: float = PREVIEW_END_WAIT_S) -> None:
        """呼叫結束（送 run_done 之前）：丟掉還沒送出的預覽、等傳送中的那張寫完（有上限），之後不再接受。"""
        deadline = time.monotonic() + timeout
        dropped = None
        with self._cv:
            call = self._call
            if call is None or call.call_id != call_id:
                return
            call.accepting = False
            if self._pending is not None and self._pending[0] is call:
                dropped, self._pending = self._pending, None
            while self._in_flight is not None and self._in_flight[0] is call:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cv.wait(remaining)
            self._call = None
        if dropped is not None:
            call.recorder.count("preview.dropped_count")

    def close(self) -> None:
        """程序結束前：不再接受、丟掉待送；不關 FD（寫入中的執行緒可能還持有，程序結束時一併釋放）。"""
        with self._cv:
            self._closed = True
            self._pending = None
            self._cv.notify_all()

    def _write(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            written = os.write(self._fd, view)
            view = view[written:]

    def _loop(self) -> None:
        while True:
            with self._cv:
                while self._pending is None and not self._closed:
                    self._cv.wait()
                if self._closed:
                    return
                item = self._pending
                assert item is not None
                self._pending = None
                self._in_flight = item
            call, seq, frame = item
            started = mono_ns()
            error: str | None = None
            try:
                header = encode_preview_header(seq, frame, hashlib.sha256(frame.data).hexdigest())
                self._write(header)
                self._write(frame.data)
            except (OSError, ValueError) as exc:
                error = f"{type(exc).__name__}: {exc}"
            finished = mono_ns()
            # 先記帳再釋放傳送槽：end_call 等到槽空才返回，之後 recorder 才會 finalize
            rec = call.recorder
            if error is None:
                rec.count("preview.published_count")
                rec.count("preview.published_bytes", len(frame.data))
                rec.log(
                    "info",
                    "preview_published",
                    step=frame.step,
                    total=frame.total,
                    bytes=len(frame.data),
                    ms=round((finished - frame.published_ns) / 1e6, 3),
                    write_ms=round((finished - started) / 1e6, 3),
                    seq=seq,
                    media_type=frame.media_type,
                    width=frame.width,
                    height=frame.height,
                )
            else:
                message = f"中間預覽通道寫入失敗，這個程序之後的預覽都會被丟棄：{error}"
                rec.count("preview.dropped_count")
                rec.log("warning", message, preview_seq=seq)
                rec.note(message)
            with self._cv:
                self._in_flight = None
                if error is not None and self._broken is None:
                    self._broken = error
                self._cv.notify_all()
            if error is not None:
                return


__all__ = ["PREVIEW_END_WAIT_S", "PREVIEW_HEADER_MAX", "PreviewForwarder", "encode_preview_header"]
