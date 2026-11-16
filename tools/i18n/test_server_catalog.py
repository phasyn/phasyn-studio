"""Every fixed server text shown in the UI (schema and port descriptions, part reasons, notes, error literals…)
needs ja and en entries in apps/frontend/src/i18n/catalogs/{ja,en}/*.json (server texts live in server.json).

The scan rules are those of tools/i18n/server_scan.py (standard library only, no project imports). When a change
adds or edits a fixed Chinese server string, the same change adds both translations; otherwise this test lists the
missing source texts with their locations.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

pytestmark = pytest.mark.static

ROOT = Path(__file__).resolve().parents[2]
SCANNER = ROOT / "tools/i18n/server_scan.py"
CATALOGS = ROOT / "apps/frontend/src/i18n/catalogs"


def _scanner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("i18n_server_scan", SCANNER)
    assert spec and spec.loader, SCANNER
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_server_static_strings_have_ja_and_en_entries() -> None:
    scanner = _scanner()
    entries, _dynamic, _skipped = scanner.scan_python(ROOT)
    sources = {text: entry["where"][0] for text, entry in entries.items()}
    for text, where, _group in scanner.contract_strings(ROOT):
        sources.setdefault(text, where)
    problems = []
    for locale in ("ja", "en"):
        keys: set[str] = set()
        for path in sorted((CATALOGS / locale).glob("*.json")):
            keys |= set(json.loads(path.read_text(encoding="utf-8")))
        problems += [
            f"{locale} missing translation: {where}  {text!r}"
            for text, where in sorted(sources.items(), key=lambda kv: kv[1])
            if text not in keys
        ]
    assert not problems, "\n".join(problems[:200])
