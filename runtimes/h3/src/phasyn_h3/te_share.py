"""h3.conditioning：不同 task variant 共用同一份已載入的文字編碼器（Qwen3-VL TE）——只在能證明相同時（torch-free）。

背景：一個 variant=fl2va、shared_from=ref2va 的 TE 元件 load 時預載 t2va／fl2va 用的 TE
（``h3-fl2va-local-text_encoder``）；第一次 ref2va 呼叫改用另一份 model manifest（model_id ``h3-ref2va-local``）建 plan，
registry 的 single_flight_key 不同，於是從 hard link 的同一批檔再載入一份 ``h3-ref2va-local-text_encoder``
（約 51.5 GB 權重多載入一次並常駐，在統一記憶體 GPU 上直接吃掉一半以上的記憶體）。

這裡只決定「另一個 variant 的 job 用哪份 model manifest」：

* 證明成立 → 沿用此元件自己的 model 身分（同 model_id、同目錄；與 VAE 元件的 ``_vae_model`` 同一做法）。stage 解析出的
  ``ComponentLoadSpec`` 與已載入的那份相同，registry 直接取用，不再載入。
* 證明不成立或無法判斷 → 照舊用另一份 manifest（各自一份），原因寫進 load／invoke 紀錄。

證明（全部成立才共用）：

1. 身分：共用 manifest 的 model_id、source_revision，以及 text_encoder／tokenizer／processor 的 component_id、
   relative_path、format 與已載入的 manifest 相同（不同的話 registry 本來就會另載一份）。
2. 設定：兩個 variant 的 TE 設定指紋相同（compute_dtype、weight_format、量化、offload、after_use、encoder_max_tokens、
   mode、attention；tap 固定 ``hidden_states[50]``，不是設定）。
3. model_index.json：兩邊 variant 目錄宣告的 ``_class_name`` 與三個元件的 ``[library, class]`` 相同（recipe loader
   只讀 ``index[kind]`` 選類別；``_minimax_h3`` 的 partition／tasks 只有完整 SGLang pipeline 讀，元件 loader 不建 pipeline）。
4. 檔案：三個目錄的檔案清單（相對路徑）相同，而且逐檔相同——同一個 ``(st_dev, st_ino)``（同路徑或 hard link），
   或大小相同且 SHA-256 相同（config.json 等小檔每次直接算；權重 shard 等大檔的 digest 依檔案身分快取，見 ``DigestCache``）。

數值：另一個 variant 的 encode_conditioning 用同一個 module（同權重、同類別、同 dtype、同 attention backend）跑同一段
``encode_ids``；recipe 一行都不改。
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.canonical import digest as canonical_digest
from phasyn_components.errors import exception_message
from phasyn_components.model_identity import location

SHARED_KINDS = ("text_encoder", "tokenizer", "processor")
# recipe encode_conditioning 固定：blocks 0..49、final norm Identity、hidden_states[50]（minimax_h3_qwen3vl.py:328-392）
TAP = "hidden_states[50]"
MODEL_INDEX = "model_index.json"
# 小檔每次直接算 SHA-256；大於此值（權重 shard）才寫入 digest 快取
HASH_CACHE_MIN_BYTES = 16 * 1024 * 1024
_IDENTITY_FIELDS = ("component_id", "relative_path", "format")
_BLOCK = 8 << 20
_LIST_LIMIT = 3


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(_BLOCK), b""):
            h.update(block)
    return h.hexdigest()


class DigestCache:
    """檔案 SHA-256；大檔以檔案身分（解析後路徑、st_dev、st_ino、大小、mtime_ns、ctime_ns）為 key 快取在 ``cache_dir``。

    比 transformer_file 的 path:size:mtime 快取多看 inode 與 ctime：覆寫內容（就算把 mtime 改回去）會改 ctime，快取失效重算
    （檔案系統時間戳粒度內的連續寫入除外）。算的過程中檔案變了就不寫快取。同一 inode 的比對不需要 digest（見 ``compare_dirs``）。
    """

    def __init__(self, cache_dir: Path | None, *, min_bytes: int = HASH_CACHE_MIN_BYTES) -> None:
        self.cache_dir = cache_dir
        self.min_bytes = min_bytes
        self.computed_files = 0
        self.computed_bytes = 0
        self.cache_hits = 0

    def _cache_path(self, path: Path) -> Path | None:
        if self.cache_dir is None:
            return None
        st = path.stat()
        if st.st_size < self.min_bytes:
            return None
        identity = f"{path.resolve()}:{st.st_dev}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}"
        return self.cache_dir / f"te-share-sha256-{hashlib.sha256(identity.encode()).hexdigest()[:32]}.txt"

    def __call__(self, path: Path) -> str:
        cached = self._cache_path(path)
        if cached is not None and cached.is_file():
            value = cached.read_text(encoding="utf-8").strip()
            if len(value) == 64 and all(c in "0123456789abcdef" for c in value):
                self.cache_hits += 1
                return value
        value = file_sha256(path)
        self.computed_files += 1
        self.computed_bytes += path.stat().st_size
        if cached is not None and self._cache_path(path) == cached:
            cached.parent.mkdir(parents=True, exist_ok=True)
            partial = cached.with_name(f"{cached.name}.{os.getpid()}.part")
            partial.write_text(value, encoding="utf-8")
            os.replace(partial, cached)
        return value

    def facts(self) -> dict[str, int]:
        return {
            "computed_files": self.computed_files,
            "computed_bytes": self.computed_bytes,
            "cache_hits": self.cache_hits,
        }


@dataclass(frozen=True)
class DirProof:
    """一個元件目錄（已載入的那份 vs 另一份 manifest 會載入的那份）的逐檔比對結果。"""

    kind: str
    loaded: str
    other: str
    identical: bool
    method: str | None  # same_path | inode | sha256 | inode+sha256（identical 時）
    files: int = 0
    bytes: int = 0
    inode_files: int = 0
    sha256_files: int = 0
    sha256_bytes: int = 0
    reason: str | None = None

    def fact(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "loaded": self.loaded,
            "other": self.other,
            "identical": self.identical,
            "method": self.method,
            "files": self.files,
            "bytes": self.bytes,
            "inode_files": self.inode_files,
            "sha256_files": self.sha256_files,
            "sha256_bytes": self.sha256_bytes,
            "reason": self.reason,
        }


def _list_files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


def _few(items: Sequence[str]) -> str:
    shown = "、".join(items[:_LIST_LIMIT])
    return shown + (f" 等 {len(items)} 個" if len(items) > _LIST_LIMIT else "")


def _shown(path: Path, root: Path | None) -> str:
    """A path for records and messages: relative to the model root when inside it, else only its name (never absolute)."""
    place = location(path, root)
    return place.get("path") or place["name"]


def compare_dirs(
    kind: str, loaded: Path, other: Path, *, digest: Callable[[Path], str], root: Path | None = None
) -> DirProof:
    """逐檔證明兩個目錄相同：檔案清單相同，且每個檔同 (st_dev, st_ino)，或同大小且同 SHA-256。

    ``root`` (the model root): the proof names the directories relative to it, never by absolute path.
    """

    def differ(reason: str, files: int = 0) -> DirProof:
        return DirProof(
            kind, _shown(loaded, root), _shown(other, root), identical=False, method=None, files=files, reason=reason
        )

    for path in (loaded, other):
        if not path.is_dir():
            return differ(f"{_shown(path, root)} 不是目錄（無法逐檔比對）")
    names = _list_files(loaded)
    other_names = _list_files(other)
    if names != other_names:
        only_loaded = sorted(set(names) - set(other_names))
        only_other = sorted(set(other_names) - set(names))
        detail = "；".join(
            part
            for part in (
                f"只在已載入那份：{_few(only_loaded)}" if only_loaded else "",
                f"只在另一份：{_few(only_other)}" if only_other else "",
            )
            if part
        )
        return differ(f"檔案清單不同（{detail}）")
    if not names:
        return differ("目錄裡沒有檔案（沒有可證明相同的內容）")
    same_path = loaded.resolve() == other.resolve()
    total = inode_files = sha_files = sha_bytes = 0
    for name in names:
        a, b = loaded / name, other / name
        sa, sb = a.stat(), b.stat()
        total += sa.st_size
        if (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino):
            inode_files += 1
            continue
        if sa.st_size != sb.st_size:
            return differ(f"{name} 大小不同（{sa.st_size:,} B ≠ {sb.st_size:,} B）", len(names))
        if digest(a) != digest(b):
            return differ(f"{name} 內容不同（SHA-256）", len(names))
        sha_files += 1
        sha_bytes += sa.st_size
    if same_path:
        method = "same_path"
    elif sha_files == 0:
        method = "inode"
    elif inode_files == 0:
        method = "sha256"
    else:
        method = "inode+sha256"
    return DirProof(
        kind,
        _shown(loaded, root),
        _shown(other, root),
        identical=True,
        method=method,
        files=len(names),
        bytes=total,
        inode_files=inode_files,
        sha256_files=sha_files,
        sha256_bytes=sha_bytes,
    )


def _components(model: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {str(c.get("kind")): c for c in model.get("components") or [] if isinstance(c, Mapping)}


def manifest_identity(model: Mapping[str, Any], kinds: Sequence[str] = SHARED_KINDS) -> dict[str, Any]:
    """registry key 會用到的 manifest 身分（model_id／source_revision＋各元件 component_id／relative_path／format）。"""
    comps = _components(model)
    return {
        "model_id": model.get("model_id"),
        "source_revision": model.get("source_revision"),
        **{kind: {f: (comps.get(kind) or {}).get(f) for f in _IDENTITY_FIELDS} for kind in kinds},
    }


def settings_fingerprint(profile: Mapping[str, Any]) -> dict[str, Any]:
    """TE 載入與 forward 會用到的設定（同一份 profile → 同一個 ComponentPolicy／ServerArgs knobs）。"""
    components = profile.get("components") or {}
    residency = None
    for ext in profile.get("extensions") or []:
        if isinstance(ext, Mapping) and ext.get("namespace") == "phasyn.sglang_h3.residency":
            residency = (ext.get("values") or {}).get("text_encoder")
    return {
        "text_encoder": components.get("text_encoder"),
        "residency": residency,
        "encoder_max_tokens": (profile.get("limits") or {}).get("encoder_max_tokens"),
        "mode": profile.get("mode"),
        "attention": profile.get("attention"),
        "tap": TAP,
    }


def _read_index(path: Path, root: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    shown = _shown(path, root)
    if not path.is_file():
        return None, f"{shown} 不存在（loader 會改用釘版參考 model_index；這裡不推論）"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"{shown} 無法讀取：{type(exc).__name__}: {exception_message(exc)}"
    if not isinstance(doc, dict):
        return None, f"{shown} 不是 JSON object"
    return doc, None


def compare_model_index(
    loaded_dir: Path, other_dir: Path, kinds: Sequence[str] = SHARED_KINDS, *, root: Path | None = None
) -> dict[str, Any]:
    """兩個 variant 目錄的 model_index.json：``_class_name`` 與各元件的 [library, class] 是否相同。

    ``root`` (the model root): files are named relative to it, never by absolute path.
    """
    keys = ("_class_name", *kinds)
    out: dict[str, Any] = {
        "loaded": _shown(loaded_dir / MODEL_INDEX, root),
        "other": _shown(other_dir / MODEL_INDEX, root),
    }
    if loaded_dir.resolve() == other_dir.resolve():
        doc, problem = _read_index(loaded_dir / MODEL_INDEX, root)
        if doc is None:
            return {**out, "identical": False, "reason": problem}
        return {**out, "identical": True, "method": "same_file", "entries": {k: doc.get(k) for k in keys}}
    loaded_doc, problem = _read_index(loaded_dir / MODEL_INDEX, root)
    other_doc, other_problem = _read_index(other_dir / MODEL_INDEX, root)
    if loaded_doc is None or other_doc is None:
        return {**out, "identical": False, "reason": problem or other_problem}
    differ = [k for k in keys if loaded_doc.get(k) != other_doc.get(k)]
    if differ:
        return {
            **out,
            "identical": False,
            "reason": f"model_index.json 的 {'、'.join(differ)} 不同",
            "entries": {k: [loaded_doc.get(k), other_doc.get(k)] for k in differ},
        }
    return {**out, "identical": True, "method": "entries", "entries": {k: loaded_doc.get(k) for k in keys}}


@dataclass(frozen=True)
class ShareDecision:
    """另一個 variant（``variant``）的 job 能不能用此元件已載入的 TE（``own_variant`` 的 manifest 身分）。"""

    variant: str
    own_variant: str
    applied: bool
    reason: str
    proofs: tuple[DirProof, ...] = ()
    model_index: Mapping[str, Any] = field(default_factory=dict)
    settings: Mapping[str, Any] = field(default_factory=dict)
    manifests: Mapping[str, Any] = field(default_factory=dict)
    hashing: Mapping[str, int] = field(default_factory=dict)
    seconds: float = 0.0

    def methods(self) -> dict[str, str | None]:
        return {p.kind: p.method for p in self.proofs}

    def fact(self) -> dict[str, Any]:
        return {
            "variant": self.variant,
            "own_variant": self.own_variant,
            "applied": self.applied,
            "reason": self.reason,
            "proof": {p.kind: p.fact() for p in self.proofs},
            "model_index": dict(self.model_index),
            "settings": dict(self.settings),
            "manifests": dict(self.manifests),
            "hashing": dict(self.hashing),
            "seconds": round(self.seconds, 6),
        }

    def summary(self) -> dict[str, Any]:
        """invoke 紀錄用的精簡版（完整證明在 load 紀錄的 observed.text_encoder_sharing）。"""
        return {
            "applied": self.applied,
            "reason": self.reason,
            "methods": self.methods(),
            "model_index": self.model_index.get("identical"),
            "settings": self.settings.get("identical"),
        }


def _component_dir(model_root: Path, model: Mapping[str, Any], kind: str) -> Path | None:
    entry = _components(model).get(kind)
    if not entry or not entry.get("relative_path"):
        return None
    return model_root / str(entry["relative_path"])


def decide(
    *,
    variant: str,
    own_variant: str,
    loaded: Mapping[str, Any],
    shared: Mapping[str, Any],
    separate: Mapping[str, Any],
    model_root: Path,
    loaded_settings: Mapping[str, Any],
    variant_settings: Mapping[str, Any],
    digest: Callable[[Path], str],
    kinds: Sequence[str] = SHARED_KINDS,
    clock: Callable[[], float] = time.perf_counter,
) -> ShareDecision:
    """``loaded``：此元件載入（或會載入）的 manifest；``shared``：沿用其身分、給 ``variant`` 的 manifest；
    ``separate``：不共用時（以前的做法）``variant`` 的 manifest。證明全部成立才 applied=True，任何錯誤都不共用。"""
    started = clock()
    manifests = {
        "loaded": manifest_identity(loaded, kinds),
        "shared": manifest_identity(shared, kinds),
        "separate": manifest_identity(separate, kinds),
    }
    loaded_fp = canonical_digest(dict(loaded_settings))
    variant_fp = canonical_digest(dict(variant_settings))
    settings: dict[str, Any] = {
        "identical": loaded_fp == variant_fp,
        "fingerprint_digest": {own_variant: loaded_fp, variant: variant_fp},
        "fingerprint": dict(loaded_settings),
    }
    if loaded_fp != variant_fp:
        settings["variant_fingerprint"] = dict(variant_settings)
    hashing = getattr(digest, "facts", None)

    def done(
        applied: bool, reason: str, proofs: Sequence[DirProof] = (), index: Mapping[str, Any] | None = None
    ) -> ShareDecision:
        return ShareDecision(
            variant=variant,
            own_variant=own_variant,
            applied=applied,
            reason=reason,
            proofs=tuple(proofs),
            model_index=dict(index or {}),
            settings=settings,
            manifests=manifests,
            hashing=dict(hashing()) if callable(hashing) else {},
            seconds=clock() - started,
        )

    if variant == own_variant:
        return done(True, "同一個 variant：用此元件自己載入的 TE")
    if manifests["shared"] != manifests["loaded"]:
        return done(
            False, "共用用的 manifest 身分與已載入的不同（model_id／revision／component_id／路徑），registry 會另載一份"
        )
    if not settings["identical"]:
        changed = sorted(k for k in loaded_settings if loaded_settings.get(k) != variant_settings.get(k))
        return done(False, f"兩個 variant 的 TE 設定不同（{'、'.join(changed) or 'fingerprint'}）")
    dirs: dict[str, tuple[Path, Path]] = {}
    for kind in kinds:
        own_dir = _component_dir(model_root, loaded, kind)
        other_dir = _component_dir(model_root, separate, kind)
        if own_dir is None or other_dir is None:
            return done(False, f"manifest 缺少 {kind} 的 relative_path，無法比對")
        dirs[kind] = (own_dir, other_dir)
    # loader 以元件目錄的上一層（variant 目錄）的 model_index.json 選類別；三個元件不在同一層就不推論
    parents = {(own.parent, other.parent) for own, other in dirs.values()}
    if len(parents) != 1:
        return done(False, f"{'／'.join(kinds)} 不在同一個 variant 目錄，model_index 無法一次比對（不推論）")
    proofs: list[DirProof] = []
    try:
        ((loaded_parent, other_parent),) = parents
        index = compare_model_index(loaded_parent, other_parent, kinds, root=model_root)
        if not index["identical"]:
            return done(False, f"model_index.json 不同：{index.get('reason')}", proofs, index)
        for kind in kinds:
            proof = compare_dirs(kind, *dirs[kind], digest=digest, root=model_root)
            proofs.append(proof)
            if not proof.identical:
                return done(False, f"{kind} 不同：{proof.reason}", proofs, index)
    except OSError as exc:  # 讀不到就不共用（照舊各載一份），不猜
        return done(False, f"無法比對檔案：{type(exc).__name__}: {exception_message(exc)}"[:500], proofs)
    methods = "、".join(f"{p.kind} {p.method}" for p in proofs)
    return done(
        True,
        f"{'／'.join(kinds)} 逐檔相同（{methods}），model_index 與 TE 設定相同：{variant} 沿用已載入的那一份",
        proofs,
        index,
    )


__all__ = [
    "HASH_CACHE_MIN_BYTES",
    "SHARED_KINDS",
    "TAP",
    "DigestCache",
    "DirProof",
    "ShareDecision",
    "compare_dirs",
    "compare_model_index",
    "decide",
    "file_sha256",
    "manifest_identity",
    "settings_fingerprint",
]
