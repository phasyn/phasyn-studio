"""The reference graph of the storage cleanup: which runs and files anything still mentions.

A mention is any UUID that appears in a document that is kept. Matching the identifiers in the text, instead of
walking known fields, is deliberately conservative: whatever names a run or a file (a take, a library item, a
timeline source, a draft plan, a prompt study, a preset, a pending Studio write, a creative revision, the request or
output of a run that stays) keeps it, including fields a later version adds. The roots are:

- every regular file under ``config/`` (Studio projects with their legacy copies and reviews, prompt studies,
  pipelines, presets, plugins...) except the cleanup's own ``config/storage/`` and the Studio write audit, which
  only records history;
- the live rows of the SQLite stores (draft plans, inference presets, the Studio write ledger, the creative
  library) and the pending Studio render attachments; never the idempotency table of run submissions, which names
  every run ever created;
- every run directory (``runs/<run_id>/run.json``); a run's own text counts only while the run stays.

Each mention keeps the source it came from (``p:<project>``, ``r:<run>``, ``o:<other>``), so the planner can tell
which mentions disappear with the runs it collects and which files only one project uses.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sqlite3
import zlib
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.canonical import read_json
from phasyn_components.ids import is_local_id, is_uuid

from ..runs import TERMINAL_RUN_STATES
from ..studio_work import origin_project


log = logging.getLogger("phasyn_controller.storage")

UUID_RE = re.compile(
    rb"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
# config/ entries that are history, not references (and the cleanup's own pins, handled explicitly)
SKIPPED_CONFIG = (("storage",), ("studio", "_audit"))
# SQLite stores under data_dir whose live rows are roots, with the tables to skip
DATA_DATABASES: dict[str, frozenset[str]] = {
    "draft-plans.sqlite": frozenset(),
    "inference-presets.sqlite": frozenset(),
    "run-submissions.sqlite": frozenset({"submissions"}),
}
SQLITE_SUFFIXES = (".sqlite", ".sqlite3", ".db")
SQLITE_SIDECARS = ("-wal", "-shm", "-journal")


def uuids(data: bytes) -> set[str]:
    """Every UUID in a byte string, lowercased."""
    return {match.decode("ascii").lower() for match in UUID_RE.findall(data)}


@dataclass
class RunDoc:
    """What the planner needs from one run.json (the document itself is parsed again only when needed)."""

    run_id: str
    state: str | None
    created_at: str
    project_id: str | None
    label: str
    path: Path


@dataclass
class Graph:
    """Mentions by source, the run documents and the Studio projects."""

    mentions: dict[str, set[str]] = field(default_factory=dict)
    runs: dict[str, RunDoc] = field(default_factory=dict)
    # project id -> title, for every project document that could be read
    projects: dict[str, str] = field(default_factory=dict)

    def add(self, source: str, ids: set[str]) -> None:
        """Record that ``source`` mentions every id in ``ids``."""
        for value in ids:
            self.mentions.setdefault(value, set()).add(source)

    def sources(self, value: str) -> set[str]:
        """Sources that mention ``value`` (a run or file id)."""
        return self.mentions.get(value.lower(), set())


def _relative_parts(path: Path, root: Path) -> tuple[str, ...]:
    return path.relative_to(root).parts


def _config_source(parts: tuple[str, ...]) -> str:
    """``p:<project>`` for a Studio project document (and its legacy copy and reviews), else ``o:<path>``."""
    *folders, name = parts
    stem = name.removesuffix(".json")
    if stem != name and is_local_id(stem) and folders[:1] == ["studio"]:
        sub = folders[1:]
        if not sub or sub in (["_legacy"], ["_reviews"]):
            return f"p:{stem}"
    return "o:" + "/".join(parts)


def _sqlite_values(path: Path, skip: frozenset[str]) -> Iterator[bytes]:
    """The live values of every table (blobs that are zlib streams are inflated); unreadable stores yield nothing."""
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return
    try:
        tables = [
            str(row[0])
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        for table in tables:
            if table in skip:
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            for row in db.execute(f"SELECT * FROM {quoted}"):  # noqa: S608 — names come from sqlite_master
                for value in row:
                    if isinstance(value, str):
                        yield value.encode("utf-8", "replace")
                    elif isinstance(value, bytes):
                        yield value
                        with contextlib.suppress(zlib.error):
                            yield zlib.decompress(value)
    except sqlite3.Error as exc:
        log.warning(
            "儲存清理：無法讀取 %s（%s）；這個資料庫的引用改以整個檔案的內容計算",
            path,
            exc,
        )
        with contextlib.suppress(OSError):
            yield path.read_bytes()
    finally:
        db.close()


def _scan_config(graph: Graph, root: Path) -> None:
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        parts = _relative_parts(path, root)
        if any(parts[: len(skip)] == skip for skip in SKIPPED_CONFIG):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        if path.name.endswith(SQLITE_SIDECARS):
            continue  # read through SQLite together with its database
        source = _config_source(parts)
        if path.name.endswith(SQLITE_SUFFIXES):
            ids: set[str] = set()
            for value in _sqlite_values(path, frozenset()):
                ids |= uuids(value)
            graph.add(source, ids)
            continue
        try:
            data = path.read_bytes()
        except OSError as exc:
            log.warning("儲存清理：無法讀取 %s（%s）", path, exc)
            continue
        graph.add(source, uuids(data))
        if source.startswith("p:"):
            _note_project(graph, source[2:], data)


def _note_project(graph: Graph, project_id: str, data: bytes) -> None:
    if project_id in graph.projects:
        return
    try:
        doc = json.loads(data)
    except ValueError:
        return
    if isinstance(doc, dict) and doc.get("project_id") == project_id:
        graph.projects[project_id] = str(doc.get("title") or project_id)


def _scan_databases(graph: Graph, data_dir: Path) -> None:
    for name, skip in DATA_DATABASES.items():
        path = data_dir / name
        if not path.is_file():
            continue
        ids: set[str] = set()
        for value in _sqlite_values(path, skip):
            ids |= uuids(value)
        graph.add(f"o:{name}", ids)


def _run_label(run: Mapping[str, Any]) -> str:
    request = run.get("request")
    if isinstance(request, Mapping):
        label = request.get("label")
        if isinstance(label, str) and label.strip():
            return label.strip()[:200]
        pipeline = request.get("pipeline")
        if isinstance(pipeline, Mapping) and isinstance(
            pipeline.get("pipeline_id"), str
        ):
            return str(pipeline["pipeline_id"])[:200]
    return str(run.get("run_id") or "")


def _scan_runs(graph: Graph, runs_root: Path) -> None:
    if not runs_root.is_dir():
        return
    for entry in sorted(runs_root.iterdir()):
        if not is_uuid(entry.name) or not entry.is_dir():
            continue
        path = entry / "run.json"
        rid = entry.name.lower()
        try:
            data = path.read_bytes()
            run = json.loads(data)
        except (OSError, ValueError) as exc:
            # An unreadable run is never collected; its directory still mentions whatever it names
            log.warning("儲存清理：run %s 無法讀取（%s），不列入回收", rid, exc)
            graph.add(f"o:runs/{rid}", {rid})
            continue
        if not isinstance(run, dict) or str(run.get("run_id") or "").lower() != rid:
            graph.add(f"o:runs/{rid}", {rid})
            continue
        graph.add(f"r:{rid}", uuids(data) - {rid})
        graph.runs[rid] = RunDoc(
            run_id=rid,
            state=run.get("state") if isinstance(run.get("state"), str) else None,
            created_at=str(run.get("created_at") or ""),
            project_id=origin_project(run.get("request")),
            label=_run_label(run),
            path=path,
        )


def build(data_dir: Path) -> Graph:
    """Scan every root of the data directory (blocking; run in a thread)."""
    graph = Graph()
    _scan_config(graph, data_dir / "config")
    _scan_databases(graph, data_dir)
    _scan_runs(graph, data_dir / "runs")
    return graph


def read_run(doc: RunDoc) -> dict[str, Any] | None:
    """The run document again (for its produced files); None when it is gone or unreadable."""
    try:
        run = read_json(doc.path)
    except (OSError, ValueError):
        return None
    return run if isinstance(run, dict) else None


def finished(doc: RunDoc) -> bool:
    """Whether the run reached a terminal state."""
    return doc.state in TERMINAL_RUN_STATES


__all__ = ["Graph", "RunDoc", "build", "finished", "read_run", "uuids"]
