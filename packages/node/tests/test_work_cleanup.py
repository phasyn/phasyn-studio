"""Destructive boundary: the age-based cleanup of finished processes' work directories.

Only a directory of a process that is not running and whose whole tree is older than the TTL goes; the running
process's directory (however old), recent directories, the describe scratch, links and everything outside the work
root stay. Synthetic directories and synthetic UUIDs.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from phasyn_components import contracts

from phasyn_node.work_cleanup import (
    WorkCleanupConfig,
    process_dirs,
    sweep,
    usage,
    work_cleanup_config,
)


LIVE = "00000000-0000-4000-8000-000000000001"
OLD = "00000000-0000-4000-8000-000000000002"
RECENT = "00000000-0000-4000-8000-000000000003"
OLD_BUT_TOUCHED = "00000000-0000-4000-8000-000000000004"
DAY = 24 * 3600


def _age(path: Path, seconds: float, now: float) -> None:
    for root, dirs, files in os.walk(path):
        for name in [*dirs, *files]:
            os.utime(
                Path(root) / name, (now - seconds, now - seconds), follow_symlinks=False
            )
    os.utime(path, (now - seconds, now - seconds))


def _process(root: Path, component: str, pid: str, size: int = 1000) -> Path:
    path = root / component / pid
    (path / "wan-call-x").mkdir(parents=True)
    (path / "wan-call-x" / "frames.bin").write_bytes(b"\0" * size)
    return path


@pytest.fixture
def tree(tmp_path: Path) -> tuple[Path, float]:
    now = time.time()
    root = tmp_path / "data" / "work"
    for pid, age in (
        (LIVE, 10 * DAY),
        (OLD, 3 * DAY),
        (RECENT, 3600),
        (OLD_BUT_TOUCHED, 3 * DAY),
    ):
        _age(_process(root, "wan-edit", pid), age, now)
    # one file deep inside changed an hour ago: the directory is not idle
    inner = root / "wan-edit" / OLD_BUT_TOUCHED / "wan-call-x" / "frames.bin"
    os.utime(inner, (now - 3600, now - 3600))
    (root / "_describe").mkdir()
    old_describe = root / "_describe" / "describe-x.json"
    old_describe.write_text("{}")
    os.utime(old_describe, (now - 9 * DAY, now - 9 * DAY))
    return root, now


def test_only_idle_directories_of_finished_processes_are_removed(
    tree: tuple[Path, float],
) -> None:
    root, now = tree
    result = sweep(root, {("wan-edit", LIVE)}, 24, now=now)
    left = sorted(pid for _c, pid, _p in process_dirs(root))
    assert left == [LIVE, RECENT, OLD_BUT_TOUCHED]
    assert (
        result.removed,
        result.freed_bytes,
        result.kept_live,
        result.kept_recent,
    ) == (1, 1000, 1, 2)
    assert (
        root / "_describe" / "describe-x.json"
    ).exists()  # the describe scratch is never touched


def test_a_link_into_another_tree_is_never_followed_or_removed(tmp_path: Path) -> None:
    now = time.time()
    root = tmp_path / "work"
    outside = tmp_path / "precious"
    outside.mkdir()
    (outside / "keep.mp4").write_bytes(b"x")
    (root / "mux").mkdir(parents=True)
    (root / "mux" / OLD).symlink_to(outside, target_is_directory=True)
    (root / "linked").symlink_to(outside, target_is_directory=True)
    _age(outside, 30 * DAY, now)
    result = sweep(root, set(), 1, now=now)
    assert result.removed == 0
    assert (outside / "keep.mp4").exists()


def test_a_failed_removal_is_reported_and_the_rest_continues(
    tree: tuple[Path, float],
) -> None:
    root, now = tree

    def refuse(path: Path) -> None:
        raise PermissionError(str(path))

    result = sweep(root, set(), 24, now=now, remove=refuse)
    assert result.removed == 0 and result.failed == [
        f"wan-edit/{LIVE}",
        f"wan-edit/{OLD}",
    ]
    assert result.wire()["failed"] == 2


def test_usage_counts_every_process_directory(tree: tuple[Path, float]) -> None:
    root, _now = tree
    assert usage(root) == {"count": 4, "size_bytes": 4000}
    assert usage(root / "missing") == {"count": 0, "size_bytes": 0}


def test_config_defaults_and_contract() -> None:
    assert work_cleanup_config(None) == WorkCleanupConfig(
        enabled=True, ttl_hours=24.0, interval_minutes=60
    )
    custom = work_cleanup_config(
        {"enabled": False, "ttl_hours": 6, "interval_minutes": 30}
    )
    assert custom.to_dict() == {
        "enabled": False,
        "ttl_hours": 6.0,
        "interval_minutes": 30,
    }
    schema = contracts.schema()["$defs"]["NodeConfig"]["properties"]["work_cleanup"]
    assert schema["properties"]["ttl_hours"]["minimum"] == 1
    assert schema["additionalProperties"] is False


def test_the_inventory_form_is_a_valid_storage_work(tree: tuple[Path, float]) -> None:
    root, now = tree
    result = sweep(root, set(), 24, now=now)
    doc = {
        **usage(root),
        "enabled": True,
        "ttl_hours": 24.0,
        "last_sweep": result.wire(),
    }
    contracts.validate("StorageWork", doc, what="work")
    contracts.validate("StorageWork", {**doc, "last_sweep": None}, what="work")
