"""The Controller's plugin packages (``data_dir/plugins``) and the registry clients read.

::

    registry.json                           what was installed through the API (replaced atomically): version,
                                            digest, directory, size, disabled, revision, consent and timestamps
    packages/<plugin_id>/<version>-<digest>/  the verified, unpacked content of an installed package
    staging/<uuid>/upload                   an upload while it is received and checked
    staging/<uuid>/content/                 its unpacked content; moved into packages/ only after every check
    trash/                                  package directories the registry did not name at the last start

A package is data. The Controller validates it, stores it and serves it; it never imports or runs anything from
it. Installing is: unpack into staging (``phasyn_components.plugin_package``), move the directory into
``packages/``, load that copy the way a start loads it, and replace ``registry.json``. The registry file is the
commit point: a directory it does not name is a leftover; a start moves it to ``trash/`` and the start after that
deletes it (a registry restored from an older copy names fewer packages than are installed, and their content is
then still there to be put back). Whatever fails before the commit leaves the installation as it was. A registry that is missing next to package directories, unreadable or malformed proves nothing: then nothing
is removed, nothing counts as installed and writes are refused until a person repairs it. Removing a package drops
its registry entry first and never edits a project document.

Three sources: ``builtin`` packages ship with the contracts and are read-only; ``installed`` ones live here; ``dev``
ones are the directories of ``plugins.dev_dirs`` in the config file, read again on reload. One id belongs to one
package: the ``phasyn.`` prefix is refused outside the built-in directory, and a development directory whose id is
already installed stays unloaded until that package is removed.

One writer at a time (:meth:`PluginStore.exclusive`, never waited for); readers use an immutable snapshot.
"""

from __future__ import annotations

import contextlib
import dataclasses
import errno
import logging
import shutil
import tempfile
import threading
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from phasyn_components import contracts
from phasyn_components.canonical import read_json
from phasyn_components.errors import ComponentError, exception_message
from phasyn_components.fs import atomic_write_json, fsync_dir
from phasyn_components.ids import new_id
from phasyn_components.plugin_manifest import (
    BUILTIN_PREFIX,
    LIMITS,
    MAIN_NAME,
    MESSAGES,
    Issue,
    invalid,
    is_plugin_id,
    is_plugin_ref,
    issue,
    issues_of,
)
from phasyn_components.plugin_package import (
    Package,
    PackageFile,
    archive_name,
    load_directory,
    read_file,
    unpack_archive,
    write_archive,
)
from phasyn_components.plugin_registry import (
    PluginRecord,
    builtin_rule_ids,
    load_builtin_records,
    plugin_detail,
    plugin_entry,
    registry_document,
)
from phasyn_components.timeutil import utc_now
from phasyn_server.http import MAX_SAFE_INT

from ..config import PluginsConfig
from ..revisions import require_revision


log = logging.getLogger("phasyn_controller.plugins")

STORE_DIR = "plugins"
REGISTRY_FILE = "registry.json"
REGISTRY_VERSION = 1
REGISTRY_MAX_BYTES = 1024 * 1024  # 64 entries are a few tens of kilobytes
PACKAGES_DIR = "packages"
STAGING_DIR = "staging"
TRASH_DIR = "trash"
UPLOAD_NAME = "upload"
CONTENT_NAME = "content"
EXPORT_SPOOL_BYTES = 1024 * 1024
PROJECT_REFS_MAX = 8
PROJECT_TITLE_MAX = 200

_SHA256 = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
_TIME = {"type": "string", "format": "date-time", "maxLength": 64}
_PERMISSION = {
    "type": "string",
    "maxLength": 64,
    "pattern": "^[a-z][a-z0-9-]*(:[a-z0-9*-]+)?$",
}
# registry.json is this module's own file, but a person can edit it: it is read as strictly as a request.
_REGISTRY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "version": {"const": REGISTRY_VERSION},
        "plugins": {
            "type": "object",
            "maxProperties": LIMITS.packages,
            "additionalProperties": {
                "type": "object",
                "properties": {
                    "version": {"type": "string", "minLength": 1, "maxLength": 64},
                    "digest": _SHA256,
                    "directory": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$",
                    },
                    "size_bytes": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_SAFE_INT,
                    },
                    "disabled": {"type": "boolean"},
                    "revision": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SAFE_INT,
                    },
                    "installed_at": _TIME,
                    "updated_at": _TIME,
                    "consent": {
                        "type": "object",
                        "properties": {
                            "digest": _SHA256,
                            "permissions": {
                                "type": "array",
                                "items": _PERMISSION,
                                "maxItems": 16,
                            },
                            "at": _TIME,
                        },
                        "required": ["digest", "permissions", "at"],
                        "additionalProperties": False,
                    },
                },
                "required": [
                    "version",
                    "digest",
                    "directory",
                    "size_bytes",
                    "disabled",
                    "revision",
                    "installed_at",
                    "updated_at",
                    "consent",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["version", "plugins"],
    "additionalProperties": False,
}

