"""Phasyn Studio controller (no torch).

One HTTP endpoint: frontend static files, the component catalog, the plain runner, settings/control
forwarding, and the recording index with query and export. No CUDA, weights, failover, GPU scheduling,
login or approval.

Importing the package is cheap: the FastAPI app, its routes and the server entry point load on first use.
"""

from __future__ import annotations

import importlib
from importlib.metadata import PackageNotFoundError, version
from typing import TYPE_CHECKING, Any


try:
    VERSION = __version__ = version("phasyn-controller")
except (
    PackageNotFoundError
):  # imported from a source tree that was never installed: say so, never guess
    VERSION = __version__ = "0+unknown"

_LAZY = {
    "create_app": ".app",
    "ConfigError": ".config",
    "ControllerConfig": ".config",
    "load_config": ".config",
    "run": ".main",
    "serve": ".main",
}

if TYPE_CHECKING:
    from .app import create_app
    from .config import ConfigError, ControllerConfig, load_config
    from .main import run, serve


def __getattr__(name: str) -> Any:
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(importlib.import_module(module, __name__), name)


__all__ = [
    "VERSION",
    "ConfigError",
    "ControllerConfig",
    "__version__",
    "create_app",
    "load_config",
    "run",
    "serve",
]
