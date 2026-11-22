"""Only regular files at the configured location may supply pinned model bytes."""

from pathlib import Path

import pytest
from phasyn_components.errors import ComponentError

from phasyn_performance.capture import model_bytes


def test_linked_parent(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (real / "test.task").write_bytes(b"short")
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    with pytest.raises(OSError):
        model_bytes(alias / "test.task", "pose")


def test_wrong_size(tmp_path: Path) -> None:
    target = tmp_path / "test.task"
    target.write_bytes(b"truncated model")
    with pytest.raises(ComponentError, match="size"):
        model_bytes(target, "face")


def test_linked_leaf(tmp_path: Path) -> None:
    target = tmp_path / "file"
    target.write_bytes(b"truncated model")
    alias = tmp_path / "alias"
    alias.symlink_to(target)
    with pytest.raises(OSError):
        model_bytes(alias, "pose")
