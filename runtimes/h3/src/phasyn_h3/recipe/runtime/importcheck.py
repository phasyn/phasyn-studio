"""Post-install check: every SGLang symbol this shim imports exists in the env.

The shim imports SGLang lazily (inside stage functions), so a broken tuple env
would otherwise surface only when a job reaches that stage.  This collects every
``from sglang... import name`` / ``import sglang...`` in the package source with
``ast`` and imports them under the component process's offline environment (never touches the
network).

By default no GPU is visible (``CUDA_VISIBLE_DEVICES=""``).  The pinned H3 stage
package imports the third-party ``vsa`` kernel package, which calls
``torch.cuda.get_device_capability()`` at import time, so those modules are
listed under ``requires_gpu`` instead of failing; ``--device <GPU UUID>`` makes
that one GPU visible (creating a CUDA context on it) for the complete check.
``--pins`` also checks every pinned upstream source the recipe patches (``pins.py``) and the private
attributes it reads.

    phasyn-h3-importcheck [--device GPU-…] [--pins]   # exit 0 = nothing missing or mismatched
"""

from __future__ import annotations

import argparse
import ast
import importlib
import json
import os
import sys
from pathlib import Path

from phasyn_components.upstream import mismatches

from ._observations import RuntimeObservation
from .pins import SOURCES, pins
from .sglang_env import OFFLINE_ENV


PACKAGE_DIR = Path(__file__).resolve().parent


def collect_sglang_imports(root: Path = PACKAGE_DIR) -> dict[str, set[str]]:
    """``{module: {imported names}}`` for every sglang import in ``root`` (no imports run)."""
    found: dict[str, set[str]] = {}
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                if node.module == "sglang" or node.module.startswith("sglang."):
                    found.setdefault(node.module, set()).update(
                        a.name for a in node.names if a.name != "*"
                    )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "sglang" or alias.name.startswith("sglang."):
                        found.setdefault(alias.name, set())
    return found


def missing_imports(root: Path = PACKAGE_DIR) -> tuple[int, list[dict[str, str]]]:
    """Import every SGLang module/name the shim uses in the current environment.

    Returns ``(names checked, failures)``.  Does not touch the environment, so it
    also serves the in-actor ``runtime.sglang_h3`` probe (device already narrowed).
    """
    failures: list[dict[str, str]] = []
    checked = 0
    for module, names in sorted(collect_sglang_imports(root).items()):
        with RuntimeObservation() as package_import:
            mod = importlib.import_module(module)
        if (exc := package_import.error) is not None:
            failures.append(
                {"module": module, "error": f"{type(exc).__name__}: {exc}"[:500]}
            )
            continue
        for name in sorted(names):
            checked += 1
            if not hasattr(mod, name):
                with RuntimeObservation() as symbol_import:
                    importlib.import_module(f"{module}.{name}")
                if symbol_import.error is not None:
                    failures.append(
                        {"module": module, "error": f"missing name {name!r}"}
                    )
    return checked, failures


NO_GPU_ERROR = "No CUDA GPUs are available"


def pin_report() -> dict[str, object]:
    """Every source pin of ``pins.SOURCES`` against the installed SGLang.

    A pinned module that cannot be imported without a visible GPU (the third-party ``vsa`` kernel
    package queries the device at import) is listed under ``requires_gpu`` instead of failing,
    like the import check above; ``--device`` checks those too.
    """
    requires_gpu: list[str] = []
    checkable = []
    for group in SOURCES:
        for pin in pins(group):
            module = SOURCES[group][pin.label][0]
            with RuntimeObservation() as source_import:
                importlib.import_module(module)
            if (exc := source_import.error) is not None and NO_GPU_ERROR in str(exc):
                requires_gpu.append(pin.label)
                continue
            checkable.append(pin)
    found = mismatches(checkable)
    return {
        "checked": len(checkable),
        "requires_gpu": sorted(requires_gpu),
        "mismatches": [
            {"label": m.label, "expected": m.expected, "actual": m.actual}
            for m in found
        ],
    }


def run(
    root: Path = PACKAGE_DIR, device: str | None = None, *, check_pins: bool = False
) -> dict[str, object]:
    """Check the imports required by the pinned H3 runtime."""
    os.environ["CUDA_VISIBLE_DEVICES"] = device or ""  # hidden unless one GPU is named

    for key, value in OFFLINE_ENV.items():
        os.environ.setdefault(key, value)
    checked, failures = missing_imports(root)
    needs_gpu = [f for f in failures if not device and NO_GPU_ERROR in f["error"]]
    torch = sys.modules.get("torch")  # imported by sglang when it loaded at all
    report: dict[str, object] = {
        "modules": len(collect_sglang_imports(root)),
        "names_checked": checked,
        "failures": [f for f in failures if f not in needs_gpu],
        "requires_gpu": sorted(f["module"] for f in needs_gpu),
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        "torch": getattr(torch, "__version__", None),
    }
    if check_pins:
        report["pins"] = pin_report()
    return report


def main(argv: list[str] | None = None) -> int:
    """Run the H3 runtime import and pin checks."""
    parser = argparse.ArgumentParser(prog="phasyn-h3-importcheck")
    parser.add_argument(
        "--device",
        default=None,
        help="GPU UUID to make visible for modules that need CUDA at import",
    )
    parser.add_argument(
        "--pins",
        action="store_true",
        help="also check the pinned upstream sources (pins.py)",
    )
    args = parser.parse_args(argv)
    report = run(device=args.device, check_pins=args.pins)
    sys.stdout.write(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    pins = report.get("pins")
    mismatched = bool(pins["mismatches"]) if isinstance(pins, dict) else False
    return 1 if report["failures"] or mismatched else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
