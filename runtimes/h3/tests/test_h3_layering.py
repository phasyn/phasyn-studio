"""Layering of ``phasyn_h3`` (the rules inside this runtime; ``tools/arch`` checks the repo-wide ones).

Every module is parsed with :mod:`ast` (imports under ``if TYPE_CHECKING:`` are ignored):

* R1 ``recipe.abi`` uses only the standard library, jsonschema/referencing and ``phasyn_components.errors``;
* R2 ``recipe.adapter`` uses only ``abi`` and numpy — no GPU library, not even lazily;
* R3 ``recipe.runtime`` uses ``abi``, ``adapter``, ``phasyn_media`` (lazily), numpy and the stdlib-only
  ``phasyn_components`` modules below; GPU-environment libraries only inside functions and only in
  :data:`RUNTIME_GPU_MODULES`; it never imports the component layer;
* R4 the component layer's pure modules import no GPU-environment library and reach ``recipe.runtime``
  only through :data:`TOP_TO_RUNTIME`;
* R5 GPU-environment libraries appear in the component layer only in :data:`TOP_GPU_MODULES` (lazily).

A second check imports every module in a fresh interpreter whose import system refuses those libraries.
A deliberate new dependency changes the data here in the same review.
"""

from __future__ import annotations

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytestmark = pytest.mark.static

SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE = SRC / "phasyn_h3"

