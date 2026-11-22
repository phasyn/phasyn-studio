"""Read only the code and weights selected by the two published Wan revisions."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

from phasyn_components.errors import ComponentError


if TYPE_CHECKING:
    from collections.abc import Iterator
    from typing import BinaryIO


ENGINE_REVISION = "1ea34ff48f87168174e12956e200b1d908b1c5ff"
MODELS = {
    "speech": ("Wan-AI/Wan2.2-S2V-14B", "dab4e9c55bbe4c8c4d03db1c2c98c7f0ac9c454b"),
    "performance": (
        "Wan-AI/Wan2.2-Animate-14B",
        "cb93a225fbaf1ca100f54e79da8f994995b689b3",
    ),
}
_CHUNK = 4 * 1024 * 1024


class Pin(TypedDict):
    """Published byte size and digest of one official file."""

    size: int
    sha256: str


def pins(group: str) -> dict[str, Pin]:
    """Load the package's immutable allowlist for an engine or model."""
    if group not in {"source", *MODELS}:
        raise ValueError("unknown Wan inventory")
    table: dict[str, Pin] = json.loads(
        (Path(__file__).parent / "pins" / f"{group}.json").read_bytes()
    )
    return table


def stamp(info: os.stat_result) -> tuple[int, ...]:
    """Identify the verified inode, contents length and mutation times."""
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextmanager
def regular(path: Path) -> Iterator[BinaryIO]:
    """Traverse an explicitly configured absolute local path without following links."""
    if not path.is_absolute() or ".." in path.parts or not path.name:
        raise ValueError("expected an absolute local checkout path")
    directory = os.open("/", os.O_DIRECTORY | os.O_RDONLY)
    try:
        for part in path.parts[1:-1]:
            handle = os.open(
                part, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = handle
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(path.name, flags, dir_fd=directory), "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("expected a regular unshared snapshot file")
            yield stream
    finally:
        os.close(directory)


def _verified(path: Path, pin: Pin, target: BinaryIO | None = None) -> tuple[int, ...]:
    with regular(path) as stream:
        start = stamp(os.fstat(stream.fileno()))
        size = pin["size"]
        if start[2] != size:
            raise ValueError("unexpected published file size")
        checksum = hashlib.sha256()
        while chunk := stream.read(_CHUNK):
            checksum.update(chunk)
            if target is not None:
                target.write(chunk)
        if (
            checksum.hexdigest() != pin["sha256"]
            or stamp(os.fstat(stream.fileno())) != start
        ):
            raise ValueError("published file content changed")
        return start


class VerifiedFile(TypedDict):
    """Stable file identity paired with its official content digest."""

    stamp: tuple[int, ...]
    sha256: str


@dataclass(frozen=True)
class Installation:
    """The isolated verified source tree and the model inodes to mount for one call."""

    engine: Path
    weights: Path
    files: dict[str, VerifiedFile]


def stage_engine(engine: Path, target: Path) -> None:
    """Copy and authenticate the pinned Python tree before running any of it."""
    for name, pin in pins("source").items():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            with dest.open("xb") as writer:
                _verified(engine / name, pin, writer)
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "Wan 程式快照缺少或已變更，請還原指定版本的檔案",
                details={"revision": ENGINE_REVISION, "relative_file": name},
            ) from exc


def verified_installation(weights: Path, target: Path, role: str) -> Installation:
    """Hash every file before handing its inode identity to the isolated child."""
    files: dict[str, VerifiedFile] = {}
    for name, pin in pins(role).items():
        try:
            files[name] = {
                "stamp": _verified(weights / name, pin),
                "sha256": pin["sha256"],
            }
        except (OSError, ValueError) as exc:
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "Wan 權重缺少或已變更，請還原指定版本的檔案",
                details={"revision": MODELS[role][1], "relative_file": name},
            ) from exc
    return Installation(target, weights, files)
