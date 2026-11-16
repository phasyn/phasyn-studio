"""Emit `[[tool.uv.dependency-metadata]]` for the pinned SGLang source tree.

SGLang declares `dynamic = ["version"]` (setuptools-scm + a git-describe
script) and needs torch==2.14.1 plus setuptools-rust just to *build metadata*.
`uv lock` would therefore download a CUDA torch into an isolated build
environment only to read `Requires-Dist`.  This helper copies the dependency
list verbatim from the pinned `python/pyproject.toml` (no hand transcription),
so the lock is derived from the exact source revision without building it.

Usage (read-only; run with an isolated interpreter):

    python -I deploy/runtimes/_tools/sglang_dependency_metadata.py \
        <sglang-checkout>/python/pyproject.toml <version>
    python -I deploy/runtimes/_tools/sglang_dependency_metadata.py \
        <sglang-checkout>/python/pyproject.toml --check deploy/runtimes/<tuple>/pyproject.toml

`<version>` is the setuptools-scm version the pinned SHA builds as, or `-` to
omit it (the block then applies to whatever version the git source builds as;
see README "SGLang version").  `--check` verifies that the block embedded in a
tuple project still matches the pinned pyproject.
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

# Only the extras the MiniMax H3 multimodal path imports.  `diffusion` is the
# upstream-declared extra of `sglang.multimodal_gen` (cache_dit, diffusers,
# av, imageio, PyYAML, opencv ... are imported at module level by the H3
# stage chain).  ray/tracing/http2/fastokens/test/runai/... are not needed.
EXTRAS = ("diffusion",)


def requires_dist(pyproject: dict) -> list[str]:
    project = pyproject["project"]
    out = [str(r) for r in project["dependencies"]]
    for extra in EXTRAS:
        for raw in project["optional-dependencies"][extra]:
            req = str(raw)
            if ";" in req:
                spec, marker = req.split(";", 1)
                out.append(f"{spec.strip()} ; ({marker.strip()}) and extra == '{extra}'")
            else:
                out.append(f"{req.strip()} ; extra == '{extra}'")
    return out


def render(pyproject: dict, version: str) -> str:
    lines = [
        "[[tool.uv.dependency-metadata]]",
        'name = "sglang"',
        f"requires-python = {json.dumps(pyproject['project']['requires-python'])}",
        f"provides-extra = {json.dumps(list(EXTRAS))}",
        "requires-dist = [",
    ]
    if version != "-":
        lines.insert(2, f"version = {json.dumps(version)}")
    lines += [f"    {json.dumps(r, ensure_ascii=False)}," for r in requires_dist(pyproject)]
    lines.append("]")
    return "\n".join(lines) + "\n"


def check(pyproject: dict, tuple_project: Path) -> int:
    doc = tomllib.loads(tuple_project.read_text(encoding="utf-8"))
    blocks = [b for b in doc.get("tool", {}).get("uv", {}).get("dependency-metadata", []) if b.get("name") == "sglang"]
    if len(blocks) != 1:
        print(f"{tuple_project}: expected exactly one sglang dependency-metadata block", file=sys.stderr)
        return 1
    expected = requires_dist(pyproject)
    if blocks[0].get("requires-dist") != expected:
        print(f"{tuple_project}: sglang requires-dist drifted from the pinned pyproject", file=sys.stderr)
        return 1
    print(f"{tuple_project}: sglang dependency-metadata matches ({len(expected)} requirements)")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--check":
        return check(tomllib.loads(Path(argv[0]).read_text(encoding="utf-8")), Path(argv[2]))
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    pyproject = tomllib.loads(Path(argv[0]).read_text(encoding="utf-8"))
    sys.stdout.write(render(pyproject, argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
