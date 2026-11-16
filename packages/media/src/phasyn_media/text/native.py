"""Loading the system text libraries through ``ctypes`` (worker process only).

The structures in ``ft.py``, ``hb.py`` and ``fc.py`` are laid out for the LP64 data model of
x86_64 and aarch64 Linux (``long`` and pointers are 64 bits). Any other platform, a library that
cannot be loaded and a library without a function this package calls are all the same answer:
the renderer is unavailable. Nothing here is imported by the long-lived parent.
"""

from __future__ import annotations

import ctypes
import platform
import sys
from typing import Any

from .model import TextFailure

_MACHINES = frozenset({"x86_64", "aarch64"})


def unavailable(detail: str) -> TextFailure:
    return TextFailure("text_renderer_unavailable", detail)


def require_supported_platform() -> None:
    """Refuse every platform the structure layouts were not written for."""
    lp64 = ctypes.sizeof(ctypes.c_long) == 8 and ctypes.sizeof(ctypes.c_void_p) == 8
    if sys.platform != "linux" or platform.machine() not in _MACHINES or not lp64 or sys.byteorder != "little":
        raise unavailable("unsupported platform")


def load(soname: str) -> ctypes.CDLL:
    """Open a shared library by its soname through the system loader."""
    try:
        return ctypes.CDLL(soname)
    except OSError as exc:
        raise unavailable(f"cannot load {soname}") from exc


def bind(library: ctypes.CDLL, name: str, restype: Any, *argtypes: Any) -> Any:
    """A function of ``library`` with its prototype declared."""
    try:
        function = getattr(library, name)
    except AttributeError as exc:
        raise unavailable(f"missing function {name}") from exc
    function.restype = restype
    function.argtypes = argtypes
    return function