# libraries that exist only in a runtime tuple (GPU environment), never in the control plane
GPU_ENV = frozenset(
    {
        "torch",
        "torchvision",
        "torchaudio",
        "sglang",
        "triton",
        "flashinfer",
        "diffusers",
        "transformers",
        "bitsandbytes",
        "pynvml",
        "safetensors",
        "PIL",
        "vsa",
    }
)
ABI_THIRD_PARTY = frozenset({"jsonschema", "referencing", "phasyn_components.errors"})
ADAPTER_THIRD_PARTY = frozenset({"numpy"})
RUNTIME_THIRD_PARTY = frozenset(
    {
        "numpy",
        "phasyn_media",
        "phasyn_components.errors",
        "phasyn_components.model_identity",
        "phasyn_components.upstream",
    }
)
# recipe.runtime modules allowed to import GPU-environment libraries (inside functions only)
RUNTIME_GPU_MODULES = frozenset(
    {
        "accel_load",
        "adaln_sidecar",
        "attention_runtime",
        "backend",
        "bounded_fp8_load",
        "dit_trace",
        "fp8_linear",
        "host_store",
        "loaders",
        "lora",
        "lora_inplace",
        "measure",
        "pdd",
        "provider",
        "quantized_cache",
        "ref_kv_cache",
        "sglang_env",
        "stages.decode_audio",
        "stages.decode_video",
        "stages.denoise_av",
        "stages.encode_conditioning",
        "stages.encode_references",
        "stages.layout",
        "stages.prepare_media",
        "stages.presentation",
        "stages.tensor_io",
        "stages.vae_fp32_accel",
        "stages.vae_frame_streaming",
        "stages.vae_streaming",
        "stages.vae_weight_streaming",
        "upstream_patches",
    }
)
# component-layer modules that sit at the GPU boundary
TOP_GPU_MODULES = frozenset({"host", "instrument", "providers"})
# component-layer -> recipe.runtime edges besides host.py: pure helpers of the reference bundle format
TOP_TO_RUNTIME = {
    "providers": {"phasyn_h3.recipe.runtime.stages.encode_references"},  # scoped_sources (pure)
    "references": {
        "phasyn_h3.recipe.runtime.bundles",
        "phasyn_h3.recipe.runtime.errors",
        "phasyn_h3.recipe.runtime.stages.encode_references",
    },
}
STDLIB = frozenset(sys.stdlib_module_names) | {"__future__"}


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(SRC).with_suffix("").parts)
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _imports(path: Path) -> list[tuple[str, bool]]:
    """(absolute target, inside a function) for every import of ``path``, outside TYPE_CHECKING."""
    name = _module_name(path)
    package = name if path.name == "__init__.py" else name.rsplit(".", 1)[0]
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    skipped: set[int] = set()
    in_function: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and "TYPE_CHECKING" in ast.unparse(node.test):
            skipped.update(id(sub) for stmt in node.body for sub in ast.walk(stmt))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            in_function.update(id(sub) for sub in ast.walk(node) if sub is not node)
    found: list[tuple[str, bool]] = []
    for node in ast.walk(tree):
        if id(node) in skipped:
            continue
        lazy = id(node) in in_function
        if isinstance(node, ast.Import):
            found += [(alias.name, lazy) for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")[: len(package.split(".")) - (node.level - 1)]
                if node.module is None:
                    found += [(".".join([*base, alias.name]), lazy) for alias in node.names]
                    continue
                found.append((".".join([*base, node.module]), lazy))
            else:
                found.append((str(node.module), lazy))
    return found


def _layer(module: str) -> str:
    for layer in ("abi", "adapter", "runtime"):
        if module == f"phasyn_h3.recipe.{layer}" or module.startswith(f"phasyn_h3.recipe.{layer}."):
            return layer
    return "recipe" if module == "phasyn_h3.recipe" else "top"


def _allowed_external(target: str, allowed: frozenset[str]) -> bool:
    return any(target == item or target.startswith(item + ".") for item in allowed)


def _check(module: str, imports: list[tuple[str, bool]]) -> list[str]:
    """The rule violations of one module's imports."""
    problems: list[str] = []
    layer = _layer(module)
    short = module.removeprefix("phasyn_h3.recipe.runtime.").removeprefix("phasyn_h3.")
    for target, lazy in imports:
        top = target.split(".")[0]
        where = f"{module}: imports {target}{' (lazy)' if lazy else ''}"
        if top in STDLIB:
            continue
        if top == "phasyn_h3":
            to = _layer(target)
            if layer == "abi" and to != "abi":
                problems.append(f"R1 {where}")
            elif layer == "adapter" and to not in ("abi", "adapter"):
                problems.append(f"R2 {where}")
            elif layer == "runtime" and to not in ("abi", "adapter", "runtime"):
                problems.append(f"R3 {where}")
            elif (
                layer == "top"
                and to == "runtime"
                and short != "host"
                and not any(target == t or target.startswith(t + ".") for t in TOP_TO_RUNTIME.get(short, ()))
            ):
                problems.append(f"R4 {where}")
            continue
        if top in GPU_ENV:
            if layer in ("abi", "adapter", "recipe"):
                problems.append(f"R1/R2 {where}")
            elif layer == "runtime" and (not lazy or short not in RUNTIME_GPU_MODULES):
                problems.append(f"R3 {where}")
            elif layer == "top" and (not lazy or short not in TOP_GPU_MODULES):
                problems.append(f"R4/R5 {where}")
            continue
        if layer == "abi" and not _allowed_external(target, ABI_THIRD_PARTY):
            problems.append(f"R1 {where}")
        elif layer == "adapter" and not _allowed_external(target, ADAPTER_THIRD_PARTY):
            problems.append(f"R2 {where}")
        elif layer == "runtime" and not _allowed_external(target, RUNTIME_THIRD_PARTY):
            problems.append(f"R3 {where}")
        elif layer == "runtime" and top == "phasyn_media" and not lazy:
            problems.append(f"R3 {where} (phasyn_media only lazily)")
    return problems


def test_layering_rules_hold() -> None:
    problems = [p for path in sorted(PACKAGE.rglob("*.py")) for p in _check(_module_name(path), _imports(path))]
    assert problems == []


def test_the_checker_catches_gpu_imports_and_new_edges() -> None:
    assert _check("phasyn_h3.recipe.adapter.probe", [("torch", True)]) == [
        "R1/R2 phasyn_h3.recipe.adapter.probe: imports torch (lazy)"
    ]
    assert _check("phasyn_h3.plan", [("torch", True)]) == ["R4/R5 phasyn_h3.plan: imports torch (lazy)"]
    assert _check("phasyn_h3.recipe.runtime.policy", [("sglang.multimodal_gen", True)])  # not a GPU module
    assert _check("phasyn_h3.recipe.runtime.loaders", [("torch", False)])  # GPU imports only inside functions
    assert _check("phasyn_h3.recipe.runtime.loaders", [("phasyn_h3.plan", True)])  # never the component layer
    assert _check("phasyn_h3.config", [("phasyn_h3.recipe.runtime.provider", True)])  # only through host.py
    assert _check("phasyn_h3.recipe.abi.stage", [("phasyn_components.recorder", False)])
    assert _check("phasyn_h3.host", [("phasyn_h3.recipe.runtime.provider", True)]) == []


def test_every_module_imports_without_the_gpu_environment() -> None:
    """Fresh interpreter whose import system refuses every GPU-environment library."""
    modules = sorted(_module_name(p) for p in PACKAGE.rglob("*.py"))
    script = textwrap.dedent(
        f"""
        import importlib, importlib.abc, sys

        BLOCKED = {sorted(GPU_ENV)!r}

        class Refuse(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                if name.split(".")[0] in BLOCKED:
                    raise ImportError(f"blocked GPU-environment import: {{name}}")
                return None

        sys.meta_path.insert(0, Refuse())
        for name in {modules!r}:
            importlib.import_module(name)
        loaded = sorted(n for n in sys.modules if n.split(".")[0] in BLOCKED)
        assert not loaded, loaded
        print(len({modules!r}))
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
        env={"PYTHONPATH": str(SRC), "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    assert int(result.stdout.strip()) == len(modules)
