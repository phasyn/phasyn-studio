"""Read the four verified CTranslate2 files into an immutable load snapshot."""

from __future__ import annotations

import os
import stat
from contextlib import ExitStack
from pathlib import Path

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


MODEL = load_manifest(Path(__file__).with_name("weights.json"))
_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def weight_plan(root: str | None) -> WeightPlan:
    """Describe the operator-managed official checkpoint without network access."""
    weights = WeightSet(
        set_id="faster-whisper-small",
        label="Whisper small multilingual (CTranslate2)",
        repo=MODEL.repo,
        revision=MODEL.revision,
        license=WeightLicense(
            "MIT", "https://github.com/openai/whisper/blob/main/LICENSE"
        ),
        dest="",
        files=MODEL.files,
    )
    return WeightPlan(root=root, sets=(weights,))


def _read_file(directory: int, item: WeightFile) -> bytes:
    fd = os.open(
        item.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
    )
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != item.size:
            raise ComponentError("INTEGRITY_MISMATCH", f"Invalid ASR file: {item.path}")
        payload = stream.read(item.size + 1)
    digest = new_digest(item)
    digest.update(payload)
    if len(payload) != item.size or digest.hexdigest() != expected_digest(item):
        raise ComponentError("INTEGRITY_MISMATCH", f"Invalid ASR digest: {item.path}")
    return payload


def verified_files(root: Path) -> dict[str, bytes]:
    """Hand the decoder the bytes that were checked, ignoring unlisted local files."""
    if not root.is_absolute() or ".." in root.parts:
        raise ComponentError(
            "INVALID_ARGUMENT", "ASR requires an absolute local model directory"
        )
    try:
        with ExitStack() as handles:
            directory = os.open("/", _DIR)
            handles.callback(os.close, directory)
            for part in root.parts[1:]:
                directory = os.open(part, _DIR, dir_fd=directory)
                handles.callback(os.close, directory)
            return {item.path: _read_file(directory, item) for item in MODEL.files}
    except OSError as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", "ASR checkpoint is missing or inaccessible"
        ) from exc
