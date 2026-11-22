"""Build the pinned SAM predictor exclusively from verified local bytes."""

from __future__ import annotations

import hashlib
import io
import os
import stat
from contextlib import ExitStack
from importlib import import_module
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_components.upstream import distribution_problem
from phasyn_components.weights import WeightFile, WeightLicense, WeightPlan, WeightSet


ENGINE = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
REPO = "facebook/sam2.1-hiera-tiny"
REVISION = "de431c4043854a71d8101e17995dfe596bf101a5"
FILE = WeightFile(
    "sam2.1_hiera_tiny.pt",
    156008466,
    sha256="7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
)
CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"


def weight_plan(root: str | None) -> WeightPlan:
    """Advertise one downloadable official checkpoint; the runtime never downloads it."""
    bundle = WeightSet(
        set_id="sam2.1-hiera-tiny",
        label="SAM 2.1 Hiera Tiny",
        repo=REPO,
        revision=REVISION,
        license=WeightLicense(
            "Apache-2.0", "https://www.apache.org/licenses/LICENSE-2.0"
        ),
        dest="",
        files=(FILE,),
    )
    return WeightPlan(root=root, sets=(bundle,))


def _checkpoint(root: Path) -> io.BytesIO:
    if not root.is_absolute() or ".." in root.parts:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "model_path must be an absolute local checkpoint directory.",
        )
    flags = os.O_RDONLY | os.O_NOFOLLOW
    with ExitStack() as handles:
        parent = os.open("/", flags | os.O_DIRECTORY)
        handles.callback(os.close, parent)
        for part in root.parts[1:]:
            parent = os.open(part, flags | os.O_DIRECTORY, dir_fd=parent)
            handles.callback(os.close, parent)
        file = handles.enter_context(
            os.fdopen(os.open(FILE.path, flags | os.O_NONBLOCK, dir_fd=parent), "rb")
        )
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != FILE.size:
            raise ComponentError(
                "INTEGRITY_MISMATCH",
                "SAM 2 checkpoint size or file type differs from the official inventory.",
            )
        payload = file.read(FILE.size + 1)
    if len(payload) != FILE.size or hashlib.sha256(payload).hexdigest() != FILE.sha256:
        raise ComponentError(
            "INTEGRITY_MISMATCH",
            "SAM 2 checkpoint SHA-256 differs from the official release.",
        )
    return io.BytesIO(payload)


def predictor(root: Path) -> Any:
    """Load a specific packaged Hydra config and frozen verified bytes onto the assigned CUDA device."""
    mismatch = distribution_problem("SAM-2", vcs_commit=ENGINE)
    if mismatch:
        raise ComponentError("UPSTREAM_PATCH_SOURCE_MISMATCH", mismatch)
    torch = import_module("torch")
    if not torch.cuda.is_available():
        raise ComponentError(
            "RUNTIME_UNAVAILABLE",
            "SAM 2 requires the CUDA device assigned by the Node.",
        )
    build = import_module("sam2.build_sam").build_sam2_video_predictor
    try:
        with _checkpoint(root) as checkpoint:
            # Upstream uses torch.load(weights_only=True). Keep the hashed buffer immutable
            # across its verification and loading rather than reopening a mutable filename.
            return build(
                CONFIG,
                ckpt_path=checkpoint,
                device="cuda:0",
                apply_postprocessing=False,
            )
    except OSError as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", "Cannot open the configured local SAM 2 checkpoint."
        ) from exc
