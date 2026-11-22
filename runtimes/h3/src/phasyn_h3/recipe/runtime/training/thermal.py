"""Host temperature and memory readings for the trainer's gates (no GPU library; ``nvidia-smi`` for the GPU).

The SoC temperature is the hottest ``/sys/class/thermal`` zone. A reading that cannot be taken is ``None`` and
never counts as hot or cool by itself (the other reading decides). Required host services (for example a
clock-lock unit an installation relies on) are checked with ``systemctl is-active`` before training starts.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path


_TIMEOUT_S = 20
_UNIT = r"^[A-Za-z0-9@_.-]{1,128}$"


def soc_celsius() -> float | None:
    """Hottest thermal zone in degrees Celsius, or None when none can be read."""
    values = []
    for f in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            values.append(int(f.read_text().strip()) / 1000.0)
        except (OSError, ValueError):
            continue
    return max(values) if values else None


def gpu_celsius() -> float | None:
    """GPU temperature from ``nvidia-smi``, or None when it cannot be read."""
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return None
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, absolute executable
            [exe, "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
            check=False,
        ).stdout
        return float(out.split()[0])
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


def inactive_units(units: Sequence[str]) -> list[str]:
    """The host units of ``units`` that are not active (all of them when systemctl is missing)."""
    exe = shutil.which("systemctl")
    if exe is None:
        return list(units)
    bad = []
    for unit in units:
        if not re.fullmatch(_UNIT, unit):
            bad.append(unit)
            continue
        try:
            state = subprocess.run(  # noqa: S603 - validated unit name, absolute executable
                [exe, "is-active", unit],
                capture_output=True,
                text=True,
                timeout=_TIMEOUT_S,
                check=False,
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            state = "unknown"
        if state != "active":
            bad.append(unit)
    return bad


def mem_available_gib() -> float | None:
    """``MemAvailable`` of the host in GiB."""
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1048576
    except (OSError, ValueError, IndexError):
        return None
    return None


__all__ = ["gpu_celsius", "inactive_units", "mem_available_gib", "soc_celsius"]
