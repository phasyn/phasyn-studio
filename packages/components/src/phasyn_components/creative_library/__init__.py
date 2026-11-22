"""Immutable project-scoped creative entries and compiled shot bindings."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Literal

from phasyn_components import contracts
from phasyn_components.canonical import canonical_json, digest
from phasyn_components.errors import ComponentError
from phasyn_components.ids import require_local_id

from .compiler import Doc, compile_binding, find_shot, invalid, pick_image, shot_inputs
from .schema import validate_write


Family = Literal["entry", "video", "image"]
MAX_ROW_BYTES = 256 * 1024
MAX_ENTRIES = 500
MAX_ARCHIVE_VERSIONS = 16_384


def _head(db: sqlite3.Connection, pid: str, kind: Family, uid: str) -> int:
    return int(
        db.execute(
            "SELECT coalesce(max(revision),0) FROM versions WHERE project_id=? AND family=? AND local_id=?",
            (pid, kind, uid),
        ).fetchone()[0]
    )


def _row(db: sqlite3.Connection, pid: str, kind: Family, uid: str, version: int) -> Doc:
    row = db.execute(
        "SELECT document FROM versions WHERE project_id=? AND family=? AND local_id=? AND revision=?",
        (pid, kind, uid, version),
    ).fetchone()
    if row is None:
        raise ComponentError(
            "NOT_FOUND",
            "此專案沒有這個設定版本",
            details={"id": uid, "revision": version},
        )
    return dict(json.loads(row[0]))


def match_revision(expected: int, stored: int, target: str) -> None:
    """Reject an update if the stored revision differs from its precondition."""
    if expected != stored:
        raise ComponentError(
            "REVISION_CONFLICT",
            "版本已更新，請重新讀取",
            details={
                "expected_revision": expected,
                "stored_revision": stored,
                "target": target,
            },
        )


def _shot_uses(db: sqlite3.Connection, project: Doc, entry: Doc) -> list[Doc]:
    """Compare each live shot's current pin to the selected entry revision."""
    pid, eid = project["project_id"], entry["entry_id"]
    shots = {
        (medium, shot[key]): shot
        for medium, collection, key in (
            ("video", "shots", "shot_id"),
            ("image", "image_shots", "image_shot_id"),
        )
        for shot in project.get(collection, [])
    }
    rows = db.execute(
        """SELECT v.family,v.local_id,v.revision,p.value
           FROM versions v JOIN (
             SELECT family,local_id,max(revision) AS revision FROM versions
             WHERE project_id=? AND family IN ('video','image') GROUP BY family,local_id
           ) head USING (family,local_id,revision), json_each(v.document,'$.entries') p
           WHERE v.project_id=? AND json_extract(p.value,'$.entry_id')=?
           ORDER BY v.family,v.local_id""",
        (pid, pid, eid),
    )
    versions = {entry["revision"]: entry}
    uses = []
    for medium, sid, binding_revision, value in rows:
        shot = shots.get((medium, sid))
        if shot is None:
            continue
        pin = json.loads(value)
        revision = pin["revision"]
        if revision not in versions:
            versions[revision] = _row(db, pid, "entry", eid, revision)
        before = versions[revision]
        overrides = sorted(pin.get("overrides", {}))
        fields = set(before["fields"]) | set(entry["fields"])
        changed = sorted(
            k for k in fields if before["fields"].get(k) != entry["fields"].get(k)
        )
        uses.append(
            {
                "medium": medium,
                "shot_id": sid,
                "title": shot["title"],
                "binding_revision": binding_revision,
                "entry_revision": revision,
                "active_take_id": shot.get("active_take_id"),
                "affected_fields": [k for k in changed if k not in overrides],
                "overridden_fields": overrides,
                "name_changed": before["name"] != entry["name"],
                "references_changed": before["references"] != entry["references"],
            }
        )
    return uses


def _version_key(doc: Doc) -> tuple[str, str, int]:
    if "entry_id" in doc:
        return "entry", doc["entry_id"], doc["revision"]
    return doc["medium"], doc["shot_id"], doc["revision"]


def _verify_version(pid: str, version: Any) -> None:
    if not isinstance(version, dict):
        raise invalid("創作修訂格式無效")
    name = (
        "StudioCreativeEntryVersion"
        if "entry_id" in version
        else "StudioCreativeBindingVersion"
    )
    contracts.validate(name, version)
    content = {k: v for k, v in version.items() if k != "digest"}
    if (
        version["project_id"] != pid
        or digest(content) != version["digest"]
        or len(canonical_json(version)) > MAX_ROW_BYTES
    ):
        raise invalid("創作修訂的來源、長度或摘要不符")


