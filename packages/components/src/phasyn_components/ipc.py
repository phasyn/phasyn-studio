"""Node ↔ 元件程序的本機協定.

- 控制通道：stdin/stdout 上的 JSON lines，訊息 hello、load、load_done、invoke、run_done、
  cancel、cancel_ack、unload、bye、error。命令用參數陣列與明確 provider entrypoint，沒有 shell/eval。
- telemetry 通道：獨立 pipe FD，recorder 事件提示（有界、可丟、不阻塞運算）。大量 log 不會
  堵住 cancel／hello。
"""

from __future__ import annotations

import collections
import json
import os
import threading
from typing import Any, BinaryIO


MAX_MESSAGE_BYTES = 32 * 1024 * 1024
TELEMETRY_WRITE_BATCH = 256
TELEMETRY_QUEUE_EVENTS = 8192
TELEMETRY_QUEUE_BYTES = 16 * 1024 * 1024

CONTROL_TYPES = frozenset(
    {
        "hello",
        "load",
        "load_done",
        "invoke",
        "run_done",
        "cancel",
        "cancel_ack",
        "unload",
        "bye",
        "error",
        "ping",
        "pong",
        "resolve",
        "resolved",
    }
)


def encode(message: dict[str, Any]) -> bytes:
    """Encode a control message for the runtime stream."""
    if message.get("type") not in CONTROL_TYPES:
        raise ValueError(f"unknown message type {message.get('type')!r}")
    data = (
        json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        raise ValueError(f"message too large ({len(data)} bytes)")
    return data


def decode(line: bytes) -> dict[str, Any]:
    """Decode a control message from the runtime stream."""
    if len(line) > MAX_MESSAGE_BYTES:
        raise ValueError("message too large")
    doc = json.loads(line.decode("utf-8"))
    if not isinstance(doc, dict) or doc.get("type") not in CONTROL_TYPES:
        raise ValueError("invalid control message")
    return doc


class ControlWriter:
    """多執行緒共用的控制通道寫端."""

    def __init__(self, stream: BinaryIO) -> None:
        """Initialize control writer with its configuration."""
        self._stream = stream
        self._lock = threading.Lock()
        self.broken = False

    def send(self, message: dict[str, Any]) -> bool:
        """Send the message through the owned channel."""
        data = encode(message)
        with self._lock:
            if self.broken:
                return False
            try:
                self._stream.write(data)
                self._stream.flush()
            except (BrokenPipeError, OSError, ValueError):
                self.broken = True
                return False
            return True


class TelemetryPipe:
    """元件程序端：把 recorder record 有界、非阻塞地送到 telemetry FD。滿了就丟並計數."""

    def __init__(self, fd: int | None) -> None:
        """Initialize telemetry pipe with its configuration."""
        self._fd = fd
        self._queue: collections.deque[bytes] = collections.deque()
        self._bytes = 0
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self.dropped = 0
        self.sent_bytes = 0
        self._closed = False
        self._thread: threading.Thread | None = None
        if fd is not None:
            self._thread = threading.Thread(
                target=self._loop, name="telemetry-pipe", daemon=True
            )
            self._thread.start()

    def publish(self, record: dict[str, Any]) -> bool:
        """Queue the record for publication."""
        if self._fd is None or self._closed:
            return False
        try:
            line = (
                json.dumps(
                    record, ensure_ascii=False, allow_nan=False, separators=(",", ":")
                )
                + "\n"
            ).encode("utf-8")
        except (TypeError, ValueError):
            return False
        with self._cv:
            if (
                len(self._queue) >= TELEMETRY_QUEUE_EVENTS
                or self._bytes + len(line) > TELEMETRY_QUEUE_BYTES
            ):
                self.dropped += 1
                return False
            self._queue.append(line)
            self._bytes += len(line)
            self._cv.notify()
        return True

    def _loop(self) -> None:
        if self._fd is None:
            return
        while True:
            with self._cv:
                while not self._queue and not self._closed:
                    self._cv.wait(timeout=0.5)
                if not self._queue and self._closed:
                    return
                chunk: list[bytes] = []
                while self._queue and len(chunk) < TELEMETRY_WRITE_BATCH:
                    line = self._queue.popleft()
                    self._bytes -= len(line)
                    chunk.append(line)
            data = b"".join(chunk)
            try:
                view = memoryview(data)
                while view:
                    n = os.write(self._fd, view)
                    view = view[n:]
                self.sent_bytes += len(data)
            except OSError:
                with self._lock:
                    self.dropped += len(chunk)
                    self._closed = True
                return

    def close(self, timeout: float = 2.0) -> None:
        """Release the owned resources."""
        with self._cv:
            self._closed = True
            self._cv.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=timeout)


__all__ = [
    "CONTROL_TYPES",
    "MAX_MESSAGE_BYTES",
    "ControlWriter",
    "TelemetryPipe",
    "decode",
    "encode",
]
