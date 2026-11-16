"""The component catalog: every Node PUTs its full NodeSnapshot every few
seconds; the first valid one registers it.

- No allowlist, approval or join token: node_id and process_instance_id only correlate data.
- ``last_seen`` uses the controller's monotonic clock; no PUT for ``node_stale_seconds`` → offline. Offline only
  means no new calls are sent (and it is shown); no remote model is stopped or restarted.
- One node_id reported by two processes (different endpoints within the stale window, or an older process
  reporting again after a newer one appeared) → ``duplicate_node_id``: both sources stay visible (one directory
  row each) and neither silently replaces the other; new calls to that node are refused until the user changes
  an ID or stops the duplicate (the conflict clears once one side is stale).
- The catalog lives in memory; the optional ``catalog-cache.json`` is only shown after a restart while Nodes
  register again (always offline).
- ``catalog_lite()`` (x-phasyn-extension, GET /api/catalog?parts=false): components without ``parts`` (about 85 %
  of the full catalog) and ``facts``, carrying ``parts_count``, ``parts_digest`` and ``facts_digest`` instead. The
  digests are computed once at registration; a client reads the full catalog only when one of them changes.
- Cost: a Node PUTs its full snapshot every few seconds. A snapshot whose content (everything but its
  ``observed_at``) equals the last validated one from the same process is not validated or copied again.
- The catalog's ``observed_at`` changes only when what it shows changes (a Node's content, a directory state),
  so an idle catalog reads the same on every poll.
"""

from __future__ import annotations

import copy
import itertools
import logging
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components import PROTOCOL_VERSION, contracts
from phasyn_components.canonical import digest, read_json
from phasyn_components.errors import ComponentError
from phasyn_components.fs import atomic_write_json
from phasyn_components.ids import is_uuid
from phasyn_components.timeutil import utc_now

log = logging.getLogger("phasyn_controller.catalog")

MAX_SOURCES_PER_NODE = 8
CACHE_SAVE_INTERVAL_S = 30.0


@dataclass
class Source:
    """某個 node_id 的一個上報程序（process_instance_id）。"""

    process_instance_id: str
    endpoint: str
    label: str
    snapshot: dict[str, Any]
    order: int
    last_seen_mono: float | None  # None：來自 cache，尚未收到新 PUT
    last_seen_at: str
    conflict_with: set[str] = field(default_factory=set)
    digests: dict[str, LiteDigests] = field(default_factory=dict)  # component_id → digests, computed at registration


@dataclass
class NodeRecord:
    node_id: str
    sources: dict[str, Source] = field(default_factory=dict)


@dataclass(frozen=True)
class _Accepted:
    """A snapshot that passed validation: a private copy plus the digests computed once at registration."""

    content_digest: str
    snapshot: dict[str, Any]
    digests: dict[str, LiteDigests]


def content_digest(body: dict[str, Any]) -> str:
    """Digest of a NodeSnapshot without its ``observed_at`` (the only field that changes on every push)."""
    return digest({key: value for key, value in body.items() if key != "observed_at"})


def _protocol_major(version: str) -> str:
    return version.split(".", 1)[0].strip()


@dataclass(frozen=True)
class LiteDigests:
    """SHA-256 (canonical JSON) of a component's ``parts`` and ``facts``; ``facts`` is None without facts."""

    parts: str
    facts: str | None


def component_digests(comp: Mapping[str, Any]) -> LiteDigests:
    facts = comp.get("facts")
    return LiteDigests(digest(comp.get("parts") or []), None if facts is None else digest(facts))


def lite_digests(snapshot: Mapping[str, Any]) -> dict[str, LiteDigests]:
    """The lite-catalog digests of every component of a snapshot, by component id."""
    return {str(comp["component_id"]): component_digests(comp) for comp in snapshot.get("components") or []}


