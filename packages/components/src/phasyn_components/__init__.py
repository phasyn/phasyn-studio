"""Phasyn Studio core (no torch).

The controller, Nodes, component processes and GPU runtimes all import this package; no module may
load torch, CUDA or NVML at import time. GPU-only recorder hooks live in
``phasyn_components.recorder.gpu`` and are imported by GPU components after ``load()``.

``PROTOCOL_VERSION`` and ``SCHEMA_VERSION`` are wire values (contracts ``$id`` 4.0) and are defined
only here; the package version comes from the installed distribution metadata.
"""

from importlib.metadata import PackageNotFoundError, version


PROTOCOL_VERSION = "4.0"
SCHEMA_VERSION = "4.0"
try:
    __version__ = version("phasyn-components")
except (
    PackageNotFoundError
):  # imported from a source tree that was never installed: say so, never guess
    __version__ = "0+unknown"

__all__ = ["PROTOCOL_VERSION", "SCHEMA_VERSION", "__version__"]
