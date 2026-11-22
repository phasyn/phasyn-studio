"""Bounded event queues and the background writer thread of one recording stream.

The model thread only serialises an event and appends it to a bounded queue; it never waits for
I/O. Critical events (errors, settings, lifecycle) have their own bounded queue, so they survive a
flood of detail events. A daemon writer thread appends batches to the local JSONL segments (the
authority), then offers them to the publisher best-effort. Every dropped event is counted and its
``seq`` remembered as a missing range.

The writer thread owns the sink once it has started: it closes the segment file itself after the
last batch, so :meth:`EventWriter.close` returning on a timeout never closes the file under a write
that is still running.
"""

from __future__ import annotations

import collections
import json
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .sink import RecordingSink


CRITICAL_QUEUE_EVENTS = 2048
CRITICAL_QUEUE_BYTES = 8 * 1024 * 1024
MAX_MISSING_RANGES = 64
BATCH_EVENTS = 512
MAX_NOTES = 50

Publisher = Callable[[dict[str, Any]], bool]


def json_line(obj: Mapping[str, Any]) -> bytes:
    """Encode one complete JSONL record."""
    return (
        json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


@dataclass(frozen=True)
class WriterStats:
    """What the summary needs to know about the queue and the writer."""

    dropped_events: int
    dropped_bytes: int
    missing: tuple[tuple[int, int], ...]
    written_bytes: int
    publisher_bytes: int
    publisher_dropped: int
    recorder_ns: int
    serialization_errors: int
    degraded_reason: str | None
    detail_truncated: bool
    notes: tuple[str, ...]


class EventWriter:
    """Queue and drain recording events to local storage."""

    def __init__(  # noqa: PLR0913 - Keep the published positional and keyword API.
        self,
        *,
        sink: RecordingSink | None,
        publish: Publisher | None,
        stream_id: str,
        queue_max_events: int,
        queue_max_bytes: int,
        max_detail_bytes: int,
        degraded_reason: str | None = None,
    ) -> None:
        """Initialize event writer with its configuration."""
        self._sink = sink
        self._publish = publish
        self._stream_id = stream_id
        self._queue_max_events = queue_max_events
        self._queue_max_bytes = queue_max_bytes
        self.max_detail_bytes = max_detail_bytes
        self._cv = threading.Condition()
        self._seq = 0
        self._detail: collections.deque[tuple[bytes, dict[str, Any]]] = (
            collections.deque()
        )
        self._critical: collections.deque[tuple[bytes, dict[str, Any]]] = (
            collections.deque()
        )
        self._detail_q_bytes = 0
        self._critical_q_bytes = 0
        self._detail_bytes = 0
        self._detail_truncated = False
        self._degraded_reason = degraded_reason
        self._dropped_events = 0
        self._dropped_bytes = 0
        self._missing: list[list[int]] = []
        self._written_bytes = 0
        self._publisher_bytes = 0
        self._publisher_dropped = 0
        self._recorder_ns = 0
        self._serialization_errors = 0
        self._notes: list[str] = []
        self._closing = False
        self._closed = False
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ producer side
    @property
    def has_publisher(self) -> bool:
        """Report whether a downstream publisher is configured."""
        return self._publish is not None

    @property
    def degraded_reason(self) -> str | None:
        """Return the reason recording is degraded."""
        with self._cv:
            return self._degraded_reason

    def degrade(self, reason: str) -> None:
        """Mark the writer as degraded."""
        with self._cv:
            if self._degraded_reason is None:
                self._degraded_reason = reason

    def enqueue(
        self, event: dict[str, Any], *, critical: bool, started_ns: int | None = None
    ) -> int | None:
        """Assign the next ``seq``, serialise and queue the event (or count it as dropped).

        ``started_ns`` (``time.perf_counter_ns()``) lets the caller's own preparation count as recorder time.
        """
        t0 = time.perf_counter_ns() if started_ns is None else started_ns
        with self._cv:
            if self._closed:
                return None
            self._seq += 1
            seq = self._seq
            event["seq"] = seq
            try:
                line = json_line(event)
            except (TypeError, ValueError) as exc:
                self._serialization_errors += 1
                self._record_missing(seq)
                self._note(f"事件無法序列化（{event.get('kind')}）：{exc}")
                self._recorder_ns += time.perf_counter_ns() - t0
                return None
            size = len(line)
            if critical:
                if (
                    len(self._critical) >= CRITICAL_QUEUE_EVENTS
                    or self._critical_q_bytes + size > CRITICAL_QUEUE_BYTES
                ):
                    self._drop(seq, size)
                    self._degraded_reason = self._degraded_reason or "critical 佇列已滿"
                else:
                    self._critical.append((line, event))
                    self._critical_q_bytes += size
            elif self._detail_truncated:
                self._drop(seq, size)
            elif self._detail_bytes + size > self.max_detail_bytes:
                self._detail_truncated = True
                self._drop(seq, size)
            elif (
                len(self._detail) >= self._queue_max_events
                or self._detail_q_bytes + size > self._queue_max_bytes
            ):
                self._drop(seq, size)
            else:
                self._detail.append((line, event))
                self._detail_q_bytes += size
                self._detail_bytes += size
            self._start_thread()
            self._cv.notify()
            self._recorder_ns += time.perf_counter_ns() - t0
        return seq

    def publish(self, record: dict[str, Any]) -> None:
        """Offer a record to the publisher; a refusal or a failure only counts as dropped."""
        if self._publish is None:
            return
        try:
            ok = self._publish(record)
        except Exception:  # noqa: BLE001 - Publisher callbacks are isolated from recording.
            ok = False
        if not ok:
            with self._cv:
                self._publisher_dropped += 1

    # ------------------------------------------------------------------ bookkeeping (lock held)
    def _drop(self, seq: int, size: int) -> None:
        self._dropped_events += 1
        self._dropped_bytes += size
        self._record_missing(seq)

    def _record_missing(self, seq: int) -> None:
        if self._missing and self._missing[-1][1] == seq - 1:
            self._missing[-1][1] = seq
        elif len(self._missing) < MAX_MISSING_RANGES:
            self._missing.append([seq, seq])

    def _note(self, text: str) -> None:
        if len(self._notes) < MAX_NOTES and text not in self._notes:
            self._notes.append(text[:2000])

    # ------------------------------------------------------------------ writer thread
    def _start_thread(self) -> None:
        if self._thread is None and not self._closing:
            self._thread = threading.Thread(
                target=self._loop, name=f"recorder-{self._stream_id}", daemon=True
            )
            self._thread.start()

    def _loop(self) -> None:
        try:
            while True:
                with self._cv:
                    while not self._critical and not self._detail and not self._closing:
                        self._cv.wait(timeout=0.5)
                    batch: list[tuple[bytes, dict[str, Any]]] = []
                    while self._critical and len(batch) < BATCH_EVENTS:
                        item = self._critical.popleft()
                        self._critical_q_bytes -= len(item[0])
                        batch.append(item)
                    while self._detail and len(batch) < BATCH_EVENTS:
                        item = self._detail.popleft()
                        self._detail_q_bytes -= len(item[0])
                        batch.append(item)
                    finished = self._closing and not self._critical and not self._detail
                if batch:
                    t0 = time.thread_time_ns()
                    self._write(batch)
                    with self._cv:
                        self._recorder_ns += time.thread_time_ns() - t0
                if finished:
                    return
        finally:
            self._close_sink()

    def _write(self, batch: list[tuple[bytes, dict[str, Any]]]) -> None:
        if self._sink is not None:
            with self._cv:
                degraded = self._degraded_reason is not None
            if degraded:
                with self._cv:
                    for line, event in batch:
                        self._drop(int(event["seq"]), len(line))
                return
            try:
                written = self._sink.write_lines([line for line, _ in batch])
            except (OSError, ValueError) as exc:
                reason = (
                    exc.strerror
                    if isinstance(exc, OSError) and exc.strerror
                    else str(exc)
                )
                with self._cv:
                    self._degraded_reason = (
                        self._degraded_reason or f"紀錄寫入失敗（{reason}）"
                    )
                    for line, event in batch:
                        self._drop(int(event["seq"]), len(line))
                return
            with self._cv:
                self._written_bytes += written
        if self._publish is not None:
            for line, event in batch:
                self.publish({"record": "event", "data": event})
                with self._cv:
                    self._publisher_bytes += len(line)

    def _close_sink(self) -> None:
        if self._sink is None:
            return
        self._sink.flush()
        self._sink.close()

    # ------------------------------------------------------------------ shutdown
    def close(self, timeout: float) -> bool:
        """Stop accepting events and let the writer drain; ``False`` when it did not finish in time.

        A writer still running after ``timeout`` keeps the sink and closes it itself when done.
        """
        with self._cv:
            self._closing = True
            self._closed = True
            thread = self._thread
            self._cv.notify_all()
        if thread is None:
            self._close_sink()
            return True
        thread.join(timeout=timeout)
        if thread.is_alive():
            self.degrade("writer 未在期限內排空")
            return False
        return True

    def stats(self) -> WriterStats:
        """Return the current writer statistics."""
        with self._cv:
            return WriterStats(
                dropped_events=self._dropped_events,
                dropped_bytes=self._dropped_bytes,
                missing=tuple((a, b) for a, b in self._missing),
                written_bytes=self._written_bytes,
                publisher_bytes=self._publisher_bytes,
                publisher_dropped=self._publisher_dropped,
                recorder_ns=self._recorder_ns,
                serialization_errors=self._serialization_errors,
                degraded_reason=self._degraded_reason,
                detail_truncated=self._detail_truncated,
                notes=tuple(self._notes),
            )


__all__ = ["EventWriter", "Publisher", "WriterStats", "json_line"]
