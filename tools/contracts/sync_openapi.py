#!/usr/bin/env python3
"""Generate ``contracts/openapi.json`` ``components.schemas`` from ``contracts/component.schema.json``.

The JSON Schema ``$defs`` are the single source of truth for every wire object. The OpenAPI document
keeps its hand-written ``info``, ``servers``, ``tags`` and ``paths``; its ``components.schemas`` are a
generated mirror of ``$defs`` with ``#/$defs/X`` references rewritten to ``#/components/schemas/X``.

Usage (stdlib only; run with ``python3 -I``)::

    python3 -I tools/contracts/sync_openapi.py            # rewrite openapi.json in place
    python3 -I tools/contracts/sync_openapi.py --check    # exit 1 when openapi.json has drifted

The pytest suite runs the ``--check`` mode, so a schema edit without a sync fails `tools/check.sh`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / "contracts" / "component.schema.json"
OPENAPI = REPO / "contracts" / "openapi.json"
DEFS_REF = "#/$defs/"
COMPONENTS_REF = "#/components/schemas/"


def rewrite_refs(node: Any) -> Any:
    """Deep copy of ``node`` with every ``$defs`` reference pointed at ``components/schemas``."""
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str) and value.startswith(DEFS_REF):
                out[key] = COMPONENTS_REF + value[len(DEFS_REF) :]
            else:
                out[key] = rewrite_refs(value)
        return out
    if isinstance(node, list):
        return [rewrite_refs(item) for item in node]
    return node


def render(document: Any) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


def synced_openapi(schema: dict[str, Any], openapi: dict[str, Any]) -> dict[str, Any]:
    document = dict(openapi)
    components = dict(document.get("components") or {})
    components["schemas"] = rewrite_refs(schema["$defs"])
    document["components"] = components
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="only report drift; do not write")
    parser.add_argument("--schema", type=Path, default=SCHEMA)
    parser.add_argument("--openapi", type=Path, default=OPENAPI)
    args = parser.parse_args(argv)

    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    current_text = args.openapi.read_text(encoding="utf-8")
    expected_text = render(synced_openapi(schema, json.loads(current_text)))
    if current_text == expected_text:
        return 0
    if args.check:
        print(
            f"{args.openapi.name} is out of sync with {args.schema.name}; "
            "run: python3 -I tools/contracts/sync_openapi.py",
            file=sys.stderr,
        )
        return 1
    args.openapi.write_text(expected_text, encoding="utf-8")
    print(f"updated {args.openapi.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