Entry = dict[str, Any]


@dataclass(frozen=True)
class _Loaded:
    """An installed package's content, or why it could not be loaded."""

    package: Package | None
    issues: tuple[Issue, ...] = ()


@dataclass(frozen=True)
class _DevDir:
    """One directory of ``plugins.dev_dirs``. ``plugin_id`` is the id of its last successful load, so a package that a later edit broke stays listed (as invalid) and can be reloaded by that id."""

    path: Path
    plugin_id: str | None = None
    package: Package | None = None
    issues: tuple[Issue, ...] = ()


@dataclass(frozen=True)
class _Snapshot:
    records: Mapping[str, PluginRecord]
    document: Mapping[str, Any]  # contract StudioPluginList


def _conflict(message: str, **details: Any) -> ComponentError:
    return ComponentError("STATE_CONFLICT", message, details=details)


def disk_error(exc: OSError, what: str) -> ComponentError:
    """A failed read or write of the store: ``DISK_FULL`` or ``RUNTIME_ERROR``, naming the file but never its path."""
    code = "DISK_FULL" if exc.errno == errno.ENOSPC else "RUNTIME_ERROR"
    return ComponentError(
        code, f"{what}：{exception_message(exc)}", details={"errno": exc.errno}
    )


def _mkdir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)


