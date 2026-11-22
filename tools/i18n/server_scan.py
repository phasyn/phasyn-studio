#!/usr/bin/env python3
"""Static scan of server-side UI strings for i18n (standard library only; run with ``python3 -I``).

Finds the fixed Traditional Chinese texts that the server sends to the frontend verbatim, so the UI can look
them up by exact source text (``tServer(text)``):
  - provider / component settings-schema titles, descriptions and ``x-unavailable`` notes; port descriptions,
    part reasons, labels
  - fixed note / reason / message literals and error-message literals (``ComponentError`` …; the UI shows a
    localized headline from the error code as well)
  - contracts: RecorderConfig schema descriptions (SchemaForm fallback) and metric-catalog rules
Not collected: docstrings, log / print calls, CLI help, asserts, internal exceptions (ValueError …), f-strings
and concatenations (dynamic; listed separately).

Usage::

    python3 -I tools/i18n/server_scan.py --out server-raw.json \\
        [--catalog live-catalog.json] [--pipelines live-pipelines.json] [--dynamic-out dyn.json] [--config-out cfg.json]

``--catalog`` / ``--pipelines`` are saved GET /api/catalog and /api/pipelines responses (the script never
connects to anything); they report coverage and add fixed texts that are only assembled at run time.
The completeness test is ``tools/i18n/test_server_catalog.py``; ``pnpm i18n:check`` runs this scanner too.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import Counter
from pathlib import Path

CJK = re.compile(r"[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]")
CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")
SOURCE_DIRS = [
    "packages/components/src",
    "packages/node/src",
    "packages/controller/src",
    "packages/media/src",
    "packages/server/src",
    "runtimes/h3/src",
    "runtimes/captioner/src",
    "runtimes/qimg/src",
    "runtimes/rife/src",
    "runtimes/seedvr2/src",
]
# The H3 numerical recipe raises only dynamic diagnostics (f-strings) that never reach a catalog.
SKIP_SUBTREES = ("runtimes/h3/src/phasyn_h3/recipe/",)
LOG_CALLS = {
    "debug",
    "info",
    "warning",
    "warn",
    "error",
    "exception",
    "critical",
    "log",
    "_log",
    "print",
    "notice",
    "fatal",
}
INTERNAL_EXC = {
    "ValueError",
    "TypeError",
    "KeyError",
    "RuntimeError",
    "AssertionError",
    "OSError",
    "NotImplementedError",
    "LookupError",
    "AttributeError",
    "IndexError",
    "FileNotFoundError",
    "PermissionError",
    "SystemExit",
    "Exception",
}
CLI_CALLS = {"add_argument", "add_parser", "ArgumentParser", "add_subparsers", "add_argument_group"}
ERROR_CALLS = {
    "ComponentError",
    "error_dict",
    "_invalid",
    "_conflict",
    "_reject",
    "unsupported",
    "_disk_error",
    "_media_error",
    "MediaCanceled",
    "PreviewRejected",
    "RuntimeGone",
    "_failure",
    "_refuse",
    "OutputInvalid",
    "_error",
    "_bad_request",
    "_not_found",
    "fail",
    "_fail",
}
SCHEMA_CALLS = {"_null_only", "_rel_path_schema", "settings_schema", "_unavailable", "_describe"}
NOTE_RECEIVERS = re.compile(
    r"(note|notes|warning|warnings|reason|reasons|problem|problems|caveat|caveats|limit|limits|message|messages|issue|issues|observ)",
    re.I,
)
GROUP_BY_NAME = [
    (re.compile(r"^(title|description|summary|hint)$"), "schema"),
    (re.compile(r"(^|_)label$|^label"), "label"),
    (re.compile(r"(^|_)reason$|reason"), "reason"),
    (re.compile(r"(^|_)(message|msg)$"), "message"),
    (re.compile(r"(^|_)(note|notes|NOTE)$|NOTE"), "note"),
    (re.compile(r"^rule$"), "rule"),
    (re.compile(r"^(observed|basis|source|facts?|resident|cfg_branch)$|BASIS$"), "fact"),
]


def group_for_name(name: str | None) -> str:
    if not name:
        return "server-text"
    for pattern, group in GROUP_BY_NAME:
        if pattern.search(name):
            return group
    return "server-text"


def callee_name(call: ast.Call) -> str:
    fn = call.func
    if isinstance(fn, ast.Name):
        return fn.id
    if isinstance(fn, ast.Attribute):
        return fn.attr
    return "?"


def receiver_name(call: ast.Call) -> str:
    fn = call.func
    if isinstance(fn, ast.Attribute):
        base = fn.value
        if isinstance(base, ast.Name):
            return base.id
        if isinstance(base, ast.Attribute):
            return base.attr
    return ""


def target_name(target: ast.AST) -> str | None:
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    if (
        isinstance(target, ast.Subscript)
        and isinstance(target.slice, ast.Constant)
        and isinstance(target.slice.value, str)
    ):
        return target.slice.value
    return None


def enclosing_function(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> str | None:
    cur = parents.get(node)
    while cur is not None:
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return cur.name
        cur = parents.get(cur)
    return None


def dict_key_of(value: ast.AST, d: ast.Dict) -> str | None:
    for key, val in zip(d.keys, d.values, strict=False):
        if val is value:
            return key.value if isinstance(key, ast.Constant) and isinstance(key.value, str) else None
    return None


def classify(node: ast.Constant, parents: dict[ast.AST, ast.AST]) -> tuple[str, str, str | None]:
    """Return (decision, group, code); decision is "include" or "skip:<reason>"."""
    child: ast.AST = node
    p = parents.get(node)
    # Look through containers and conditional expressions: ["a", "b"], "a" if x else "b", x or "a"
    while isinstance(p, (ast.IfExp, ast.BoolOp, ast.List, ast.Tuple, ast.Set, ast.Starred)):
        if isinstance(p, ast.IfExp) and p.test is child:
            return "skip:condition", "", None
        child = p
        p = parents.get(p)
    if p is None:
        return "skip:orphan", "", None
    if isinstance(p, ast.Expr):
        return "skip:docstring", "", None
    if isinstance(p, ast.JoinedStr):
        return "skip:fstring-part", "", None
    if isinstance(p, (ast.BinOp, ast.AugAssign)):
        return "skip:concatenation", "", None
    if isinstance(p, ast.Attribute):
        return "skip:method-receiver", "", None  # "、".join(...)、"…".format(...)
    if isinstance(p, ast.Compare):
        return "skip:comparison", "", None
    if isinstance(p, ast.arguments):
        return "skip:default-arg", "", None
    if isinstance(p, ast.Assert):
        return "skip:assert", "", None
    if isinstance(p, ast.Dict):
        key = dict_key_of(child, p)
        if key is None and child in p.keys:
            return "skip:dict-key", "", None
        grand = parents.get(p)
        if isinstance(grand, ast.Dict) and dict_key_of(p, grand) == "x-unavailable":
            return "include", "schema", None
        if key in ("title", "description"):
            return "include", "schema", None
        if key in {"help", "about"}:
            return "include", "schema", None
        return "include", group_for_name(key), None
    if isinstance(p, ast.keyword):
        call = parents.get(p)
        name = callee_name(call) if isinstance(call, ast.Call) else "?"
        if p.arg == "help" and name in CLI_CALLS | {"add_argument"}:
            return "skip:cli-help", "", None
        if name in CLI_CALLS:
            return "skip:cli", "", None
        if p.arg in ("what", "subject", "kind", "name", "path", "prefix", "suffix", "sep"):
            return "skip:fragment-kw", "", None
        if name in LOG_CALLS:
            return "skip:log", "", None
        if name in ERROR_CALLS or name.endswith("Error"):
            return "include", "error", None
        return "include", group_for_name(p.arg), None
    if isinstance(p, ast.Call):
        name = callee_name(p)
        if (
            isinstance(p.func, ast.Attribute)
            and isinstance(p.func.value, ast.Name)
            and p.func.value.id == "re"
            and name in {"compile", "search", "match", "fullmatch"}
            and p.args
            and p.args[0] is child
        ):
            return "skip:pattern", "", None
        if name in LOG_CALLS:
            return "skip:log", "", None
        if name in INTERNAL_EXC:
            return "skip:internal-exception", "", None
        if name in CLI_CALLS:
            return "skip:cli", "", None
        if name in ERROR_CALLS or name.endswith("Error") or name.endswith("Rejected") or name.endswith("Canceled"):
            code = None
            for arg in p.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and CODE_RE.match(arg.value):
                    code = arg.value
            return "include", "error", code
        if name == "Port":
            return "include", "port", None
        if name == "Part":
            return "include", "part", None
        if name in SCHEMA_CALLS:
            return "include", "schema", None
        if name in ("append", "extend", "add", "insert"):
            recv = receiver_name(p)
            return "include", "note" if NOTE_RECEIVERS.search(recv) else "server-text", None
        if name in ("note", "_note", "add_note"):
            return "include", "note", None
        if name in (
            "get",
            "pop",
            "setdefault",
            "startswith",
            "endswith",
            "split",
            "replace",
            "find",
            "index",
            "count",
            "strip",
            "removeprefix",
            "removesuffix",
        ):
            return "skip:logic-call", "", None
        return "include", "server-text", None
    if isinstance(p, (ast.Assign, ast.AnnAssign)):
        targets = p.targets if isinstance(p, ast.Assign) else [p.target]
        assigned = next((n for n in (target_name(t) for t in targets) if n), None)
        return "include", group_for_name(assigned), None
    if isinstance(p, ast.Return):
        return "include", "server-text", None
    if isinstance(p, ast.Subscript):
        return "skip:subscript-key", "", None
    if isinstance(p, ast.Raise):
        return "skip:raise-literal", "", None
    if isinstance(p, ast.Lambda):
        return "include", "server-text", None
    return f"skip:unhandled-{type(p).__name__}", "", None


def fstring_pattern(node: ast.JoinedStr) -> tuple[str, list[str]]:
    names: list[str] = []
    out = []
    for value in node.values:
        if isinstance(value, ast.Constant):
            out.append(str(value.value))
        elif isinstance(value, ast.FormattedValue):
            expr = value.value
            if isinstance(expr, ast.Name):
                base = expr.id
            elif isinstance(expr, ast.Attribute):
                base = expr.attr
            elif isinstance(expr, ast.Call):
                base = callee_name(expr)
            else:
                base = "value"
            base = re.sub(r"[^A-Za-z0-9_]", "", base) or "value"
            name = base
            k = 2
            while name in names:
                name = f"{base}{k}"
                k += 1
            names.append(name)
            out.append("{" + name + "}")
    return "".join(out), names


def scan_python(repo: Path) -> tuple[dict, dict, Counter]:
    entries: dict[str, dict] = {}
    dynamic: dict[str, dict] = {}
    skipped: Counter = Counter()
    for rel_dir in SOURCE_DIRS:
        base = repo / rel_dir
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            rel = path.relative_to(repo).as_posix()
            if "tests" in path.parts or rel.startswith(SKIP_SUBTREES):
                continue
            tree = ast.parse(path.read_text(encoding="utf8"))
            parents: dict[ast.AST, ast.AST] = {}
            for node in ast.walk(tree):
                for ch in ast.iter_child_nodes(node):
                    parents[ch] = node
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and CJK.search(node.value):
                    decision, group, code = classify(node, parents)
                    if decision != "include":
                        skipped[decision] += 1
                        continue
                    text = node.value
                    e = entries.setdefault(
                        text, {"source": text, "placeholders": [], "where": [], "groups": Counter(), "codes": set()}
                    )
                    e["where"].append(f"{rel}:{node.lineno}")
                    e["groups"][group] += 1
                    if code:
                        e["codes"].add(code)
                elif isinstance(node, ast.JoinedStr):
                    literal = "".join(str(v.value) for v in node.values if isinstance(v, ast.Constant))
                    if not CJK.search(literal):
                        continue
                    pattern, names = fstring_pattern(node)
                    p = parents.get(node)
                    if isinstance(p, ast.Call) and callee_name(p) in LOG_CALLS:
                        skipped["skip:log-fstring"] += 1
                        continue
                    d = dynamic.setdefault(pattern, {"source": pattern, "placeholders": names, "where": []})
                    d["where"].append(f"{rel}:{node.lineno}")
    return entries, dynamic, skipped


def walk_strings(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk_strings(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_strings(v, f"{path}[]")
    elif isinstance(obj, str):
        yield path, obj


def contract_strings(repo: Path) -> list[tuple[str, str, str]]:
    """(text, where, group): titles / descriptions inside RecorderConfig (following $ref) and metric-catalog rules."""
    out: list[tuple[str, str, str]] = []
    schema_path = repo / "contracts/component.schema.json"
    if schema_path.exists():
        schema = json.loads(schema_path.read_text(encoding="utf8"))
        defs = schema.get("$defs", {})
        seen: set[str] = set()
        stack = ["RecorderConfig"]
        while stack:
            name = stack.pop()
            if name in seen or name not in defs:
                continue
            seen.add(name)
            for p, text in walk_strings(defs[name], f"$defs.{name}"):
                if p.endswith(".$ref") and text.startswith("#/$defs/"):
                    stack.append(text.split("/")[-1])
                elif re.search(r"\.(title|description)$", p) and CJK.search(text):
                    out.append((text, f"contracts/component.schema.json#{p}", "contract"))
    catalog_path = repo / "contracts/metric-catalog.json"
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding="utf8"))
        for metric in catalog.get("metrics", []):
            rule = metric.get("rule")
            if isinstance(rule, str) and CJK.search(rule):
                out.append((rule, f"contracts/metric-catalog.json#{metric.get('name')}", "metric-rule"))
    return out


LIVE_SCHEMA_PATH = re.compile(
    r"(settings_schema|parameters_schema|settings\.settings_schema|settings\.parameters_schema).*\.(title|description|help)$|x-unavailable\.[^.]+$"
)


def live_catalog_strings(catalog: dict) -> tuple[list[tuple[str, str, str]], list[tuple[str, str]]]:
    """(text, path, group) for fixed texts the UI shows, plus config texts (user-defined labels / folders)."""
    fixed: list[tuple[str, str, str]] = []
    config: list[tuple[str, str]] = []
    for path, text in walk_strings(catalog):
        if not CJK.search(text):
            continue
        norm = re.sub(r"\.properties\.[^.\[]+", ".properties.*", path)
        if ".last_error." in path or path.endswith(".message"):
            continue  # dynamic error messages: the UI titles them by error code and shows the text as is
        if re.search(r"\.(label|folder)$", path) and ".parts[]" not in path and "schema" not in path:
            config.append((text, norm))
            continue
        if LIVE_SCHEMA_PATH.search(norm):
            fixed.append((text, norm, "schema"))
        elif norm.endswith(".reason"):
            fixed.append((text, norm, "part" if ".parts[]" in norm else "reason"))
        elif re.search(r"\.(inputs|outputs)\[\]\.description$", norm):
            fixed.append((text, norm, "port"))
        else:
            fixed.append((text, norm, "server-text"))
    return fixed, config


GROUP_ORDER = [
    "schema",
    "port",
    "part",
    "label",
    "contract",
    "metric-rule",
    "reason",
    "fact",
    "note",
    "message",
    "rule",
    "error",
    "server-text",
]
CONTEXT_OF = {
    "schema": "description",
    "port": "description",
    "part": "reason",
    "label": "label",
    "contract": "description",
    "metric-rule": "description",
    "reason": "reason",
    "fact": "description",
    "note": "note",
    "message": "message",
    "rule": "description",
    "error": "error-message",
    "server-text": "server-text",
}


def main() -> int:
    here = Path(__file__).resolve()
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("--repo", type=Path, default=here.parents[2])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--catalog", type=Path)
    ap.add_argument("--pipelines", type=Path)
    ap.add_argument("--dynamic-out", type=Path)
    ap.add_argument("--config-out", type=Path)
    args = ap.parse_args()
    repo: Path = args.repo

    entries, dynamic, skipped = scan_python(repo)
    for text, where, group in contract_strings(repo):
        e = entries.setdefault(
            text, {"source": text, "placeholders": [], "where": [], "groups": Counter(), "codes": set()}
        )
        e["where"].append(where)
        e["groups"][group] += 1

    coverage = None
    config: dict[str, dict] = {}
    if args.catalog:
        catalog = json.loads(args.catalog.read_text(encoding="utf8"))
        fixed, cfg = live_catalog_strings(catalog)
        live_texts = {t for t, _, _ in fixed}
        static_hits = {t for t in live_texts if t in entries}
        added = 0
        for text, path, group in fixed:
            if text in entries:
                entries[text].setdefault("live", True)
                continue
            e = entries.setdefault(
                text,
                {
                    "source": text,
                    "placeholders": [],
                    "where": [],
                    "groups": Counter(),
                    "codes": set(),
                    "origin": "live-catalog",
                },
            )
            if not e["where"]:
                added += 1
            if len(e["where"]) < 3:
                e["where"].append(f"live:/api/catalog{path}")
            e["groups"][group] += 1
        coverage = {
            "live_fixed_distinct": len(live_texts),
            "found_in_static_scan": len(static_hits),
            "added_from_live_only": added,
        }
        for text, path in cfg:
            c = config.setdefault(
                text,
                {
                    "source": text,
                    "where": [],
                    "context": "config-folder" if path.endswith(".folder") else "config-label",
                },
            )
            if len(c["where"]) < 3:
                c["where"].append(f"live:/api/catalog{path}")
    if args.pipelines:
        pipes = json.loads(args.pipelines.read_text(encoding="utf8"))
        for path, text in walk_strings(pipes):
            if CJK.search(text) and re.search(r"\.(label|description)$", path):
                c = config.setdefault(text, {"source": text, "where": [], "context": "pipeline-text"})
                if len(c["where"]) < 3:
                    c["where"].append(f"live:/api/pipelines{re.sub(r'.items.*?(\.[a-z_]+)$', r'\1', path)}")
    for cfg_path in sorted((repo / "deploy").rglob("*.json")):
        try:
            doc = json.loads(cfg_path.read_text(encoding="utf8"))
        except (OSError, ValueError):
            continue
        rel = cfg_path.relative_to(repo).as_posix()
        for path, text in walk_strings(doc):
            if CJK.search(text) and re.search(r"\.(label|folder|description|about|note|notes_zh)$", path):
                c = config.setdefault(
                    text, {"source": text, "where": [], "context": "config-" + path.rsplit(".", 1)[-1]}
                )
                if len(c["where"]) < 3:
                    c["where"].append(f"{rel}#{path.lstrip('.')}")

    out = []
    for e in entries.values():
        groups: Counter = e["groups"]
        group = sorted(groups, key=lambda g: (GROUP_ORDER.index(g) if g in GROUP_ORDER else 99, -groups[g]))[0]
        item = {
            "source": e["source"],
            "placeholders": [],
            "where": e["where"][:6],
            "uses": len(e["where"]),
            "context": CONTEXT_OF.get(group, group),
            "group": group,
        }
        if e.get("codes"):
            item["code"] = sorted(e["codes"])[0]
            if len(e["codes"]) > 1:
                item["codes"] = sorted(e["codes"])
        if e.get("origin"):
            item["origin"] = e["origin"]
        if e.get("live"):
            item["live"] = True
        notes = []
        if "{" in e["source"] or "}" in e["source"]:
            notes.append("literal-braces: {…} here is literal text, not a placeholder")
        if notes:
            item["notes"] = notes
        out.append(item)
    out.sort(key=lambda x: (GROUP_ORDER.index(x["group"]) if x["group"] in GROUP_ORDER else 99, x["where"][0]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    if args.dynamic_out:
        dyn = sorted(dynamic.values(), key=lambda d: d["where"][0])
        args.dynamic_out.write_text(json.dumps(dyn, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    if args.config_out:
        args.config_out.write_text(
            json.dumps(sorted(config.values(), key=lambda c: c["context"]), ensure_ascii=False, indent=2) + "\n",
            encoding="utf8",
        )

    by_group = Counter(x["group"] for x in out)
    print(f"server static strings: {len(out)} ({sum(len(x['source']) for x in out)} chars)")
    for g, n in sorted(by_group.items(), key=lambda kv: GROUP_ORDER.index(kv[0]) if kv[0] in GROUP_ORDER else 99):
        print(f"  {g:12s} {n}")
    print(f"dynamic (f-string) patterns, not exact-matchable: {len(dynamic)}")
    print(f"optional config/user texts: {len(config)}")
    if coverage:
        print(f"live catalog: {coverage}")
    print("skipped:", dict(skipped.most_common()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
