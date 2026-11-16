"""Repository-wide contract checks: generated files are in sync, every raised error code is registered."""

from __future__ import annotations

import ast
import importlib.util
import json
import re
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
import sync_studio_plugins
from phasyn_components import timeline_limits
from phasyn_components.errors import ERROR_CODES, NOTICE_CODES

pytestmark = pytest.mark.static

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")
CONSTRUCTORS = {"ComponentError", "MediaError", "error_dict"}


def _product_sources() -> Iterator[Path]:
    for pattern in ("packages/*/src", "runtimes/*/src"):
        for root in sorted(REPO.glob(pattern)):
            yield from sorted(root.rglob("*.py"))


def _literal(node: ast.AST | None) -> str:
    value = node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""
    return value if CODE.match(value) else ""


def _codes_in(path: Path) -> Iterator[tuple[str, str, int]]:
    """``(kind, code, line)`` for every code written literally where it reaches a client.

    ``error``: the first argument of an error constructor, or the ``"code"`` of a dict literal that
    also has a ``"message"`` (wire ``Error`` objects, IPC error messages, run errors, blockers).
    ``notice``: the first argument of ``Recorder.notice(...)``.
    """
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Call) and node.args:
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
            code = _literal(node.args[0])
            if code and name in CONSTRUCTORS:
                yield "error", code, node.lineno
            elif code and name == "notice":
                yield "notice", code, node.lineno
        elif isinstance(node, ast.Dict):
            keys = {k.value: v for k, v in zip(node.keys, node.values, strict=True) if isinstance(k, ast.Constant)}
            code = _literal(keys.get("code")) if "message" in keys else ""
            if code:
                yield "error", code, node.lineno


def test_studio_plugin_files_are_in_sync() -> None:
    """The files derived from the built-in plugin packages are current, and the checks of
    ``sync_studio_plugins.py`` hold: built-in packages valid, limits in code and contract equal, the shared rule
    vectors consistent with the reference evaluator, example packages equal to their built archives."""
    outdated = [str(path.relative_to(REPO)) for path in sync_studio_plugins.stale()]
    assert not outdated, f"out of date: {outdated}; run: {sync_studio_plugins.COMMAND}"
    problems = sync_studio_plugins.check_problems()
    assert not problems, "\n".join(problems)


def test_every_raised_error_and_notice_code_is_registered() -> None:
    registries = {"error": ERROR_CODES, "notice": NOTICE_CODES}
    missing = [
        f"{path.relative_to(REPO)}:{line} {kind} {code}"
        for path in _product_sources()
        for kind, code, line in _codes_in(path)
        if code not in registries[kind]
    ]
    assert not missing, "register these in phasyn_components.errors (ERROR_CODES / NOTICE_CODES):\n" + "\n".join(
        missing
    )


def _limits_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("timeline_limits_generator", HERE / "timeline_limits.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_timeline_limits_are_generated_from_the_schema() -> None:
    """The Python and TypeScript constants of the timeline bounds repeat nothing by hand."""
    generator = _limits_generator()
    values = generator.limits(json.loads(generator.SCHEMA.read_text(encoding="utf-8")))
    stale = [
        path.name
        for path, text in (
            (generator.PYTHON_OUT, generator.render_python(values)),
            (generator.TS_OUT, generator.render_typescript(values)),
        )
        if path.read_text(encoding="utf-8") != text
    ]
    assert not stale, f"out of date: {stale}; run: {generator.COMMAND}"
    assert {name: getattr(timeline_limits, name) for name in values} == values
