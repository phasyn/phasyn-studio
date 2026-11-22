"""Stage implementations for operator ``h3.execute_stage`` (one module per kind).

Modules are imported lazily so that importing the package (and the dispatch
table) stays torch-free.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from typing import Any, cast


STAGE_MODULES = {
    "prepare_media": "prepare_media",
    "encode_conditioning": "encode_conditioning",
    "encode_references": "encode_references",
    "prepare_adaln": "prepare_adaln",
    "load_dit": "load_dit",
    "assemble_inputs": "assemble_inputs",
    "denoise_av": "denoise_av",
    "decode_video": "decode_video",
    "decode_audio": "decode_audio",
}


def stage_runner(kind: str) -> Callable[[Any], Any]:
    """Resolve the implementation of the named stage."""
    module_name = STAGE_MODULES.get(kind)
    if module_name is None:
        raise KeyError(kind)
    module = importlib.import_module(f"{__name__}.{module_name}")
    return cast("Callable[[Any], Any]", module.run)


__all__ = ["STAGE_MODULES", "stage_runner"]
