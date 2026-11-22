"""Check the installed native worker before provisioning 14B checkpoints."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from phasyn_components.errors import ComponentError
from phasyn_media.errors import MediaError

from . import sandbox, sources


def main() -> int:
    """Check the engine, optional model inventory and native GPU imports."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True, type=Path)
    parser.add_argument("--role", required=True, choices=tuple(sources.MODELS))
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    try:
        with TemporaryDirectory(prefix="wan-verify-") as tmp:
            root = Path(tmp)
            engine, work = root / "engine", root / "work"
            engine.mkdir()
            work.mkdir()
            sources.stage_engine(args.engine, engine)
            report: dict[str, Any] = {
                "role": args.role,
                "engine": sources.ENGINE_REVISION,
                "source_files": len(sources.pins("source")),
            }
            if args.weights is not None:
                verified = sources.verified_installation(
                    args.weights, engine, args.role
                )
                report.update(
                    model_revision=sources.MODELS[args.role][1],
                    model_files=len(verified.files),
                )
            if not args.source_only:
                gpu = os.environ.get("CUDA_VISIBLE_DEVICES", "")
                report["runtime"] = sandbox.preflight(gpu, engine, work, args.role)
    except (ComponentError, MediaError) as exc:
        details = (
            exc.details
            if isinstance(exc, ComponentError)
            else {"field_paths": exc.field_paths}
        )
        sys.stderr.write(
            json.dumps(
                {"error": exc.code, "message": exc.message, "details": details},
                ensure_ascii=False,
            )
            + "\n"
        )
        return 1
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
