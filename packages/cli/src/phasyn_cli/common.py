"""Small helpers shared by the ``phasyn-studio`` subcommands."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .service import EXIT_FAILED, EXIT_USAGE, ServiceError

EXIT_OK = 0


def config_path(value: str) -> Path:
    """An existing configuration file (exit code 2 otherwise)."""
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ServiceError(f"找不到設定檔：{path}", EXIT_USAGE)
    return path


def print_json(doc: Any) -> None:
    sys.stdout.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")


__all__ = ["EXIT_FAILED", "EXIT_OK", "EXIT_USAGE", "config_path", "print_json"]
