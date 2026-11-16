"""模型權重的下載計畫（x-phasyn-extension）。

provider 以 ``weights(settings)`` 宣告這個元件需要哪些固定版本的權重檔（Hugging Face repo、commit、每個檔案的大小與
SHA-256 或 git blob SHA-1），以及放在元件模型根目錄（``load.model_path``）下的哪裡；不能下載的需求（在 GPU 上計算的
sidecar、使用者自己的檔案）只寫成說明。計畫只是資料：下載由 Node 在使用者明確要求時進行（phasyn_node.weights），
元件載入時仍然只讀本機檔案、從不下載。

這個模組不 import PyTorch；runtime 以 ``python -m <module> --weights --provider P --settings-json @file`` 輸出計畫。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from .errors import ComponentError

_HEX = frozenset("0123456789abcdef")
_REPO_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def safe_relative(path: str, *, allow_empty: bool = False, what: str = "路徑") -> str:
    """POSIX 相對路徑（不可為絕對路徑、不含 ``..``、反斜線或空段）；回傳正規化後的字串。"""
    if not isinstance(path, str) or "\\" in path or "\x00" in path:
        raise ComponentError("RUNTIME_ERROR", f"權重計畫的{what}不是合法的相對路徑：{path!r}")
    if path in ("", "."):
        if allow_empty:
            return ""
        raise ComponentError("RUNTIME_ERROR", f"權重計畫的{what}不可為空")
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in path.split("/")):
        raise ComponentError("RUNTIME_ERROR", f"權重計畫的{what}不是合法的相對路徑：{path!r}")
    return str(pure)


def _hex(value: Any, length: int, what: str) -> str | None:
    if value is None:
        return None
    text = str(value).lower()
    if len(text) != length or not set(text) <= _HEX:
        raise ComponentError("RUNTIME_ERROR", f"權重檔的 {what} 格式不對：{value!r}")
    return text


@dataclass(frozen=True)
class WeightFile:
    """一個權重檔。``path`` 相對於所屬權重組的 ``dest``；``source_path`` 是 repo 裡的路徑（與 path 不同時才填）。
    大檔（Git LFS）以 SHA-256 驗證，其他檔以 git blob SHA-1 驗證，兩者至少要有一個。"""

    path: str
    size: int
    sha256: str | None = None
    git_oid: str | None = None
    source_path: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", safe_relative(self.path, what="檔案路徑"))
        if self.source_path is not None:
            object.__setattr__(self, "source_path", safe_relative(self.source_path, what="來源路徑"))
        if not isinstance(self.size, int) or isinstance(self.size, bool) or self.size < 0:
            raise ComponentError("RUNTIME_ERROR", f"權重檔 {self.path} 的大小不對：{self.size!r}")
        object.__setattr__(self, "sha256", _hex(self.sha256, 64, "sha256"))
        object.__setattr__(self, "git_oid", _hex(self.git_oid, 40, "git_oid"))
        if self.sha256 is None and self.git_oid is None:
            raise ComponentError("RUNTIME_ERROR", f"權重檔 {self.path} 沒有 sha256 也沒有 git_oid，無法驗證")

    @property
    def repo_path(self) -> str:
        return self.source_path or self.path

    @property
    def identity(self) -> tuple[int, str]:
        """(大小, 雜湊)：兩個檔案的 identity 相同＝內容相同（可以 hard link 共用）。"""
        return (self.size, f"sha256:{self.sha256}" if self.sha256 else f"git:{self.git_oid}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "size": self.size,
            "sha256": self.sha256,
            "git_oid": self.git_oid,
            "source_path": self.source_path,
        }

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any]) -> WeightFile:
        return cls(
            path=str(doc["path"]),
            size=doc["size"],
            sha256=doc.get("sha256"),
            git_oid=doc.get("git_oid"),
            source_path=doc.get("source_path"),
        )


@dataclass(frozen=True)
class WeightLicense:
    """權重的授權：名稱、全文連結與要特別注意的條款（介面在下載前顯示，使用者同意後才下載）。"""

    name: str
    url: str
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "url": self.url, "note": self.note}

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any]) -> WeightLicense:
        return cls(name=str(doc["name"]), url=str(doc["url"]), note=doc.get("note"))


@dataclass(frozen=True)
class WeightSet:
    """一組來自同一個 repo commit 的權重檔，放在模型根目錄下的 ``dest``（"" ＝根目錄本身）。

    ``links``：檔案 path → 模型根目錄下內容相同的其他檔案（相對於根目錄），已經存在時以 hard link 共用而不下載
    （例如 MiniMax-H3 的 FL2VA 與 Ref2VA 有一半的檔案相同）。
    """

    set_id: str
    label: str
    repo: str
    revision: str
    license: WeightLicense
    dest: str
    files: tuple[WeightFile, ...]
    links: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.set_id or not all(ch.isalnum() or ch in "-_." for ch in self.set_id):
            raise ComponentError("RUNTIME_ERROR", f"權重組 id 不合法：{self.set_id!r}")
        owner, _, name = self.repo.partition("/")
        if not owner or not name or "/" in name or not set(owner + name) <= _REPO_CHARS:
            raise ComponentError("RUNTIME_ERROR", f"權重組 {self.set_id} 的 repo 不合法：{self.repo!r}")
        if _hex(self.revision, 40, "revision") is None:
            raise ComponentError("RUNTIME_ERROR", f"權重組 {self.set_id} 沒有固定的 revision")
        object.__setattr__(self, "dest", safe_relative(self.dest, allow_empty=True, what="目的地"))
        paths = [item.path for item in self.files]
        if len(set(paths)) != len(paths):
            raise ComponentError("RUNTIME_ERROR", f"權重組 {self.set_id} 有重複的檔案路徑")
        known = set(paths)
        links: dict[str, tuple[str, ...]] = {}
        for path, others in self.links.items():
            if path not in known:
                raise ComponentError("RUNTIME_ERROR", f"權重組 {self.set_id} 的 links 指到不在組內的檔案 {path}")
            links[path] = tuple(safe_relative(other, what="共用來源") for other in others)
        object.__setattr__(self, "links", links)

    @property
    def total_bytes(self) -> int:
        return sum(item.size for item in self.files)

    def to_dict(self) -> dict[str, Any]:
        return {
            "set_id": self.set_id,
            "label": self.label,
            "repo": self.repo,
            "revision": self.revision,
            "license": self.license.to_dict(),
            "dest": self.dest,
            "files": [item.to_dict() for item in self.files],
            "links": {path: list(others) for path, others in self.links.items()},
        }

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any]) -> WeightSet:
        return cls(
            set_id=str(doc["set_id"]),
            label=str(doc["label"]),
            repo=str(doc["repo"]),
            revision=str(doc["revision"]),
            license=WeightLicense.from_dict(doc["license"]),
            dest=str(doc.get("dest") or ""),
            files=tuple(WeightFile.from_dict(item) for item in doc.get("files") or []),
            links={
                str(path): tuple(str(other) for other in others) for path, others in (doc.get("links") or {}).items()
            },
        )


@dataclass(frozen=True)
class WeightPlan:
    """一個元件的權重計畫：模型根目錄（設定裡的 ``load.model_path``，沒設定時 None）、可下載的權重組，以及不能下載的
    需求說明。沒有權重的 provider（CPU 工具）回傳空計畫。"""

    root: str | None
    sets: tuple[WeightSet, ...] = ()
    notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        ids = [item.set_id for item in self.sets]
        if len(set(ids)) != len(ids):
            raise ComponentError("RUNTIME_ERROR", "權重計畫有重複的權重組 id")

    def to_dict(self) -> dict[str, Any]:
        return {"root": self.root, "sets": [item.to_dict() for item in self.sets], "notes": list(self.notes)}

    @classmethod
    def from_dict(cls, doc: Mapping[str, Any]) -> WeightPlan:
        root = doc.get("root")
        return cls(
            root=str(root) if root else None,
            sets=tuple(WeightSet.from_dict(item) for item in doc.get("sets") or []),
            notes=tuple(str(note) for note in doc.get("notes") or []),
        )


@dataclass(frozen=True)
class WeightManifest:
    """runtime 隨附的固定版本清單：一個 repo commit 的檔案（路徑、大小、雜湊），由 Hugging Face 的檔案樹 API 產生。"""

    repo: str
    revision: str
    files: tuple[WeightFile, ...]

    def select(self, prefix: str = "", *, include: Sequence[str] = ()) -> tuple[WeightFile, ...]:
        """以 prefix 開頭（"" ＝全部）或列在 include 的檔案，順序不變。"""
        chosen = set(include)
        return tuple(
            item
            for item in self.files
            if item.path in chosen or (prefix and item.path.startswith(prefix)) or (not prefix and not include)
        )


def load_manifest(path: Path) -> WeightManifest:
    """讀 runtime 隨附的清單 JSON（``{repo, revision, files: [{path, size, sha256, git_oid}]}``）。"""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ComponentError("RUNTIME_ERROR", f"無法讀取權重清單 {path.name}：{type(exc).__name__}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("files"), list):
        raise ComponentError("RUNTIME_ERROR", f"權重清單 {path.name} 格式不對")
    return WeightManifest(
        repo=str(doc["repo"]),
        revision=str(doc["revision"]),
        files=tuple(WeightFile.from_dict(item) for item in doc["files"]),
    )


def identical_links(
    own: Sequence[WeightFile], own_prefix: str, other_prefix: str, others: Sequence[WeightFile]
) -> dict[str, tuple[str, ...]]:
    """own 裡每個檔案在 others 中「同一個子路徑、內容相同」的對應檔（例如 FL2VA/x ↔ Ref2VA/x）。

    回傳的 key 是 own 的 path，值是 others 那一份的 path；兩邊的 path 都相對於同一個目的地。"""
    by_path = {item.path: item for item in others}
    links: dict[str, tuple[str, ...]] = {}
    for item in own:
        if not item.path.startswith(own_prefix):
            continue
        twin = by_path.get(other_prefix + item.path[len(own_prefix) :])
        if twin is not None and twin.identity == item.identity:
            links[item.path] = (twin.path,)
    return links


# ---------------------------------------------------------------------------------------------- 驗證


class Digest(Protocol):
    def update(self, data: bytes, /) -> None: ...

    def hexdigest(self) -> str: ...


def new_digest(item: WeightFile) -> Digest:
    """這個檔案用來驗證的雜湊（SHA-256；只有 git_oid 時是 git blob SHA-1：``sha1("blob <size>\\0" + 內容)``）。"""
    if item.sha256:
        return hashlib.sha256()
    digest = hashlib.sha1(usedforsecurity=False)
    digest.update(b"blob %d\x00" % item.size)
    return digest


def expected_digest(item: WeightFile) -> str:
    return item.sha256 or item.git_oid or ""


def file_matches(path: Path, item: WeightFile, *, chunk: int = 8 * 1024 * 1024) -> bool:
    """整個檔案重新計算雜湊並與清單比對（大小不同直接 False）；讀不到 → False。"""
    try:
        if path.stat().st_size != item.size:
            return False
        digest = new_digest(item)
        with path.open("rb") as fh:
            while block := fh.read(chunk):
                digest.update(block)
    except OSError:
        return False
    return digest.hexdigest() == expected_digest(item)


__all__ = [
    "Digest",
    "WeightFile",
    "WeightLicense",
    "WeightManifest",
    "WeightPlan",
    "WeightSet",
    "expected_digest",
    "file_matches",
    "identical_links",
    "load_manifest",
    "new_digest",
    "safe_relative",
]