def lite_component(comp: Mapping[str, Any], digests: Mapping[str, LiteDigests]) -> dict[str, Any]:
    """ComponentDescriptorLite: ``parts`` and ``facts`` are replaced by parts_count, parts_digest and facts_digest
    (null when the component has no facts; an empty object still has a digest); the rest is copied."""
    known = digests.get(str(comp["component_id"])) or component_digests(comp)
    out: dict[str, Any] = {key: copy.deepcopy(value) for key, value in comp.items() if key not in ("parts", "facts")}
    out["parts_count"] = len(comp.get("parts") or [])
    out["parts_digest"] = known.parts
    out["facts_digest"] = known.facts
    return out


class Catalog:
    def __init__(
        self,
        *,
        stale_seconds: float,
        controller_id: str,
        controller_endpoint: str,
        clock: Callable[[], float] = time.monotonic,
        cache_path: Path | None = None,
    ) -> None:
        self.stale_seconds = float(stale_seconds)
        self.controller_id = controller_id
        self.controller_endpoint = controller_endpoint
        self.clock = clock
        self.cache_path = cache_path
        self._nodes: dict[str, NodeRecord] = {}
        self._order = itertools.count(1)
        self._lock = threading.RLock()
        self._save_lock = threading.Lock()
        self._last_save = float("-inf")
        self._digests: dict[str, str] = {}  # node_id → content digest of its last snapshot
        self._accepted: dict[tuple[str, str], _Accepted] = {}  # (node_id, process_instance_id) → last validated
        self._stamp_key: tuple[Any, ...] | None = None
        self._stamp_at = utc_now()
        self.validations = 0  # full snapshot validations (observability and tests)

    # ------------------------------------------------------------------ freshness
    def _fresh(self, src: Source, now: float) -> bool:
        return src.last_seen_mono is not None and now - src.last_seen_mono <= self.stale_seconds

    def _state(self, rec: NodeRecord, now: float) -> str:
        fresh = [s for s in rec.sources.values() if self._fresh(s, now)]
        if not fresh:
            return "offline"
        fresh_ids = {s.process_instance_id for s in fresh}
        if any(s.conflict_with & fresh_ids for s in fresh):
            return "duplicate_node_id"
        return "online"

    def _primary(self, rec: NodeRecord, now: float) -> Source | None:
        fresh = [s for s in rec.sources.values() if self._fresh(s, now)]
        if fresh:
            return max(fresh, key=lambda s: s.order)
        if not rec.sources:
            return None
        return max(rec.sources.values(), key=lambda s: (s.last_seen_mono or float("-inf"), s.last_seen_at, s.order))

    # ------------------------------------------------------------------ registration
    def register(self, path_node_id: str, body: Any) -> tuple[dict[str, Any], bool]:
        """登記一份 NodeSnapshot；回傳 (RegistrationAck, 是否值得更新 cache)。"""
        if not isinstance(body, dict):
            raise ComponentError("INVALID_ARGUMENT", "NodeSnapshot 必須是 JSON object")
        version = body.get("protocol_version")
        if isinstance(version, str) and version != PROTOCOL_VERSION:
            same_major = _protocol_major(version) == _protocol_major(PROTOCOL_VERSION)
            raise ComponentError(
                "PROTOCOL_MISMATCH",
                f"Node 協定版本 {version} 與主控 {PROTOCOL_VERSION} 不相容"
                + ("（minor 擴充需雙端契約同時更新）" if same_major else "（major 不同）")
                + "；請使用相容版本的 Node 與主控",
                details={"expected": PROTOCOL_VERSION, "got": version},
            )
        accepted = self._accept(path_node_id, body)
        snapshot, digests = accepted.snapshot, accepted.digests
        node_id = str(snapshot["node_id"]).lower()
        pid = str(snapshot["process_instance_id"]).lower()
        endpoint = str(snapshot["endpoint"]).rstrip("/")
        now = self.clock()
        stamp = utc_now()
        with self._lock:
            rec = self._nodes.setdefault(node_id, NodeRecord(node_id))
            fresh = {k: s for k, s in rec.sources.items() if self._fresh(s, now)}
            src = rec.sources.get(pid)
            if src is None:
                # 新程序：stale 視窗內另一個程序從不同 endpoint 上報 → 重複 node_id；同 endpoint 視為重啟
                conflicts = {k for k, s in fresh.items() if s.endpoint != endpoint}
                for key in [k for k in rec.sources if k not in fresh]:
                    del rec.sources[key]  # 已停止上報的舊程序（例如重啟前、或 cache 載入）
                src = Source(pid, endpoint, str(body["label"]), snapshot, next(self._order), now, stamp)
                src.conflict_with |= conflicts
                for key in conflicts:
                    rec.sources[key].conflict_with.add(pid)
                    log.warning(
                        "node_id %s 由兩個 endpoint 上報：%s 與 %s", node_id, rec.sources[key].endpoint, endpoint
                    )
                rec.sources[pid] = src
            else:
                newer = [s for s in fresh.values() if s.order > src.order and s.process_instance_id != pid]
                for other in newer:
                    other.conflict_with.add(pid)
                    src.conflict_with.add(other.process_instance_id)
                    log.warning(
                        "node_id %s：較舊的程序 %s 在較新的 %s 出現後又上報", node_id, pid, other.process_instance_id
                    )
            src.endpoint = endpoint
            src.label = str(body["label"])
            src.snapshot = snapshot
            src.digests = digests
            src.last_seen_mono = now
            src.last_seen_at = stamp
            if len(rec.sources) > MAX_SOURCES_PER_NODE:
                by_age = sorted(
                    (k for k in rec.sources if k != pid), key=lambda k: rec.sources[k].last_seen_mono or float("-inf")
                )
                for key in by_age[: len(rec.sources) - MAX_SOURCES_PER_NODE]:
                    del rec.sources[key]
            changed = self._digests.get(node_id) != accepted.content_digest
            self._digests[node_id] = accepted.content_digest
            ack = {
                "registered": True,
                "nodes": self._directory_locked(now),
                "controller_endpoint": self.controller_endpoint,
                "controller_id": self.controller_id,
            }
        return ack, changed or now - self._last_save >= CACHE_SAVE_INTERVAL_S

    def _accept(self, path_node_id: str, body: dict[str, Any]) -> _Accepted:
        """Validate a snapshot, or reuse the last validated one of the same process when only observed_at moved.

        Each step is timed at DEBUG level (content digest, validation, copy, lite digests).
        """
        clock = time.perf_counter
        t0 = clock()
        key = (str(body.get("node_id") or "").lower(), str(body.get("process_instance_id") or "").lower())
        fingerprint = content_digest(body)
        t1 = clock()
        observed_at = body.get("observed_at")
        previous = self._accepted.get(key)
        if previous is not None and previous.content_digest == fingerprint and isinstance(observed_at, str):
            self._check_path(path_node_id, key[0], body)
            log.debug("NodeSnapshot %s unchanged: content digest %.1f ms, validation skipped", key[0], (t1 - t0) * 1e3)
            # Only observed_at differs: share the validated copy (every reader deep-copies what it hands out).
            return _Accepted(fingerprint, {**previous.snapshot, "observed_at": observed_at[:64]}, previous.digests)
        contracts.validate("NodeSnapshot", body, what="NodeSnapshot")
        self.validations += 1
        node_id = str(body["node_id"]).lower()
        self._check_path(path_node_id, node_id, body)
        for comp in body["components"]:
            if str(comp["node_id"]).lower() != node_id:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    f"元件 {comp['component_id']} 的 node_id {comp['node_id']} 與 Node {node_id} 不同",
                    details={"component_id": comp["component_id"]},
                )
        t2 = clock()
        snapshot = copy.deepcopy(body)
        t3 = clock()
        accepted = _Accepted(fingerprint, snapshot, lite_digests(snapshot))
        t4 = clock()
        with self._lock:
            self._accepted[key] = accepted
            if len(self._accepted) > MAX_SOURCES_PER_NODE * max(1, len(self._nodes) + 1):
                self._accepted.pop(next(iter(self._accepted)))  # bounded: forget the oldest process
        log.debug(
            "NodeSnapshot %s: content digest %.1f ms, validation %.1f ms, copy %.1f ms, lite digests %.1f ms",
            node_id,
            (t1 - t0) * 1e3,
            (t2 - t1) * 1e3,
            (t3 - t2) * 1e3,
            (t4 - t3) * 1e3,
        )
        return accepted

    @staticmethod
    def _check_path(path_node_id: str, node_id: str, body: dict[str, Any]) -> None:
        if node_id != path_node_id.lower():
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"路徑 node_id {path_node_id} 與本文 node_id {body['node_id']} 不同",
                details={"path_node_id": path_node_id, "body_node_id": body["node_id"]},
            )

    # ------------------------------------------------------------------ views
    def _stamp(self, directory: list[dict[str, Any]]) -> str:
        """(lock held) The catalog's observed_at: renewed only when node content or a directory state changes."""
        key = (
            tuple(sorted(self._digests.items())),
            tuple((d["node_id"], d["endpoint"], d["label"], d["state"]) for d in directory),
        )
        if key != self._stamp_key:
            self._stamp_key = key
            self._stamp_at = utc_now()
        return self._stamp_at

    def _directory_locked(self, now: float) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for node_id in sorted(self._nodes):
            rec = self._nodes[node_id]
            state = self._state(rec, now)
            if state == "duplicate_node_id":
                sources = sorted((s for s in rec.sources.values() if self._fresh(s, now)), key=lambda s: s.order)
            else:
                primary = self._primary(rec, now)
                sources = [primary] if primary is not None else []
            for src in sources:
                out.append(
                    {
                        "node_id": node_id,
                        "label": src.label,
                        "endpoint": src.endpoint,
                        "state": state,
                        "last_seen_at": src.last_seen_at,
                    }
                )
        return out

    def directory(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._directory_locked(self.clock())

    def catalog(self) -> dict[str, Any]:
        now = self.clock()
        with self._lock:
            nodes = []
            for node_id in sorted(self._nodes):
                primary = self._primary(self._nodes[node_id], now)
                if primary is not None:
                    nodes.append(copy.deepcopy(primary.snapshot))
            directory = self._directory_locked(now)
            return {"nodes": nodes, "directory": directory, "observed_at": self._stamp(directory)}

    def catalog_lite(self) -> dict[str, Any]:
        """CatalogLite (x-phasyn-extension): catalog() with every component as a ComponentDescriptorLite."""
        now = self.clock()
        with self._lock:
            nodes = []
            for node_id in sorted(self._nodes):
                primary = self._primary(self._nodes[node_id], now)
                if primary is None:
                    continue
                snap = primary.snapshot
                node = {key: copy.deepcopy(value) for key, value in snap.items() if key != "components"}
                node["components"] = [lite_component(comp, primary.digests) for comp in snap.get("components") or []]
                nodes.append(node)
            directory = self._directory_locked(now)
            return {"nodes": nodes, "directory": directory, "observed_at": self._stamp(directory)}

    def state(self, node_id: str) -> str | None:
        with self._lock:
            rec = self._nodes.get(node_id.lower())
            return None if rec is None else self._state(rec, self.clock())

    def label(self, node_id: str) -> str:
        with self._lock:
            rec = self._nodes.get(node_id.lower())
            primary = None if rec is None else self._primary(rec, self.clock())
            return primary.label if primary is not None else node_id

    def endpoint_for_call(self, node_id: str) -> str:
        """新呼叫（寫入／推論／控制）用的 endpoint；offline、未知或 node_id 重複都不送。"""
        now = self.clock()
        with self._lock:
            rec = self._nodes.get(node_id.lower())
            primary = None if rec is None else self._primary(rec, now)
            if rec is None or primary is None:
                raise ComponentError(
                    "NODE_UNREACHABLE",
                    f"Node {node_id} 不在目錄中（尚未登記）；呼叫沒有送出",
                    details={"node_id": node_id},
                )
            state = self._state(rec, now)
            if state == "offline":
                raise ComponentError(
                    "NODE_UNREACHABLE",
                    f"Node {primary.label}（{node_id}）已 offline（超過 {int(self.stale_seconds)} 秒沒有登記）；呼叫沒有送出",
                    details={"node_id": node_id, "last_seen_at": primary.last_seen_at},
                )
            if state == "duplicate_node_id":
                endpoints = sorted({s.endpoint for s in rec.sources.values() if self._fresh(s, now)})
                raise ComponentError(
                    "DUPLICATE_NODE_ID",
                    f"node_id {node_id} 同時由多個程序上報（{', '.join(endpoints)}）；請修改其中一台的 node_id 或停止重複程序",
                    details={"node_id": node_id, "endpoints": endpoints},
                )
            return primary.endpoint

    def endpoint_for_read(self, node_id: str) -> str:
        """只讀（媒體預覽、補抓紀錄）用的 endpoint：offline 仍嘗試讀；未知 node 才拒絕。"""
        with self._lock:
            rec = self._nodes.get(node_id.lower())
            primary = None if rec is None else self._primary(rec, self.clock())
            if primary is None:
                raise ComponentError(
                    "NODE_UNREACHABLE", f"Node {node_id} 不在目錄中，不知道它的位址", details={"node_id": node_id}
                )
            return primary.endpoint

    def descriptors(self, keys: Iterable[tuple[str, str]] | None = None) -> dict[tuple[str, str], dict[str, Any]]:
        """Deep copies of the current descriptors by (node_id, component_id); ``keys`` limits what is copied."""
        wanted = None if keys is None else {(node.lower(), component) for node, component in keys}
        now = self.clock()
        out: dict[tuple[str, str], dict[str, Any]] = {}
        with self._lock:
            for node_id, rec in self._nodes.items():
                primary = self._primary(rec, now)
                if primary is None:
                    continue
                for comp in primary.snapshot.get("components") or []:
                    key = (node_id, str(comp["component_id"]))
                    if wanted is None or key in wanted:
                        out[key] = copy.deepcopy(comp)
        return out

    # ------------------------------------------------------------------ cache
    def load_cache(self) -> int:
        """讀取上次的目錄快照（只顯示；全部 offline 直到新的 PUT）。"""
        if self.cache_path is None:
            return 0
        try:
            doc = read_json(self.cache_path)
        except FileNotFoundError:
            return 0
        except (OSError, ValueError) as exc:
            log.warning("目錄快取無法讀取（略過）：%s", exc)
            return 0
        items = doc.get("nodes") if isinstance(doc, dict) else None
        loaded = 0
        with self._lock:
            for item in items if isinstance(items, list) else []:
                snapshot = item.get("snapshot") if isinstance(item, dict) else None
                if not contracts.is_valid("NodeSnapshot", snapshot) or not isinstance(snapshot, dict):
                    continue
                node_id = str(snapshot["node_id"]).lower()
                if not is_uuid(node_id) or node_id in self._nodes:
                    continue
                pid = str(snapshot["process_instance_id"]).lower()
                last_seen_at = str(item.get("last_seen_at") or snapshot.get("observed_at") or utc_now())
                src = Source(
                    pid,
                    str(snapshot["endpoint"]),
                    str(snapshot["label"]),
                    snapshot,
                    next(self._order),
                    None,
                    last_seen_at,
                    digests=lite_digests(snapshot),
                )
                self._nodes[node_id] = NodeRecord(node_id, {pid: src})
                loaded += 1
        return loaded

    def save_cache(self, *, force: bool = False) -> None:
        if self.cache_path is None:
            return
        with self._save_lock:
            now = self.clock()
            if not force and now - self._last_save < 1.0:
                return
            with self._lock:
                nodes = []
                for node_id in sorted(self._nodes):
                    primary = self._primary(self._nodes[node_id], now)
                    if primary is not None:
                        nodes.append(
                            {"snapshot": copy.deepcopy(primary.snapshot), "last_seen_at": primary.last_seen_at}
                        )
            try:
                atomic_write_json(self.cache_path, {"saved_at": utc_now(), "nodes": nodes})
                self._last_save = now
            except (OSError, ValueError) as exc:
                log.warning("目錄快取寫入失敗（不影響運作）：%s", exc)


__all__ = ["Catalog", "LiteDigests", "NodeRecord", "Source", "component_digests", "lite_component", "lite_digests"]
