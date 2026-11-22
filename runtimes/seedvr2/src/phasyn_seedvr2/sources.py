"""Offline verification of the pinned SeedVR2 engine and official 3B checkpoints."""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import stat
import tarfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import IO, Any, BinaryIO

from phasyn_components.weights import WeightFile, WeightLicense, WeightPlan, WeightSet


ENGINE_REVISION = "4490bd1f482e026674543386bb2a4d176da245b9"
WEIGHT_REVISION = "37255ff8cccfb01071b87f635a5948ca8d53117c"
_ENGINE_ROOT = f"ComfyUI-SeedVR2_VideoUpscaler-{ENGINE_REVISION}"
_ENGINE_SIZE = 4_776_791
_ENGINE_SHA = "73ebee9da0bfa6876613e23a5f898ebd72ea938eb1d26d9322063172bfb788be"
_ENGINE_FILES = frozenset(
    ("inference_cli.py", "configs_3b/main.yaml", "pos_emb.pt", "neg_emb.pt")
)
_WEIGHT_FILES = (
    WeightFile(
        "seedvr2_ema_3b.pth",
        13_566_090_228,
        sha256="6bcc5ac59447e97b100477480aebb01be2ec724c8340bb83faae21f64848604b",
    ),
    WeightFile(
        "ema_vae.pth",
        1_002_691_902,
        sha256="c7df8a67e68b7f9aca3d5d2153d2ce8ab4373687741a0f9ce87cb356ace51cac",
    ),
    WeightFile(
        "pos_emb.pt",
        595_100,
        sha256="fa07a14844314772266b66c3b95deb0027696d8fe7065721263db5176f45d799",
    ),
    WeightFile(
        "neg_emb.pt",
        656_540,
        sha256="6a43e5800ef2354f1c156d27535834da055cbec8248298b8923492bba2076581",
    ),
)
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_CHUNK = 8 * 1024 * 1024


@contextmanager
def _directory(path: Path) -> Iterator[int]:
    absolute = path.absolute()
    if ".." in absolute.parts:
        raise ValueError("SeedVR2 path contains a parent traversal")
    fd = os.open(absolute.anchor, _DIR_FLAGS)
    try:
        for name in absolute.parts[1:]:
            child = os.open(name, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _input(directory: int, name: str, size: int) -> Iterator[BinaryIO]:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=directory)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
            raise ValueError(
                "SeedVR2 input is not a single regular file of the pinned size"
            )
        yield stream


def weight_plan(settings: Mapping[str, Any] | None) -> WeightPlan:
    """Describe the four pinned model files stored directly under load.model_path."""
    load = (settings or {}).get("load")
    root = load.get("model_path") if isinstance(load, Mapping) else None
    if not isinstance(root, str) or not root:
        return WeightPlan(
            root=None, notes=("請設定 load.model_path 為 SeedVR2-3B 權重目錄",)
        )
    return WeightPlan(
        root=root,
        sets=(
            WeightSet(
                set_id="seedvr2-3b",
                label="SeedVR2-3B",
                repo="ByteDance-Seed/SeedVR2-3B",
                revision=WEIGHT_REVISION,
                license=WeightLicense(
                    "Apache-2.0", "https://www.apache.org/licenses/LICENSE-2.0"
                ),
                dest="",
                files=_WEIGHT_FILES,
            ),
        ),
    )


@contextmanager
def verified_checkpoint(root: Path, name: str) -> Iterator[BinaryIO]:
    """Open one official checkpoint and yield its verified inode for memory mapping."""
    item = next((entry for entry in _WEIGHT_FILES if entry.path == name), None)
    if item is None:
        raise ValueError("Unexpected SeedVR2 checkpoint")
    with _directory(root) as directory, _input(directory, name, item.size) as stream:
        digest = hashlib.sha256()
        remaining = item.size
        while remaining:
            chunk = stream.read(min(remaining, _CHUNK))
            if not chunk:
                raise ValueError(f"Truncated SeedVR2 checkpoint: {name}")
            digest.update(chunk)
            remaining -= len(chunk)
        if stream.read(1) or digest.hexdigest() != item.sha256:
            raise ValueError(f"SeedVR2 checkpoint checksum mismatch: {name}")
        yield stream


def verify_weights(root: Path) -> None:
    """Verify the integrity of every official checkpoint before loading the component."""
    for item in _WEIGHT_FILES:
        with verified_checkpoint(root, item.path):
            pass


def _engine_bytes(archive: Path) -> bytes:
    with (
        _directory(archive.parent) as directory,
        _input(directory, archive.name, _ENGINE_SIZE) as stream,
    ):
        data = stream.read(_ENGINE_SIZE + 1)
    if len(data) != _ENGINE_SIZE or hashlib.sha256(data).hexdigest() != _ENGINE_SHA:
        raise ValueError("SeedVR2 engine archive checksum mismatch")
    return data


def _member_path(member: tarfile.TarInfo) -> tuple[str, ...]:
    parts = member.name.split("/")
    if parts[0] != _ENGINE_ROOT or any(
        name in {"", ".", ".."} or "\\" in name for name in parts
    ):
        raise ValueError("Unsafe SeedVR2 engine member path")
    if not (member.isdir() or member.isfile()):
        raise ValueError("SeedVR2 engine archive contains a link or a special entry")
    return tuple(parts[1:])


def _needed(parts: tuple[str, ...]) -> bool:
    # The CLI imports both DiT architectures through src.utils.model_registry.
    return "/".join(parts) in _ENGINE_FILES or (
        parts[:1] == ("src",)
        and parts[:2] != ("src", "interfaces")
        and parts[-1].endswith((".py", ".yaml", ".json"))
    )


def _write_member(root: int, parts: tuple[str, ...], stream: IO[bytes]) -> None:
    fd = os.dup(root)
    try:
        for name in parts[:-1]:
            with suppress(FileExistsError):
                os.mkdir(name, 0o700, dir_fd=fd)
            child = os.open(name, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
        leaf = os.open(parts[-1], flags, 0o600, dir_fd=fd)
        with os.fdopen(leaf, "wb") as output:
            shutil.copyfileobj(stream, output)
    finally:
        os.close(fd)


def _unpack(data: bytes, directory: int) -> None:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        for member in source:
            parts = _member_path(member)
            if member.isdir() or not _needed(parts):
                continue
            contents = source.extractfile(member)
            if contents is None:
                raise ValueError("Cannot read SeedVR2 engine source")
            with contents:
                _write_member(directory, parts, contents)


def unpack_engine(archive: Path, destination: Path) -> None:
    """Extract verified CLI sources into a new private directory; reject existing targets."""
    if destination.name in {"", ".", ".."}:
        raise ValueError("SeedVR2 engine requires a new child directory")
    data = _engine_bytes(archive)
    with _directory(destination.parent) as parent:
        os.mkdir(destination.name, 0o700, dir_fd=parent)
        fd = os.open(destination.name, _DIR_FLAGS, dir_fd=parent)
        complete = False
        try:
            _unpack(data, fd)
            complete = True
        finally:
            try:
                if not complete and os.path.samestat(
                    os.fstat(fd),
                    os.stat(destination.name, dir_fd=parent, follow_symlinks=False),
                ):
                    shutil.rmtree(destination.name, dir_fd=parent)
            finally:
                os.close(fd)
