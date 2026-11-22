"""Verify the pinned model and expose exactly its 17 known files to Diffusers."""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from phasyn_components.errors import ComponentError
from phasyn_components.weights import (
    WeightFile,
    WeightLicense,
    WeightPlan,
    WeightSet,
    expected_digest,
    load_manifest,
    new_digest,
)

from .schema import ROOT


MODEL = load_manifest(ROOT / "weights.json")
_DIR = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
_CHUNK = 4 * 1024**2


def plan(path: str | None) -> WeightPlan:
    """Return the official SHA-256 inventory for the Node's explicit weight installer."""
    return WeightPlan(
        root=path,
        sets=(
            WeightSet(
                set_id="wan-vace-1.3b",
                label="Wan 2.1 VACE 1.3B",
                repo=MODEL.repo,
                revision=MODEL.revision,
                license=WeightLicense(
                    "Apache-2.0", "https://www.apache.org/licenses/LICENSE-2.0"
                ),
                dest="",
                files=MODEL.files,
            ),
        ),
    )


def _directory(path: Path, stack: ExitStack, parent: int | None = None) -> int:
    fd = os.open(path, _DIR, dir_fd=parent)
    stack.callback(os.close, fd)
    return fd


def _verified_fd(root_fd: int, item: WeightFile, stack: ExitStack) -> int:
    path = Path(item.path)
    parent = (
        _directory(path.parent, stack, root_fd) if path.parent != Path() else root_fd
    )
    fd = os.open(path.name, _FILE, dir_fd=parent)
    stream = stack.enter_context(os.fdopen(fd, "rb"))
    original = os.fstat(fd)
    if not stat.S_ISREG(original.st_mode) or original.st_size != item.size:
        raise ComponentError(
            "INTEGRITY_MISMATCH", f"Wrong size or type for {item.path}"
        )
    digest = new_digest(item)
    remaining = item.size
    while remaining:
        chunk = stream.read(min(_CHUNK, remaining))
        if not chunk:
            break
        digest.update(chunk)
        remaining -= len(chunk)
    if remaining or stream.read(1) or digest.hexdigest() != expected_digest(item):
        raise ComponentError("INTEGRITY_MISMATCH", f"Digest mismatch for {item.path}")
    return fd


@contextmanager
def verified_snapshot(path: Path, work: Path) -> Iterator[Path]:
    """Pin verified inodes in a private Linux procfd view that excludes unlisted code and weights."""
    if not path.is_absolute() or ".." in path.parts:
        raise ComponentError(
            "INVALID_ARGUMENT", "Wan model_path must be an absolute local directory"
        )
    work.mkdir(parents=True, exist_ok=True)
    with (
        TemporaryDirectory(prefix="wan-snapshot-", dir=work) as tmp,
        ExitStack() as handles,
    ):
        view = Path(tmp)
        try:
            root = _directory(Path("/"), handles)
            for part in path.parts[1:]:
                root = _directory(Path(part), handles, root)
            for item in MODEL.files:
                fd = _verified_fd(root, item, handles)
                target = view / item.path
                target.parent.mkdir(exist_ok=True)
                target.symlink_to(f"/proc/self/fd/{fd}")
        except OSError as exc:
            raise ComponentError(
                "INVALID_ARGUMENT", "Could not open the pinned Wan model directory"
            ) from exc
        yield view
