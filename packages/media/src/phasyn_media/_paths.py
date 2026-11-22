"""Local filesystem path conversions shared by media worker and tool callers."""

from __future__ import annotations

import os
from pathlib import Path


def absolute(path: str | os.PathLike[str]) -> Path:
    """Normalize an absolute path lexically, leaving symlinks unresolved."""
    return Path(os.path.normpath(Path.cwd() / path))
