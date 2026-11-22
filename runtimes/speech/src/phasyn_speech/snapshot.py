"""Copy the pinned official safetensors snapshot into this component's private load directory."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from phasyn_components.errors import ComponentError


if TYPE_CHECKING:
    from collections.abc import Iterator
    from typing import BinaryIO


def declaration() -> dict[str, Any]:
    """Read package data without importing the model implementation."""
    name = Path(__file__).parent / "native_capabilities" / "speech.custom_voice.json"
    manifest: dict[str, Any] = json.loads(name.read_bytes())
    return manifest


@contextmanager
def _regular(path: Path) -> Iterator[BinaryIO]:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("需要模型目錄的絕對路徑")
    directory = os.open("/", os.O_DIRECTORY | os.O_RDONLY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(
                part, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
        with os.fdopen(os.open(path.name, flags, dir_fd=directory), "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("模型檔案必須是單一連結的一般檔案")
            yield handle
    finally:
        os.close(directory)


def _copy_verified(reader: BinaryIO, target: Path, size: int, expected: str) -> None:
    if os.fstat(reader.fileno()).st_size != size:
        raise ValueError("檔案長度與官方清單不符")
    digest = hashlib.sha256()
    remaining = size
    with target.open("xb") as writer:
        while remaining:
            block = reader.read(min(4 * 1024 * 1024, remaining))
            if not block:
                raise ValueError("來源檔案不完整")
            writer.write(block)
            digest.update(block)
            remaining -= len(block)
    if reader.read(1) or digest.hexdigest() != expected:
        raise ValueError("檔案雜湊與官方清單不符")


def stage_weights(source: Path, destination: Path, files: list[dict[str, Any]]) -> None:
    """Load only verified bytes; upstream sees no other files present in the supplied directory."""
    for pin in files:
        relative = pin["path"]
        target = destination / relative
        target.parent.mkdir(exist_ok=True, parents=True)
        try:
            with _regular(source / relative) as reader:
                _copy_verified(reader, target, pin["size_bytes"], pin["sha256"])
        except ValueError as exc:
            raise ComponentError(
                "INTEGRITY_MISMATCH", f"配音權重未符合固定版本（{relative}）"
            ) from exc
        except OSError as exc:
            raise ComponentError(
                "RUNTIME_ERROR",
                f"無法建立配音模型的本機快照（{relative}），請檢查檔案與工作磁碟空間",
            ) from exc
