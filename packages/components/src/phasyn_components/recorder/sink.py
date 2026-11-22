"""單一 recording、單一 stream 的本機落盤.

    recordings/<recording_id>/context.json
    recordings/<recording_id>/streams/<stream_id>.<segment>.jsonl
    recordings/<recording_id>/summary.json
    recordings/<recording_id>/trace/*.json

每個 stream 只有一個 writer（產生該 stream 的程序）。context／summary 以原子替換寫入。
"""

from __future__ import annotations

import os
import re
from contextlib import suppress
from pathlib import Path
from typing import Any

from ..canonical import atomic_write_json
from ..ids import require_local_id, require_uuid


SEGMENT_RE = re.compile(
    r"^(?P<stream>[A-Za-z0-9][A-Za-z0-9_.:-]*)\.(?P<segment>\d{4,})\.jsonl$"
)


def recording_dir(recordings_root: Path, recording_id: str) -> Path:
    """Locate the recording directory."""
    return Path(recordings_root) / require_uuid(recording_id, "recording_id")


def segment_name(stream_id: str, segment: int) -> str:
    """Name an ordered event-stream segment."""
    return f"{stream_id}.{segment:04d}.jsonl"


def list_segments(directory: Path) -> dict[str, list[tuple[int, Path]]]:
    """streams/ 內所有 stream 的 segment（依序）."""
    out: dict[str, list[tuple[int, Path]]] = {}
    streams = directory / "streams"
    if not streams.is_dir():
        return out
    for entry in streams.iterdir():
        m = SEGMENT_RE.match(entry.name)
        if m:
            out.setdefault(m.group("stream"), []).append(
                (int(m.group("segment")), entry)
            )
    for items in out.values():
        items.sort()
    return out


class RecordingSink:
    """Persist the streams and artifacts belonging to one recording."""

    def __init__(
        self,
        recordings_root: Path,
        recording_id: str,
        stream_id: str,
        *,
        segment_bytes: int,
    ) -> None:
        """Initialize recording sink with its configuration."""
        self.directory = recording_dir(recordings_root, recording_id)
        self.stream_id = require_local_id(stream_id, "stream_id")
        self.segment_bytes = max(1024 * 1024, int(segment_bytes))
        self.streams = self.directory / "streams"
        self.streams.mkdir(parents=True, exist_ok=True)
        existing = [
            seg for seg, _ in list_segments(self.directory).get(self.stream_id, [])
        ]
        self.segment = max(existing) if existing else 0
        self._fh: Any = None
        self._size = 0

    def _open(self) -> None:
        path = self.streams / segment_name(self.stream_id, self.segment)
        self._fh = path.open("ab", buffering=0)
        self._size = path.stat().st_size

    def write_lines(self, lines: list[bytes]) -> int:
        """寫入完整 JSON lines；回傳寫入 bytes。單行不切開，超過 segment 才換檔."""
        if not lines:
            return 0
        if self._fh is None:
            self._open()
        written = 0
        for line in lines:
            if self._size > 0 and self._size + len(line) > self.segment_bytes:
                self._fh.close()
                self.segment += 1
                self._open()
            self._fh.write(line)
            self._size += len(line)
            written += len(line)
        return written

    def flush(self) -> None:
        """Flush pending output."""
        if self._fh is not None:
            with suppress(OSError):
                os.fsync(self._fh.fileno())

    def close(self) -> None:
        """Release the owned resources."""
        if self._fh is not None:
            try:
                self._fh.close()
            finally:
                self._fh = None

    def write_context(self, context: dict[str, Any]) -> None:
        """Persist the effective operation context."""
        atomic_write_json(self.directory / "context.json", context)

    def write_summary(self, summary: dict[str, Any]) -> None:
        """Persist the final recording summary."""
        atomic_write_json(self.directory / "summary.json", summary)

    def write_trace(self, name: str, document: Any) -> Path:
        """Persist a named trace artifact."""
        trace_dir = self.directory / "trace"
        trace_dir.mkdir(parents=True, exist_ok=True)
        path = trace_dir / f"{require_local_id(name, 'trace name')}.json"
        atomic_write_json(path, document, indent=None)
        return path


__all__ = [
    "SEGMENT_RE",
    "RecordingSink",
    "list_segments",
    "recording_dir",
    "segment_name",
]
