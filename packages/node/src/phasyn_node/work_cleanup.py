"""Age-based cleanup of finished component processes' work directories (``NodeConfig.work_cleanup``).

Every component process gets ``<data_dir>/work/<component_id>/<process_instance_id>/`` for its intermediate files
(decoded frames, staged engines, per-call temp dirs). The directory of a process that has exited is never used again,
yet nothing removed it, so such directories piled up on disk. The sweep removes such a directory
when **all** of these hold:

- it is not the directory of a process the Node runs now (a running or loading component, whatever its age);
- nothing under it changed for ``ttl_hours`` (the newest mtime of the whole tree, links not followed);
- it is a real directory inside the work root (links and other file types are left alone).

The published files (``files/``), recordings, logs and the describe scratch (``work/_describe``) are never touched.
Each sweep is logged; the last result is kept for the storage inventory.
"""

from __future__ import annotations

import logging
import os
import shutil
import stat
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.timeutil import utc_now


log = logging.getLogger("phasyn_node.work_cleanup")

DESCRIBE_DIR = "_describe"
DEFAULT_TTL_HOURS = 24.0
DEFAULT_INTERVAL_MINUTES = 60
_MAX_ENTRIES = 1_000_000  # bound the tree walk of one directory


@dataclass(frozen=True)
class WorkCleanupConfig:
    """``NodeConfig.work_cleanup``: on by default; a finished process's directory goes after ``ttl_hours``."""

    enabled: bool = True
    ttl_hours: float = DEFAULT_TTL_HOURS
    interval_minutes: int = DEFAULT_INTERVAL_MINUTES

    def to_dict(self) -> dict[str, Any]:
        """Return the wire representation."""
        return {
            "enabled": self.enabled,
            "ttl_hours": self.ttl_hours,
            "interval_minutes": self.interval_minutes,
        }


def work_cleanup_config(doc: Any) -> WorkCleanupConfig:
    """Read the (schema-checked) section; a missing one is the default."""
    if not isinstance(doc, dict):
        return WorkCleanupConfig()
    return WorkCleanupConfig(
        enabled=bool(doc.get("enabled", True)),
        ttl_hours=float(doc.get("ttl_hours", DEFAULT_TTL_HOURS)),
        interval_minutes=int(doc.get("interval_minutes", DEFAULT_INTERVAL_MINUTES)),
    )


@dataclass
class SweepResult:
    """What one sweep did."""

    at: str
    removed: int = 0
    freed_bytes: int = 0
    kept_live: int = 0
    kept_recent: int = 0
    failed: list[str] = field(default_factory=list)

    def wire(self) -> dict[str, Any]:
        """The inventory form."""
        return {
            "at": self.at,
            "removed": self.removed,
            "freed_bytes": self.freed_bytes,
            "failed": len(self.failed),
        }


def _tree(path: Path) -> tuple[float, int]:
    """(newest mtime, bytes) of the regular files and directories under ``path``; links are not followed."""
    newest = path.lstat().st_mtime
    size = 0
    stack = [path]
    seen = 0
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    seen += 1
                    if seen > _MAX_ENTRIES:
                        # Too large to prove idle: report it as changed now, so it is kept
                        return time.time(), size
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    newest = max(newest, info.st_mtime)
                    if stat.S_ISDIR(info.st_mode):
                        stack.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode):
                        size += info.st_size
        except OSError:
            continue
    return newest, size


def process_dirs(root: Path) -> Iterable[tuple[str, str, Path]]:
    """``(component_id, process_instance_id, path)`` of every process directory under the work root."""
    try:
        components = sorted(os.scandir(root), key=lambda entry: entry.name)
    except OSError:
        return
    for component in components:
        if component.name == DESCRIBE_DIR or not component.is_dir(
            follow_symlinks=False
        ):
            continue
        try:
            processes = sorted(os.scandir(component.path), key=lambda entry: entry.name)
        except OSError:
            continue
        for process in processes:
            if process.is_dir(follow_symlinks=False):
                yield component.name, process.name, Path(process.path)


def sweep(
    root: Path,
    live: set[tuple[str, str]],
    ttl_hours: float,
    *,
    now: float | None = None,
    remove: Callable[[Path], None] = shutil.rmtree,
) -> SweepResult:
    """Remove the idle directories of finished processes (blocking; run it in a thread)."""
    clock = time.time() if now is None else now
    cutoff = clock - ttl_hours * 3600
    result = SweepResult(at=utc_now())
    real_root = Path(os.path.realpath(root))
    for component_id, process_id, path in process_dirs(root):
        if (component_id, process_id) in live:
            result.kept_live += 1
            continue
        if Path(os.path.realpath(path)).parent.parent != real_root:
            continue  # not where a process directory belongs (a link somewhere on the way)
        try:
            newest, size = _tree(path)
        except OSError:
            continue
        if newest > cutoff:
            result.kept_recent += 1
            continue
        try:
            remove(path)
        except OSError as exc:
            result.failed.append(f"{component_id}/{process_id}")
            log.warning(
                "工作目錄清理：%s/%s 無法刪除：%s", component_id, process_id, exc
            )
            continue
        result.removed += 1
        result.freed_bytes += size
        log.info(
            "工作目錄清理：刪除 %s/%s（%d bytes，最後變動 %.1f 小時前）",
            component_id,
            process_id,
            size,
            (clock - newest) / 3600,
        )
    log.info(
        "工作目錄清理完成：刪除 %d 個（%d bytes），執行中保留 %d 個，%g 小時內有變動保留 %d 個，失敗 %d 個",
        result.removed,
        result.freed_bytes,
        result.kept_live,
        ttl_hours,
        result.kept_recent,
        len(result.failed),
    )
    return result


def usage(root: Path) -> dict[str, int]:
    """Count and bytes of the process directories (StorageTotal)."""
    count = 0
    size = 0
    for _component, _process, path in process_dirs(root):
        count += 1
        try:
            size += _tree(path)[1]
        except OSError:
            continue
    return {"count": count, "size_bytes": size}
