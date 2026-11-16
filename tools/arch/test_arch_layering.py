"""Architecture guard: package layering and a torch-free control plane.

Every source module is parsed with :mod:`ast` (nothing is imported) and each import is checked against
:data:`LAYERS`:

* a layer must never import the top-level modules listed in its ``forbidden`` set (eager or lazy);
* control-plane layers must not import GPU libraries at module import time; heavy GPU libraries
  (torch, sglang, diffusers, ...) are allowed lazily only in :data:`LAZY_GPU_ALLOWED`, while NVML
  (``pynvml``, an optional extra) may be imported lazily anywhere;
* ``stdlib_only`` layers (the agent plugin) may import only the standard library and themselves;
* ``sdk_client`` layers (the GPU runtimes) use only the public ``RunContext`` API: reading a private attribute
  such as ``ctx._output_types`` couples a runtime to ``phasyn_components`` internals.

Imports under ``if TYPE_CHECKING:`` are ignored. ``importlib.import_module("<literal>")`` and
``__import__("<literal>")`` count as lazy imports; computed targets such as the provider registry's
``"module:Class"`` strings are deliberately out of scope: they are data resolved inside the component process. Rules inside a runtime (for example the H3 recipe layers) belong to
that runtime's own tests.

There is no baseline: any violation fails. Fix the import (or, for a deliberate new dependency, change
:data:`LAYERS` in the same review) rather than suppressing the finding.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

pytestmark = pytest.mark.static

REPO = Path(__file__).resolve().parents[2]

PHASYN_LIBS = frozenset({"phasyn_components", "phasyn_media", "phasyn_server"})
APPS = frozenset({"phasyn_node", "phasyn_controller", "phasyn_cli"})
RUNTIMES = frozenset({"phasyn_h3", "phasyn_qimg", "phasyn_captioner"})
WEB = frozenset({"fastapi", "starlette", "uvicorn", "httpx"})
HEAVY_GPU = frozenset(
    {
        "torch",
        "torchvision",
        "torchaudio",
        "sglang",
        "diffusers",
        "transformers",
        "flashinfer",
        "triton",
        "bitsandbytes",
    }
)
NVML = frozenset({"pynvml"})

# Repo-relative files allowed to import HEAVY_GPU lazily (GPU recorder hooks run inside runtime processes).
LAZY_GPU_ALLOWED = frozenset({"packages/components/src/phasyn_components/recorder/gpu.py"})


@dataclass(frozen=True)
class Layer:
    name: str
    root: str  # repo-relative package directory
    forbidden: frozenset[str] = frozenset()
    control_plane: bool = False
    stdlib_only: bool = False
    sdk_client: bool = False


def _runtime(name: str, root: str) -> Layer:
    forbidden = APPS | {"phasyn_server"} | (RUNTIMES - {name}) | WEB
    return Layer(name, root, forbidden=forbidden, sdk_client=True)


LAYERS: tuple[Layer, ...] = (
    Layer(
        "phasyn_components",
        "packages/components/src/phasyn_components",
        forbidden=(PHASYN_LIBS - {"phasyn_components"}) | APPS | RUNTIMES | WEB,
        control_plane=True,
    ),
    Layer(
        "phasyn_media",
        "packages/media/src/phasyn_media",
        forbidden=frozenset({"phasyn_server"}) | APPS | RUNTIMES | WEB,
        control_plane=True,
    ),
    Layer(
        "phasyn_server",
        "packages/server/src/phasyn_server",
        forbidden=frozenset({"phasyn_media"}) | APPS | RUNTIMES,
        control_plane=True,
    ),
    Layer(
        "phasyn_node",
        "packages/node/src/phasyn_node",
        forbidden=frozenset({"phasyn_media", "phasyn_controller", "phasyn_cli"}) | RUNTIMES,
        control_plane=True,
    ),
    Layer(
        "phasyn_controller",
        "packages/controller/src/phasyn_controller",
        forbidden=frozenset({"phasyn_media", "phasyn_node", "phasyn_cli"}) | RUNTIMES,
        control_plane=True,
    ),
    Layer("phasyn_cli", "packages/cli/src/phasyn_cli", forbidden=RUNTIMES, control_plane=True),
    _runtime("phasyn_h3", "runtimes/h3/src/phasyn_h3"),
    _runtime("phasyn_qimg", "runtimes/qimg/src/phasyn_qimg"),
    _runtime("phasyn_captioner", "runtimes/captioner/src/phasyn_captioner"),
)

_SKIP_DIRS = frozenset({"tests", "__pycache__", ".venv", "node_modules", "build", "dist"})
# Names the runtimes use for RunContext/LoadContext objects.
CONTEXT_NAMES = frozenset({"ctx"})


@dataclass(frozen=True)
class Imp:
    file: str
    line: int
    module: str
    lazy: bool

    @property
    def top(self) -> str:
        return self.module.split(".", 1)[0]


@dataclass(frozen=True)
class Violation:
    file: str
    line: int
    imported: str  # top-level module
    message: str

    def __str__(self) -> str:
        return f"{self.file}:{self.line}: {self.message}"


def _is_type_checking(test: ast.expr) -> bool:
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    return isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"


def _dynamic_target(call: ast.Call) -> str | None:
    """Literal target of ``importlib.import_module("x")`` / ``__import__("x")``; anything computed is ignored."""
    func = call.func
    named = (isinstance(func, ast.Attribute) and func.attr == "import_module") or (
        isinstance(func, ast.Name) and func.id in {"import_module", "__import__"}
    )
    if named and call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
        return call.args[0].value
    return None


def iter_imports(tree: ast.AST, rel: str) -> Iterator[Imp]:
    def visit(node: ast.AST, lazy: bool) -> Iterator[Imp]:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.If) and _is_type_checking(child.test):
                yield from visit(ast.Module(body=child.orelse, type_ignores=[]), lazy)
                continue
            if isinstance(child, ast.Import):
                for alias in child.names:
                    yield Imp(rel, child.lineno, alias.name, lazy)
            elif isinstance(child, ast.ImportFrom) and child.level == 0 and child.module:
                yield Imp(rel, child.lineno, child.module, lazy)
            elif isinstance(child, ast.Call) and (target := _dynamic_target(child)) and not target.startswith("."):
                yield Imp(rel, child.lineno, target, True)
            nested = lazy or isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
            yield from visit(child, nested)

    yield from visit(tree, False)


def iter_private_context(tree: ast.AST) -> Iterator[tuple[int, str]]:
    """``(line, attribute)`` for every ``ctx._name`` read (dunder attributes such as ``__class__`` are fine)."""
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id in CONTEXT_NAMES
            and node.attr.startswith("_")
            and not (node.attr.startswith("__") and node.attr.endswith("__"))
        ):
            yield node.lineno, node.attr


def _source_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*.py")):
        if not _SKIP_DIRS.intersection(path.relative_to(root).parts[:-1]):
            yield path


def check_import(layer: Layer, imp: Imp) -> str | None:
    top = imp.top
    if top in layer.forbidden:
        return f"{layer.name} must not import {imp.module}{' (lazy)' if imp.lazy else ''}"
    if layer.stdlib_only and top != layer.name and top not in sys.stdlib_module_names:
        return f"{layer.name} must use only the standard library, imports {imp.module}"
    if layer.control_plane and top in HEAVY_GPU | NVML:
        if not imp.lazy:
            return f"control plane imports {imp.module} at module import time"
        if top in HEAVY_GPU and imp.file not in LAZY_GPU_ALLOWED:
            return f"control plane imports {imp.module} lazily outside the GPU allowlist"
    return None


def scan(repo: Path = REPO, layers: tuple[Layer, ...] = LAYERS) -> list[Violation]:
    found: list[Violation] = []
    for layer in layers:
        root = repo / layer.root
        if not root.is_dir():
            continue
        for path in _source_files(root):
            rel = path.relative_to(repo).as_posix()
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
            except (SyntaxError, UnicodeDecodeError) as exc:
                found.append(Violation(rel, getattr(exc, "lineno", 0) or 0, "", f"cannot parse: {exc}"))
                continue
            for imp in iter_imports(tree, rel):
                message = check_import(layer, imp)
                if message is not None:
                    found.append(Violation(rel, imp.line, imp.top, message))
            if layer.sdk_client:
                for line, attr in iter_private_context(tree):
                    message = f"{layer.name} reads the private RunContext attribute ctx.{attr}; use the public API"
                    found.append(Violation(rel, line, "", message))
    return found


# ---------------------------------------------------------------------------------------------- repository


def test_repository_layering() -> None:
    found = scan()
    assert not found, "layering violations (see tools/arch/test_arch_layering.py):\n" + "\n".join(map(str, found))


def test_every_layer_root_exists() -> None:
    missing = [layer.root for layer in LAYERS if not (REPO / layer.root).is_dir()]
    assert not missing, f"layer roots moved or renamed; update LAYERS: {missing}"


def test_every_package_ships_the_licence_and_notice() -> None:
    """A wheel or sdist takes its licence files from the package directory, so each one keeps a copy of the
    repository's LICENSE and NOTICE (the notice carries the attributions of the adapted upstream code)."""
    packages = sorted(
        path.parent
        for pattern in ("packages/*", "runtimes/*", "plugins/*")
        for path in REPO.glob(f"{pattern}/pyproject.toml")
    )
    assert packages, "no package manifests found"
    stale = [
        f"{package.relative_to(REPO)}/{name}"
        for package in packages
        for name in ("LICENSE", "NOTICE")
        if not (package / name).is_file() or (package / name).read_bytes() != (REPO / name).read_bytes()
    ]
    assert not stale, f"copy the repository's LICENSE and NOTICE into: {stale}"


# ---------------------------------------------------------------------------------------------- self-tests
