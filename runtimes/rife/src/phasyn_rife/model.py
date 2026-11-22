"""Practical-RIFE 4.26 RGB interpolation from integrity-checked local weights."""

from __future__ import annotations

import hashlib
import io
import os
import stat
import zipfile
from contextlib import ExitStack
from pathlib import Path
from typing import cast

import numpy as np
import torch
from numpy.typing import NDArray
from torch import Tensor
from torch.nn import functional

from . import WEIGHTS_SHA256
from .network import FlowNetwork


ARCHIVE_SHA256 = "c2452dd2b244947d4be580156bbead60d6b72af5736860f7d6b3f99648c9c4cc"
_ARCHIVE_BYTES = 22_867_954
_WEIGHT_BYTES = 24_636_301
_ALIGNMENT = 128
_RGB_CHANNELS = 3


def _archive_bytes(path: Path) -> bytes:
    # Use one file descriptor for the size check and the complete read.
    absolute = path.absolute()
    directory_flags = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY
    with ExitStack() as stack:
        directory = os.open(absolute.anchor, directory_flags)
        stack.callback(os.close, directory)
        for parent in absolute.parts[1:-1]:
            directory = os.open(parent, directory_flags, dir_fd=directory)
            stack.callback(os.close, directory)
        fd = os.open(
            absolute.name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=directory,
        )
        file = stack.enter_context(os.fdopen(fd, "rb"))
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_size != _ARCHIVE_BYTES
        ):
            raise ValueError("Invalid RIFE 4.26 model archive")
        content = file.read(_ARCHIVE_BYTES + 1)
    if hashlib.sha256(content).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("RIFE 4.26 archive checksum mismatch")
    return content


def _state_dict(path: Path) -> dict[str, Tensor]:
    with zipfile.ZipFile(io.BytesIO(_archive_bytes(path))) as archive:
        member = archive.getinfo("train_log/flownet.pkl")
        if member.file_size != _WEIGHT_BYTES:
            raise ValueError("Invalid RIFE 4.26 checkpoint length")
        weights = archive.read(member)
    if hashlib.sha256(weights).hexdigest() != WEIGHTS_SHA256:
        raise ValueError("RIFE 4.26 checkpoint checksum mismatch")
    raw = torch.load(io.BytesIO(weights), map_location="cpu", weights_only=True)
    # The released DistributedDataParallel checkpoint also holds the teacher
    # and timestep estimator used during training. All other entries must match
    # the local inference graph exactly (including shape).
    inference: dict[str, Tensor] = {}
    for name, tensor in raw.items():
        if name.startswith(("module.teacher.", "module.caltime.")):
            continue
        if not name.startswith("module.") or not isinstance(tensor, Tensor):
            raise ValueError("Invalid RIFE 4.26 parameter")
        inference[name.removeprefix("module.")] = tensor
    return inference


def _frame_tensor(frame: NDArray[np.uint8], device: torch.device) -> Tensor:
    height, width = frame.shape[:2]
    # FFmpeg buffers can expose read-only views, which torch cannot wrap safely.
    writable = np.require(frame, requirements=["C", "W"])
    rgb = torch.from_numpy(writable).permute(2, 0, 1).unsqueeze(0)
    normalized = rgb.to(device=device, dtype=torch.float32) / 255.0
    return functional.pad(normalized, (0, -width % _ALIGNMENT, 0, -height % _ALIGNMENT))


class RifeModel:
    """Interpolate one pair of uint8 RGB frames with the official 4.26 weights."""

    def __init__(self, archive: Path, device: torch.device) -> None:
        """Verify the archive and load the inference parameters onto the device."""
        state = _state_dict(archive)
        self.network = FlowNetwork()
        self.network.load_state_dict(state, strict=True)
        self.network.eval().to(device)
        self.device = device

    def __call__(
        self, left: NDArray[np.uint8], right: NDArray[np.uint8], timestep: float
    ) -> NDArray[np.uint8]:
        """Return an interpolated RGB frame with the source dimensions."""
        if (
            left.dtype != np.uint8
            or right.dtype != np.uint8
            or left.ndim != _RGB_CHANNELS
            or left.shape[-1] != _RGB_CHANNELS
            or left.shape != right.shape
            or min(left.shape[:2]) < 1
        ):
            raise ValueError(
                "Expected two equally sized, nonempty uint8 HWC RGB frames"
            )
        if not 0.0 <= timestep <= 1.0:
            raise ValueError("Interpolation time must be in [0, 1]")
        if timestep == 0.0:
            return left.copy()
        if timestep == 1.0:
            return right.copy()
        with torch.inference_mode():
            prediction: Tensor = self.network(
                _frame_tensor(left, self.device),
                _frame_tensor(right, self.device),
                timestep,
            )
            height, width = left.shape[:2]
            rgb = prediction[0, :, :height, :width].permute(1, 2, 0)
            # The reference video runner truncates to bytes without rounding.
            pixels = (rgb * 255.0).to(torch.uint8).contiguous().cpu().numpy()
            return cast("NDArray[np.uint8]", pixels)
