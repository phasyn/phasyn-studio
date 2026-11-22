"""Synthetic identifiers for tests, fixtures and documentation.

Every value is UUIDv4-shaped (it passes :func:`phasyn_components.ids.is_uuid`) but sits under the
all-zero ``00000000-0000-4000-8000-`` prefix, so it can never be mistaken for a real controller,
Node, run or GPU. Use these instead of ``uuid.uuid4()`` whenever a test needs a stable id, and
never paste ids from a real deployment into a test.
"""

from __future__ import annotations


PREFIX = "00000000-0000-4000-8000-"

CONTROLLER_ID = PREFIX + "0000000000c1"
NODE_A_ID = PREFIX + "0000000000a1"
NODE_B_ID = PREFIX + "0000000000b1"
NODE_C_ID = PREFIX + "0000000000a2"  # a third Node, for the rare test that needs one

_SERIAL_LIMIT = 10**12


def uid(n: int) -> str:
    """Serial synthetic UUID for runs, calls, recordings, files and so on.

    The serial is written with decimal digits, so ``uid(1001)`` reads back as
    ``00000000-0000-4000-8000-000000001001``; it can never collide with the Node or controller
    constants above.
    """
    if not 0 <= n < _SERIAL_LIMIT:
        raise ValueError(f"synthetic id serial must be in [0, {_SERIAL_LIMIT}): {n}")
    return f"{PREFIX}{n:012d}"


def gpu_uuid(n: int) -> str:
    """Synthetic NVML-style GPU UUID: ``gpu_uuid(1)`` -> ``GPU-00000000-0000-4000-8000-000000000001``."""
    return "GPU-" + uid(n)


__all__ = [
    "CONTROLLER_ID",
    "NODE_A_ID",
    "NODE_B_ID",
    "NODE_C_ID",
    "PREFIX",
    "gpu_uuid",
    "uid",
]