def validate_archive_versions(pid: str, rows: Any) -> None:
    """Verify the source seals, revision chains and pinned references before importing."""
    if not isinstance(rows, list) or len(rows) > MAX_ARCHIVE_VERSIONS:
        raise invalid("創作修訂清單超出範圍")
    revisions: dict[tuple[str, str], set[int]] = {}
    for version in rows:
        _verify_version(pid, version)
        family, uid, revision = _version_key(version)
        versions = revisions.setdefault((family, uid), set())
        if revision in versions:
            raise invalid("創作修訂重複")
        versions.add(revision)
    if any(max(chain) != len(chain) for chain in revisions.values()):
        raise invalid("創作修訂歷史不完整")
    if sum(key[0] == "entry" for key in revisions) > MAX_ENTRIES:
        raise invalid("創作設定超過上限")
    for row in rows:
        for pin in row.get("entries", []):
            if pin["revision"] not in revisions.get(("entry", pin["entry_id"]), set()):
                raise invalid("創作綁定找不到原設定版本")


class CreativeLibrary:
    """The Studio project lock serializes project edits/deletion and creative snapshots."""

    def __init__(
        self, root: Path, project: Callable[[str], Doc], project_lock: threading.Lock
    ) -> None:
        """Open the version store and establish its database schema."""
        self.path = root / "creative.sqlite"
        root.mkdir(exist_ok=True, parents=True)
        self._project = project
        self._lock = project_lock
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                db.execute("""CREATE TABLE versions (
                    project_id TEXT NOT NULL, family TEXT NOT NULL, local_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    document TEXT NOT NULL, PRIMARY KEY(project_id,family,local_id,revision))""")
                db.execute("""CREATE TABLE retained (
                    project_id TEXT NOT NULL, node_id TEXT NOT NULL, file_id TEXT NOT NULL,
                    PRIMARY KEY(project_id,node_id,file_id))""")
                db.execute("PRAGMA user_version=1")
            elif version != 1:
                raise ComponentError(
                    "RUNTIME_ERROR", "無法讀取這個版本的創作設定資料庫"
                )

            db.execute(
                "CREATE TABLE IF NOT EXISTS portable_history (project_id TEXT PRIMARY KEY, document TEXT NOT NULL)"
            )

            db.execute(
                "CREATE TABLE IF NOT EXISTS portable_run_refs (run_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(run_id,project_id))"
            )

    def archived_run_projects(self, run_id: str) -> set[str]:
        """Identify projects with a frozen private copy independent from the live RunStore."""
        with self.connection() as db:
            return {
                row[0]
                for row in db.execute(
                    "SELECT project_id FROM portable_run_refs WHERE run_id=?", (run_id,)
                )
            }

    def archive_versions_locked(self, pid: str) -> list[Doc]:
        """Read all immutable revisions under the caller's project lock."""
        with self.connection() as db:
            return [
                json.loads(v[0])
                for v in db.execute(
                    "SELECT document FROM versions WHERE project_id=? ORDER BY family,local_id,revision",
                    (pid,),
                )
            ]

    def archive_history_locked(self, pid: str) -> Doc:
        """Read imported historical runs and draft plans kept outside the execution queue."""
        with self.connection() as db:
            row = db.execute(
                "SELECT document FROM portable_history WHERE project_id=?", (pid,)
            ).fetchone()
        return dict(json.loads(row[0])) if row else {"runs": [], "drafts": []}

    def restore_archive_locked(
        self,
        pid: str,
        versions: list[Doc],
        history: Doc,
        retained: set[tuple[str, str]],
    ) -> None:
        """Restore remapped, verified versions and inert execution snapshots as one transaction."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO portable_history VALUES(?,?)",
                (pid, canonical_json(history)),
            )
            db.executemany(
                "INSERT INTO portable_run_refs VALUES(?,?)",
                ((r["run_id"], pid) for r in history["runs"]),
            )
            db.executemany(
                "INSERT INTO retained VALUES(?,?,?)",
                ((pid, nid, fid) for nid, fid in retained),
            )
            for old in versions:
                version = {**old, "project_id": pid}
                del version["digest"]
                version["digest"] = digest(version)
                encoded = canonical_json(version)
                if len(encoded) > MAX_ROW_BYTES:
                    raise invalid("移至目的地後的創作修訂超出容量上限")
                family, uid, revision = _version_key(version)
                db.execute(
                    "INSERT INTO versions VALUES(?,?,?,?,?)",
                    (pid, family, uid, revision, encoded.decode()),
                )

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """Open a database transaction for the current operation."""
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.execute("PRAGMA foreign_keys=ON")
            yield db

    def list_entries(self, pid: str) -> Doc:
        """List the latest revision of each entry in a project."""
        with self._lock, self.connection() as db:
            self._project(pid)
            rows = db.execute(
                """SELECT local_id,max(revision),json_extract(document,'$.kind'),json_extract(document,'$.name')
                FROM versions WHERE project_id=? AND family='entry' GROUP BY local_id ORDER BY local_id""",
                (pid,),
            )
            return {
                "items": [
                    {"entry_id": k, "revision": r, "kind": t, "name": n}
                    for k, r, t, n in rows
                ]
            }

    def read(self, pid: str, kind: Family, uid: str, revision: int | None) -> Doc:
        """Read one pinned revision together with its current review flags."""
        with self._lock, self.connection() as db:
            project = self._project(pid)
            head = _head(db, pid, kind, uid)
            version = _row(db, pid, kind, uid, head if revision is None else revision)
            outdated: list[Doc] = []
            if kind != "entry":
                try:
                    shot = find_shot(project, kind, uid)
                except ComponentError as exc:
                    if exc.code != "NOT_FOUND":
                        raise
                    outdated.append({"source": "shot_missing"})
                else:
                    if (
                        digest(
                            shot_inputs(
                                shot, include_prompt=version.get("include_prompt", True)
                            )
                        )
                        != version["source_digest"]
                    ):
                        outdated.append({"source": "shot"})
                for pin in version["entries"]:
                    latest = _head(db, pid, "entry", pin["entry_id"])
                    if latest != pin["revision"]:
                        outdated.append(
                            {
                                "source": "entry",
                                **{k: pin[k] for k in ("entry_id", "revision")},
                                "latest_revision": latest,
                            }
                        )
            outdated.extend(_changed_references(project, version, kind))
            result = {"version": version, "latest_revision": head, "review": outdated}
            if kind == "entry":
                result["shot_uses"] = _shot_uses(db, project, version)
            return result

    def write(self, pid: str, kind: Family, uid: str, body: Any) -> Doc:
        """Append a project-scoped version after checking its revision."""
        require_local_id(uid, "id")
        validate_write(kind, body)
        with self._lock, self.connection() as db:
            project = self._project(pid)
            match_revision(body["project_revision"], project["revision"], "project")
            db.execute("BEGIN IMMEDIATE")
            old = _head(db, pid, kind, uid)
            match_revision(body["expected_revision"], old, uid)
            if kind == "entry":
                if old:
                    if _row(db, pid, kind, uid, old)["kind"] != body["kind"]:
                        raise invalid("既有設定的類型無法變更")
                elif (
                    db.execute(
                        "SELECT count(*) FROM versions WHERE project_id=? AND family='entry' AND revision=1",
                        (pid,),
                    ).fetchone()[0]
                    >= MAX_ENTRIES
                ):
                    raise invalid("單一專案的創作設定已達上限", limit=MAX_ENTRIES)
                content = {
                    "entry_id": uid,
                    "kind": body["kind"],
                    "name": body["name"],
                    "fields": body["fields"],
                    "references": [
                        pick_image(project, item) for item in body["reference_items"]
                    ],
                }
            else:
                pins = body["entries"]
                if len(pins) != len({pin["entry_id"] for pin in pins}):
                    raise invalid("同一設定只能綁定一個版本")
                versions = [
                    _row(db, pid, "entry", p["entry_id"], p["revision"]) for p in pins
                ]
                content = compile_binding(project, kind, uid, body, versions)
            result = {
                **content,
                "project_id": pid,
                "project_revision": project["revision"],
                "revision": old + 1,
            }
            result["digest"] = digest(result)
            encoded = json.dumps(
                result, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            )
            if len(encoded.encode("utf-8")) > MAX_ROW_BYTES:
                raise invalid("設定版本超過儲存上限", limit_bytes=MAX_ROW_BYTES)
            db.execute(
                "INSERT INTO versions VALUES(?,?,?,?,?)",
                (pid, kind, uid, old + 1, encoded),
            )
            retained = [ref["file"] for ref in result["references"]]
            retained.extend(
                v["file"] for v in result.get("inputs", {}).values() if "file" in v
            )
            if result.get("mask"):
                retained.append(result["mask"]["file"])
            db.executemany(
                "INSERT OR IGNORE INTO retained VALUES(?,?,?)",
                [
                    (pid, file["node_id"].lower(), file["file_id"].lower())
                    for file in retained
                ],
            )
        return result

    def retained_files(self) -> set[tuple[str, str]]:
        """List file identities retained by immutable creative revisions."""
        with self.connection() as db:
            return set(db.execute("SELECT DISTINCT node_id,file_id FROM retained"))

    def delete_locked(self, pid: str) -> None:
        """Called under the StudioStore lock after deletion and before reusing a previously deleted project ID."""
        with self.connection() as db:
            db.execute("DELETE FROM versions WHERE project_id=?", (pid,))
            db.execute("DELETE FROM retained WHERE project_id=?", (pid,))
            db.execute("DELETE FROM portable_history WHERE project_id=?", (pid,))
            db.execute("DELETE FROM portable_run_refs WHERE project_id=?", (pid,))


def _changed_references(project: Doc, version: Doc, kind: Family) -> list[Doc]:
    library = {item["item_id"]: item["file"] for item in project.get("library", [])}
    outdated = [
        {"source": "reference", "item_id": ref["item_id"]}
        for ref in version["references"]
        if library.get(ref["item_id"]) != ref["file"]
    ]
    for role, item_id in version.get("media_bindings", {}).items():
        if library.get(item_id) != version["inputs"][role]["file"]:
            outdated.append({"source": "reference", "item_id": item_id})
    if (
        kind != "entry"
        and version.get("mask")
        and library.get(version["mask"]["item_id"]) != version["mask"]["file"]
    ):
        outdated.append({"source": "mask", "item_id": version["mask"]["item_id"]})
    return outdated
