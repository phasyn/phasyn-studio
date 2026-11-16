#!/usr/bin/env python3
"""Generate ``contracts/error-codes.json`` from ``phasyn_components.errors.ERROR_CODES``.

The Python registry is the authority; the JSON copy is what clients without Python read (the
frontend's error headlines). Run it in the workspace
environment, since it imports ``phasyn_components``::

    uv run python tools/contracts/error_codes.py            # rewrite the JSON
    uv run python tools/contracts/error_codes.py --check    # exit 1 when the JSON has drifted
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from phasyn_components.errors import error_registry

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "contracts" / "error-codes.json"


def render() -> str:
    return json.dumps(error_registry(), ensure_ascii=False, indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="only report drift; do not write")
    args = parser.parse_args(argv)
    expected = render()
    current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
    if current == expected:
        return 0
    if args.check:
        print(f"{TARGET.name} is out of date; run: uv run python tools/contracts/error_codes.py", file=sys.stderr)
        return 1
    TARGET.write_text(expected, encoding="utf-8")
    print(f"updated {TARGET.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