class PluginStore:
    """Inspect installed plugin packages and manage their local staging files."""

    def __init__(
        self,
        root: Path,
        config: PluginsConfig,
        *,
        host_version: str,
        contracts_dir: Path,
        projects: Callable[[], list[dict[str, Any]]],
    ) -> None:
        """Bind the plugin directory, host compatibility and contracts."""
        self.root = Path(root)
        self.config = config
        self.limits = dataclasses.replace(
            LIMITS, package_bytes=config.max_package_bytes
        )
        self._host_version = host_version
        self._contracts_dir = contracts_dir
        self._projects = projects
        self._packages = self.root / PACKAGES_DIR
        self._staging = self.root / STAGING_DIR
        self._trash = self.root / TRASH_DIR
        self._registry = self.root / REGISTRY_FILE
        self._writer = threading.Lock()
        self._builtin: tuple[PluginRecord, ...] = ()
        self._entries: dict[str, Entry] = {}
        self._registry_fault: str | None = (
            None  # missing | unreadable | invalid: nothing is installed or removed
        )
        self._installed: dict[str, _Loaded] = {}
        self._dev: tuple[_DevDir, ...] = ()
        self._snapshot = _Snapshot({}, {})

    # ------------------------------------------------------------------ start-up
    def open(self) -> None:
        """Load every package. Leftovers of an interrupted request go: all of ``staging/`` is removed, and the package directories ``registry.json`` does not name are set aside in ``trash/`` until the next start (only when that file is there and could be read)."""
        _mkdir(self._packages)
        shutil.rmtree(self._staging, ignore_errors=True)
        _mkdir(self._staging)
        shutil.rmtree(
            self._trash, ignore_errors=True
        )  # what the previous start set aside
        self._builtin = tuple(load_builtin_records(self._contracts_dir))
        self._entries, self._registry_fault = self._read_registry()
        if self._registry_fault is None:
            self._sweep()
        self._installed = {
            plugin_id: self._load_installed(plugin_id, entry)
            for plugin_id, entry in self._entries.items()
        }
        self._dev = tuple(
            self._load_dev(_DevDir(path)) for path in self.config.dev_dirs
        )
        self._publish()

    def _registry_document(self) -> dict[str, Any]:
        if self._registry.stat().st_size > REGISTRY_MAX_BYTES:
            raise ValueError(f"larger than {REGISTRY_MAX_BYTES} bytes")
        doc = read_json(self._registry)
        contracts.validate_with_schema(
            _REGISTRY_SCHEMA, doc, code="RUNTIME_ERROR", what=REGISTRY_FILE
        )
        return dict(doc)

    def _read_registry(self) -> tuple[dict[str, Entry], str | None]:
        """What ``registry.json`` says is installed, and why it cannot be relied on (``None``: it can).

        A store without the file is new and gets an empty one. From then on the file is always there, so when it is
        missing next to package directories the record was lost: nothing proves those directories leftovers.
        """
        try:
            doc = self._registry_document()
        except FileNotFoundError:
            if self._has_packages():
                log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                    "插件安裝紀錄 %s 不見了，但 %s/ 內還有插件目錄",
                    REGISTRY_FILE,
                    PACKAGES_DIR,
                )
                return {}, "missing"
            try:
                self._write_registry({})
            except ComponentError as exc:
                log.warning("無法建立插件安裝紀錄 %s：%s", REGISTRY_FILE, exc.message)
            return {}, None
        except (OSError, ValueError, RecursionError) as exc:
            log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                "插件安裝紀錄 %s 無法讀取：%s",
                REGISTRY_FILE,
                exception_message(exc),
            )
            return {}, "unreadable"
        except ComponentError as exc:
            log.error(  # noqa: TRY400 — keep external failures out of tracebacks.
                "插件安裝紀錄 %s 格式不對：%s",
                REGISTRY_FILE,
                exc.message,
            )
            return {}, "invalid"
        entries: dict[str, Entry] = doc["plugins"]
        if not all(
            is_plugin_id(name) and not name.startswith(BUILTIN_PREFIX)
            for name in entries
        ):
            log.error("插件安裝紀錄 %s 含有不合法的插件 id", REGISTRY_FILE)
            return {}, "invalid"
        return entries, None

    def _has_packages(self) -> bool:
        try:
            return any(self._packages.iterdir())
        except OSError:
            return True  # it cannot be told, and "none" is the answer that lets directories be removed

    def _leftovers(self) -> Iterator[Path]:
        """What ``packages/`` holds besides the directories ``registry.json`` names."""
        for home in sorted(self._packages.iterdir()):
            entry = self._entries.get(home.name)
            if entry is None or home.is_symlink() or not home.is_dir():
                yield home
            else:
                yield from (
                    child
                    for child in sorted(home.iterdir())
                    if child.name != entry["directory"]
                )

    def _sweep(self) -> None:
        """Set aside what ``packages/`` holds without the registry naming it: the leftovers of an interrupted install, update or removal, and the packages a registry restored from an older copy does not know."""
        try:
            leftovers = list(self._leftovers())
        except OSError as exc:
            log.warning("無法清理插件目錄：%s", exception_message(exc))
            return
        for number, path in enumerate(leftovers):
            name = "-".join(path.relative_to(self._packages).parts)
            log.warning(
                "安裝紀錄沒有記載的插件目錄 %s 已移到 %s/，下次啟動時刪除",
                name,
                TRASH_DIR,
            )
            try:
                _mkdir(self._trash)
                path.rename(self._trash / f"{number:03d}-{name}")
            except OSError as exc:
                log.warning(
                    "無法把 %s 移到 %s/：%s", name, TRASH_DIR, exception_message(exc)
                )
                self._remove_tree(path)

    def _remove_tree(self, path: Path) -> None:
        """Best effort: what stays behind is unreferenced and is removed at the next start."""
        try:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError as exc:
            log.warning("無法移除 %s：%s", path.name, exception_message(exc))

    def _load_installed(self, plugin_id: str, entry: Entry) -> _Loaded:
        try:
            package = load_directory(
                self._packages / plugin_id / entry["directory"],
                builtin=False,
                linked=True,
            )
        except ComponentError as exc:
            return _Loaded(None, tuple(issues_of(exc)))
        if package.plugin_id != plugin_id or package.digest != entry["digest"]:
            return _Loaded(None, (issue("digest_mismatch"),))
        return _Loaded(package)

    def _load_dev(self, directory: _DevDir) -> _DevDir:
        try:
            package = load_directory(directory.path, builtin=False)
        except ComponentError as exc:
            return _DevDir(
                directory.path, directory.plugin_id, None, tuple(issues_of(exc))
            )
        return _DevDir(directory.path, package.plugin_id, package)

    # ------------------------------------------------------------------ the snapshot
    def _installed_record(
        self, plugin_id: str, entry: Entry, loaded: _Loaded
    ) -> PluginRecord:
        return PluginRecord(
            plugin_id,
            "installed",
            loaded.package,
            loaded.issues,
            disabled=bool(entry["disabled"]),
            revision=int(entry["revision"]),
            version=str(entry["version"]),
            digest=str(entry["digest"]),
            installed_at=str(entry["installed_at"]),
            updated_at=str(entry["updated_at"]),
            consent=entry["consent"],
        )

    def _dev_records(self, taken: set[str]) -> tuple[list[PluginRecord], list[Issue]]:
        """The development packages that can be listed, and what is wrong with the other directories."""
        records = []
        problems = []
        for directory in self._dev:
            name = directory.path.name
            if directory.plugin_id is None:
                problems.append(
                    issue("dev_dir_invalid", path=name, errors=list(directory.issues))
                )
            elif directory.plugin_id in taken:
                problems.append(
                    issue("dev_dir_conflict", path=name, plugin_id=directory.plugin_id)
                )
            else:
                taken.add(directory.plugin_id)
                records.append(self._dev_record(directory.plugin_id, directory))
        return records, problems

    @staticmethod
    def _dev_record(plugin_id: str, directory: _DevDir) -> PluginRecord:
        package = directory.package
        return PluginRecord(
            plugin_id,
            "dev",
            package,
            directory.issues,
            version=package.version if package else None,
            digest=package.digest if package else None,
        )

    def _publish(self) -> None:
        records = {record.plugin_id: record for record in self._builtin}
        for plugin_id, entry in self._entries.items():
            records[plugin_id] = self._installed_record(
                plugin_id, entry, self._installed[plugin_id]
            )
        dev, problems = self._dev_records(set(records))
        records.update({record.plugin_id: record for record in dev})
        if self._registry_fault is not None:
            problems.insert(0, self._registry_issue())
        document = registry_document(
            list(records.values()),
            host_version=self._host_version,
            install=self.config.install,
            limits=self.limits,
            problems=problems,
        )
        self._snapshot = _Snapshot(records, document)

    # ------------------------------------------------------------------ reads
    def document(self) -> Mapping[str, Any]:
        """Contract ``StudioPluginList``."""
        return self._snapshot.document

    def _require(self, plugin_id: str) -> PluginRecord:
        if not is_plugin_id(plugin_id):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "plugin_id 的格式不對",
                details={"field": "plugin_id"},
            )
        record = self._snapshot.records.get(plugin_id)
        if record is None:
            raise ComponentError(
                "NOT_FOUND", f"找不到插件 {plugin_id}", details={"plugin_id": plugin_id}
            )
        return record

    def _detail(self, record: PluginRecord) -> dict[str, Any]:
        builtin_rules = builtin_rule_ids(self._snapshot.records.values())
        entry = plugin_entry(
            record, host_version=self._host_version, builtin_rules=builtin_rules
        )
        return plugin_detail(record, entry)

    def detail(self, plugin_id: str) -> dict[str, Any]:
        """Contract ``StudioPluginDetail``."""
        return self._detail(self._require(plugin_id))

    def file(self, plugin_id: str, path: str) -> tuple[PackageFile, bytes]:
        """One file of a package. ``path`` is only compared with the package's own file list, never resolved."""
        record = self._require(plugin_id)
        item = record.package.file(path) if record.package is not None else None
        if record.package is None or item is None:
            raise ComponentError(
                "NOT_FOUND", "插件包內沒有這個檔案", details={"plugin_id": plugin_id}
            )
        if item.path == MAIN_NAME:
            raise ComponentError(
                "NOT_FOUND",
                "這個版本不提供插件程式碼",
                details={"plugin_id": plugin_id},
            )
        return item, read_file(record.package, item)

    def export(self, plugin_id: str) -> tuple[str, IO[bytes]]:
        """The package re-packed from its validated content: the download name and an open file at offset 0."""
        record = self._require(plugin_id)
        if record.package is None:
            raise _conflict(
                "這個插件包的內容讀不到或不合規，無法匯出", plugin_id=plugin_id
            )
        # The caller closes it: the archive is streamed to the client from this file.
        spool = tempfile.SpooledTemporaryFile(  # noqa: SIM115 -- caller owns the returned stream
            max_size=EXPORT_SPOOL_BYTES, dir=str(self._staging)
        )
        try:
            write_archive(record.package, spool, limits=self.limits)
            spool.seek(0)
        except BaseException:
            spool.close()
            raise
        return archive_name(record.package), spool

    def _owned_refs(self, record: PluginRecord) -> Callable[[str], bool]:
        """Which project references belong to this package: bare ids for a built-in one, its prefix otherwise."""
        if record.source != "builtin":
            prefix = f"{record.plugin_id}/"
            return lambda ref: ref.startswith(prefix)
        own = builtin_rule_ids([record])
        if record.package is not None:
            contributes = record.package.manifest.get("contributes") or {}
            own |= {str(item["id"]) for item in contributes.get("generation") or []}
        return lambda ref: ref in own

    def project_uses(self, record: PluginRecord) -> list[dict[str, Any]]:
        """Projects whose document selects a contribution of this package (read-only: no document is changed)."""
        owned = self._owned_refs(record)
        uses = []
        for doc in self._projects():
            selected = doc.get("prompt_plugins")
            refs = (
                [ref for ref in selected if is_plugin_ref(ref) and owned(ref)]
                if isinstance(selected, list)
                else []
            )
            if refs:
                title = str(doc.get("title") or "")[:PROJECT_TITLE_MAX]
                uses.append(
                    {
                        "project_id": str(doc["project_id"]),
                        "title": title,
                        "refs": refs[:PROJECT_REFS_MAX],
                    }
                )
        return sorted(uses, key=lambda item: item["project_id"])

    def removal_preview(self, plugin_id: str) -> dict[str, Any]:
        """Contract ``StudioPluginRemovalPreview``."""
        record = self._require(plugin_id)
        blocking = []
        if record.source != "installed":
            blocking.append(issue(record.source))
        elif self.config.install != "api":
            blocking.append(issue("install_disabled"))
        elif self._registry_fault is not None:
            blocking.append(self._registry_issue())
        return {
            "plugin_id": plugin_id,
            "version": record.version,
            "digest": record.digest,
            "can_remove": not blocking,
            "blocking": blocking,
            "projects": self.project_uses(record),
        }

    # ------------------------------------------------------------------ writes
    @contextlib.contextmanager
    def exclusive(self) -> Iterator[None]:
        """The single writer. A second install, update, removal, switch or reload is refused, never queued."""
        if not self._writer.acquire(blocking=False):
            raise _conflict("另一個插件操作正在進行；請稍後再試")
        try:
            yield
        finally:
            self._writer.release()

    def require_install_enabled(self) -> None:
        """Reject installation when the local plugin configuration disables it."""
        if self.config.install != "api":
            raise ComponentError(
                "STUDIO_PLUGIN_INSTALL_DISABLED", MESSAGES["install_disabled"]
            )

    def _registry_issue(self) -> Issue:
        return issue(
            "registry_unreadable", path=REGISTRY_FILE, reason=self._registry_fault
        )

    def _require_registry(self) -> None:
        if self._registry_fault is not None:
            raise _conflict(
                MESSAGES["registry_unreadable"], reason=self._registry_fault
            )

    def _write_registry(self, entries: Mapping[str, Entry]) -> None:
        try:
            atomic_write_json(
                self._registry, {"version": REGISTRY_VERSION, "plugins": dict(entries)}
            )
        except OSError as exc:
            raise disk_error(exc, "無法保存插件安裝紀錄") from exc

    def new_staging(self) -> Path:
        """A new, empty directory for one upload; the caller removes it with :meth:`discard_staging`."""
        path = self._staging / new_id()
        try:
            path.mkdir(mode=0o700)
        except OSError as exc:
            raise disk_error(exc, "無法建立插件的暫存目錄") from exc
        return path

    def discard_staging(self, staged: Path) -> None:
        """Remove the temporary staging tree for the package."""
        shutil.rmtree(staged, ignore_errors=True)

    def _check_install(
        self,
        package: Package,
        current: Entry | None,
        *,
        replace: bool,
        digest: str | None,
    ) -> None:
        plugin_id = package.plugin_id
        known = self._snapshot.records.get(plugin_id)
        if known is not None and known.source != "installed":
            raise _conflict(
                "這個 id 已由開發目錄或內建插件提供，不能安裝同 id 的包",
                plugin_id=plugin_id,
            )
        if digest is not None and digest != package.digest:
            raise _conflict(
                "上傳的插件包與預期的 digest 不同；沒有安裝",
                plugin_id=plugin_id,
                digest=package.digest,
            )
        if current is not None and not replace:
            raise _conflict(
                f"插件 {plugin_id} 已安裝；要取代目前的版本請明確選擇更新",
                plugin_id=plugin_id,
                installed_version=current["version"],
                installed_digest=current["digest"],
            )
        others = [entry for name, entry in self._entries.items() if name != plugin_id]
        if current is None and len(others) >= self.limits.packages:
            raise _conflict(
                "已安裝的插件數量達到上限；請先移除不用的插件",
                limit=self.limits.packages,
            )
        if (
            sum(int(entry["size_bytes"]) for entry in others) + package.size_bytes
            > self.limits.total_bytes
        ):
            raise _conflict(
                "已安裝的插件合計大小會超過上限；請先移除不用的插件",
                limit=self.limits.total_bytes,
            )

    def _new_entry(self, package: Package, current: Entry | None) -> Entry:
        now = utc_now()
        permissions = list(package.manifest.get("permissions") or [])
        return {
            "version": package.version,
            "digest": package.digest,
            "directory": f"{package.version}-{package.digest}",
            "size_bytes": package.size_bytes,
            "disabled": bool(current["disabled"]) if current else False,
            "revision": int(current["revision"]) + 1 if current else 1,
            "installed_at": current["installed_at"] if current else now,
            "updated_at": now,
            "consent": {
                "digest": package.digest,
                "permissions": permissions,
                "at": now,
            },
        }

    def _place(self, content: Path, home: Path, target: Path) -> None:
        """Move unpacked content to ``target`` in the package's directory ``home``."""
        try:
            created = not home.exists()
            _mkdir(home)
            if created:
                fsync_dir(self._packages)
            if target.exists():  # an unreferenced leftover, or the registered copy that no longer verifies
                self._remove_tree(target)
            content.rename(target)
            fsync_dir(home)
        except OSError as exc:
            with contextlib.suppress(OSError):
                home.rmdir()  # only an empty directory goes: the one a first install had just made
            raise disk_error(exc, "無法安裝插件包") from exc

    def _commit(
        self, package: Package, entry: Entry, current: Entry | None
    ) -> tuple[Package, Path | None]:
        """Move the staged content into ``packages/`` and replace the registry; undone when the registry write fails.

        Returns the installed package and the directory of the version it replaced (to remove once readers have the
        new snapshot). The same content installed again stays where it is, as long as that copy still verifies.
        """
        plugin_id = package.plugin_id
        home = self._packages / plugin_id
        target = home / entry["directory"]
        same = current is not None and current["directory"] == entry["directory"]
        loaded = self._load_installed(plugin_id, entry) if same else _Loaded(None)
        if loaded.package is None:
            self._place(package.root, home, target)
            # What the next start will load: a copy that does not load now would turn invalid then
            loaded = self._load_installed(plugin_id, entry)
        if loaded.package is None:
            self._discard(home, target)
            raise invalid(list(loaded.issues))
        try:
            self._write_registry({**self._entries, plugin_id: entry})
        except ComponentError:
            if (
                not same
            ):  # a copy of the same content is what the registry still names: it stays
                self._discard(home, target)
            raise
        replaced = (
            home / current["directory"] if current is not None and not same else None
        )
        return loaded.package, replaced

    def _discard(self, home: Path, target: Path) -> None:
        """Remove a placed copy the registry does not name, and the directory of a first install with it."""
        self._remove_tree(target)
        with contextlib.suppress(OSError):
            home.rmdir()  # one that holds another version is not empty and stays

    def install(
        self, staged: Path, *, replace: bool, dry_run: bool, digest: str | None
    ) -> dict[str, Any]:
        """Validate the upload in ``staged`` and, unless ``dry_run``, install it (contract ``StudioPluginInstallResult``). The caller holds :meth:`exclusive` and discards ``staged`` afterwards."""
        self.require_install_enabled()
        self._require_registry()
        package = unpack_archive(
            staged / UPLOAD_NAME, staged / CONTENT_NAME, limits=self.limits
        )
        plugin_id = package.plugin_id
        current = self._entries.get(plugin_id)
        self._check_install(package, current, replace=replace or dry_run, digest=digest)
        entry = self._new_entry(package, current)
        if not dry_run:
            package, replaced = self._commit(package, entry, current)
            self._entries = {**self._entries, plugin_id: entry}
            self._installed[plugin_id] = _Loaded(package)
            self._publish()
            if replaced is not None:
                self._remove_tree(replaced)
        record = self._installed_record(plugin_id, entry, _Loaded(package))
        granted = set(current["consent"]["permissions"]) if current else set()
        return {
            "dry_run": dry_run,
            "detail": self._detail(record),
            "replaces": {"version": current["version"], "digest": current["digest"]}
            if current
            else None,
            "permissions_added": [
                name for name in entry["consent"]["permissions"] if name not in granted
            ],
        }

    def _installed_entry(self, plugin_id: str, refusal: str) -> Entry:
        """The registry entry of an installed package; built-in and development packages are refused."""
        record = self._require(plugin_id)
        if record.source != "installed":
            raise _conflict(refusal, plugin_id=plugin_id, source=record.source)
        self._require_registry()
        return self._entries[plugin_id]

    def set_disabled(
        self, plugin_id: str, *, disabled: bool, expected_revision: int
    ) -> dict[str, Any]:
        """Switch an installed package off or on for the whole installation (contract ``StudioPluginDetail``)."""
        entry = self._installed_entry(plugin_id, "只有經 API 安裝的插件可以停用或啟用")
        require_revision(
            int(entry["revision"]),
            expected_revision,
            what="插件",
            suffix="請重新載入後再修改",
        )
        updated = {
            **entry,
            "disabled": disabled,
            "revision": int(entry["revision"]) + 1,
            "updated_at": utc_now(),
        }
        self._write_registry({**self._entries, plugin_id: updated})
        self._entries = {**self._entries, plugin_id: updated}
        self._publish()
        return self.detail(plugin_id)

    def remove(self, plugin_id: str, *, digest: str) -> dict[str, Any]:
        """Remove an installed package (contract ``StudioPluginRemoval``). Project documents are not touched: their references stay and read as missing."""
        record = self._require(plugin_id)
        self.require_install_enabled()
        entry = self._installed_entry(plugin_id, MESSAGES.get(record.source, ""))
        if entry["digest"] != digest:
            raise _conflict(
                "已安裝的插件與看到的不同（digest 不符）；請重新載入後再移除",
                plugin_id=plugin_id,
                installed_digest=entry["digest"],
            )
        uses = self.project_uses(record)
        remaining = {
            name: item for name, item in self._entries.items() if name != plugin_id
        }
        self._write_registry(remaining)
        self._entries = remaining
        self._installed.pop(plugin_id, None)
        self._publish()
        self._remove_tree(self._packages / plugin_id)
        return {
            "plugin_id": plugin_id,
            "removed": True,
            "version": entry["version"],
            "digest": entry["digest"],
            "projects": uses,
        }

    def reload(self, plugin_id: str) -> dict[str, Any]:
        """Read the development directories again (contract ``StudioPluginDetail`` of the reloaded package)."""
        record = self._require(plugin_id)
        if record.source != "dev":
            raise _conflict(
                "只有開發目錄的插件可以重新載入",
                plugin_id=plugin_id,
                source=record.source,
            )
        index = next(
            at
            for at, directory in enumerate(self._dev)
            if directory.plugin_id == plugin_id
        )
        self._dev = tuple(self._load_dev(directory) for directory in self._dev)
        self._publish()
        current = self._dev[index].plugin_id
        reloaded = self._snapshot.records.get(current) if current is not None else None
        # The registry lists the first directory of an id: an earlier directory with this one's new id took it.
        listed = next(
            (
                at
                for at, directory in enumerate(self._dev)
                if directory.plugin_id == current
            ),
            None,
        )
        if reloaded is None or reloaded.source != "dev" or listed != index:
            raise _conflict(
                "重新載入後這個目錄的插件 id 與另一個插件相同；見登錄表的 problems",
                plugin_id=current,
            )
        return self._detail(reloaded)


__all__ = ["STORE_DIR", "UPLOAD_NAME", "PluginStore", "disk_error"]
