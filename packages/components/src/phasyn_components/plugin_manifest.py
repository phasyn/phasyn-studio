"""Studio plugin manifests (contract ``StudioPluginManifest``).

A manifest is the ``plugin.json`` of a plugin package and is untrusted data. This module owns everything that needs
no file system: the limits, the strict JSON reading, the rules a schema cannot express, compatibility with this
host, and the references and content revisions of a package's contributions.

Nothing here executes or imports anything from a package: rules are data that the browser
evaluate, and this version declares that it runs no plugin code at all (:data:`PLUGIN_APIS` is empty).

Every problem is a ``StudioPluginIssue``: a stable lower-case ``code``, a fixed Traditional Chinese ``message``
(:data:`MESSAGES`; translated by the interface), a ``path`` inside the package or the manifest and small ``details``.
An issue never carries a path of this host.
"""

from __future__ import annotations

import codecs
import json
import re
import unicodedata
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from . import contracts
from .canonical import canonical_json, sha256_hex
from .errors import ComponentError

KIB = 1024
MIB = 1024 * KIB

MANIFEST_NAME = "plugin.json"
MAIN_NAME = "main.js"
MANIFEST_SCHEMA = "StudioPluginManifest"
MANIFEST_VERSION = 1
BUILTIN_PREFIX = "phasyn."
INVALID_CODE = "STUDIO_PLUGIN_INVALID"
MAX_ISSUES = 20
REV_LENGTH = 12

# Sandbox API major versions this host can run. Empty: this version executes no plugin code, so a package with a
# ``main`` installs and can be inspected but stays incompatible.
PLUGIN_APIS: tuple[int, ...] = ()

# The permission vocabulary. Permissions gate what a package's code may ask the host to do; they
# are defined now and enforced where code execution is added. They never restrict a person or an API client.
PERMISSIONS = frozenset(
    {
        "project:read",
        "project:write",
        "timeline:write",
        "media:read",
        "media:write",
        "render:start",
        "export:start",
        "engine:read",
        "storage",
    }
)
RESERVED_PERMISSIONS = frozenset({"ui:html"})
RESERVED_PERMISSION_PREFIXES = ("network:",)

FILE_EXTENSIONS = (".json", ".js", ".md", ".txt", ".png", ".jpg", ".webp", ".cube")
# Files without an extension that a package may carry at its root.
PLAIN_FILE_NAMES = ("LICENSE",)

Issue = dict[str, Any]


@dataclass(frozen=True)
class PluginLimits:
    """Bounds of a plugin package and of what a project may take from plugins (contract ``StudioPluginLimits``)."""

    package_bytes: int = 16 * MIB  # the uploaded archive (the Controller's plugins.max_package_bytes)
    files: int = 256  # archive entries, plugin.json and directories included
    file_bytes: int = 8 * MIB
    unpacked_bytes: int = 64 * MIB
    manifest_bytes: int = 128 * KIB
    main_bytes: int = 2 * MIB
    compression_ratio: int = 100
    path_depth: int = 4
    path_length: int = 200
    packages: int = 64  # packages installed through the API
    total_bytes: int = 512 * MIB  # unpacked size of all of them
    project_plugins: int = 8
    inject_chars: int = 2000
    project_inject_bytes: int = 8 * KIB
    # Not part of the contract: the archive's central directory is read into memory before any entry is checked.
    central_directory_bytes: int = MIB

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_package_bytes": self.package_bytes,
            "max_files": self.files,
            "max_file_bytes": self.file_bytes,
            "max_unpacked_bytes": self.unpacked_bytes,
            "max_manifest_bytes": self.manifest_bytes,
            "max_main_bytes": self.main_bytes,
            "max_compression_ratio": self.compression_ratio,
            "max_path_depth": self.path_depth,
            "max_path_length": self.path_length,
            "max_packages": self.packages,
            "max_total_bytes": self.total_bytes,
            "max_project_plugins": self.project_plugins,
            "max_inject_chars": self.inject_chars,
            "max_project_inject_bytes": self.project_inject_bytes,
            "file_extensions": list(FILE_EXTENSIONS),
        }


LIMITS = PluginLimits()

# code -> the fixed text of that problem. The interface shows its own wording per code and falls back to this text.
MESSAGES: Mapping[str, str] = {
    # -- the archive
    "archive_unreadable": "不是有效的 zip 壓縮檔，或內容已損壞",
    "archive_layout": "不支援的壓縮檔結構：不可以有註解、分片、zip64 或檔頭前的多餘資料，項目不可以重疊或指到壓縮檔之外",
    "too_many_files": "檔案數量超過上限",
    "path_not_allowed": "路徑不合規：只能是相對路徑，每段使用英數字、點、底線與連字號且不以點開頭，最多四層",
    "duplicate_path": "路徑重複（不分大小寫），或同一個名稱同時是檔案與目錄",
    "link_not_allowed": "不接受符號連結、多重連結或特殊檔案",
    "encrypted": "不接受加密的項目",
    "compression_not_allowed": "只接受未壓縮（stored）或 deflate 的項目",
    "extension_not_allowed": "不接受這種檔案：副檔名不在允許的清單內",
    "file_too_large": "檔案超過大小上限",
    "total_too_large": "解壓後的合計大小超過上限",
    "ratio_too_high": "壓縮比超過上限",
    "size_mismatch": "實際大小與宣告的大小不同",
    "content_mismatch": "檔案內容與副檔名不符：圖片的檔頭不對，或文字檔不是 UTF-8",
    "file_unreadable": "檔案無法讀取",
    # -- the manifest
    "manifest_missing": "包的根目錄沒有 plugin.json",
    "manifest_not_json": "plugin.json 不是有效的 UTF-8 JSON，或有重複的鍵",
    "manifest_invalid": "plugin.json 不符合 manifest 契約",
    "reserved_id": "phasyn. 開頭的 id 保留給內建插件",
    "builtin_id": "內建插件的 id 必須以 phasyn. 開頭，並與它的目錄同名",
    "regex_not_allowed": "只有內建插件可以使用正規表示式（pattern、any_of）；請改用詞組清單（terms、any_terms）",
    "regex_invalid": "正規表示式無法編譯",
    "duplicate_id": "同一個包內的 id 重複",
    "main_required": "commands、panels、permissions 與 engines.plugin_api 需要程式碼入口 main",
    "plugin_api_required": "有 main 的包必須宣告 engines.plugin_api",
    "engines_range_empty": "engines.phasyn 的範圍是空的：下限必須小於上限",
    "frames_invalid": "影格數必須是 17n+5",
    "text_invalid": "文字含有控制字元、看不見的格式字元或無法編碼的字元",
    # -- the manifest against the files
    "main_mismatch": "manifest 的 main 與包內的 main.js 必須同時存在",
    "integrity_files_mismatch": "integrity.files 必須正好列出 plugin.json 以外的每個檔案",
    "integrity_mismatch": "檔案的 SHA-256 與 integrity.files 不同",
    "digest_mismatch": "包的內容與安裝時記錄的 digest 不同",
    # -- compatibility with this host
    "host_version": "這個版本的 Phasyn Studio 不在插件宣告的相容範圍內",
    "code_unsupported": "這個版本還不能執行插件程式碼",
    "permission_unknown": "插件要求了這個版本不認得的權限",
    "permission_reserved": "插件要求了保留、不開放的權限",
    "preset_rule_missing": "推薦組合引用了找不到的規則",
    # -- the registry and removal
    "dev_dir_invalid": "設定檔 plugins.dev_dirs 的目錄無法載入",
    "dev_dir_conflict": "開發目錄的插件 id 與另一個已載入的插件相同",
    "registry_unreadable": "安裝紀錄遺失、讀不到或格式不對：已安裝的插件沒有載入，修復之前不能安裝、移除或停用",
    "builtin": "內建插件不能移除",
    "dev": "開發目錄的插件由設定檔管理，不能經 API 移除",
    "install_disabled": "設定檔關閉了經 API 安裝與移除插件",
}

PLUGIN_ID_MAX = 96
_PLUGIN_ID = re.compile(r"[a-z0-9]+(\.[a-z0-9-]+)+")
_LOCAL_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_CORE = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)")
_RANGE = re.compile(r">=([0-9]+)\.([0-9]+)\.([0-9]+) <([0-9]+)\.([0-9]+)\.([0-9]+)")
# Characters no manifest string may contain, by Unicode general category: controls other than tab, line feed and
# carriage return (Cc), format characters (Cf: zero-width and direction marks, the byte order mark, tag characters),
# surrogates (Cs), private-use characters (Co) and the line and paragraph separators (Zl, Zp). Two reasons. A text
# is what its reader sees: nothing invisible rides along into a prompt. And everything about which JavaScript and
# Python disagree when they trim a text or look for the end of a line is in this set, so both evaluators handle
# rule texts alike.
_HIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
_TEXT_CONTROLS = frozenset("\t\n\r")
# Characters of other categories that draw nothing either: the code points Unicode marks as ignorable by default
# (DerivedCoreProperties, Default_Ignorable_Code_Point: the combining grapheme joiner, the Hangul fillers, the Khmer
# inherent vowels, the Mongolian and the general variation selectors, reserved ranges) and the blank Braille pattern.
_INVISIBLE_RANGES = (
    (0x034F, 0x034F),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x2800, 0x2800),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)
_ASCII_HIDDEN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# How the evaluators read a built-in pattern: JavaScript ``new RegExp(pattern, "i")`` (no "u" flag), which for a
# pattern of ASCII characters is Python's ASCII word classes and ASCII case folding.
PATTERN_FLAGS = re.IGNORECASE | re.ASCII
# Characters outside ASCII that a built-in pattern may contain: CJK punctuation, kana, CJK ideographs and Hangul
# syllables have no case and are one UTF-16 code unit each, so both evaluators match them only as themselves (a
# Chinese or Japanese prompt is checked in its own words).
_CASELESS_BLOCKS = (
    (0x3001, 0x303F),
    (0x3040, 0x30FF),
    (0x31F0, 0x31FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xAC00, 0xD7AF),
    (0xF900, 0xFAFF),
)
_ESCAPE = re.compile(r"\\(.)", re.DOTALL)
_GROUP = re.compile(r"\(\?(.)", re.DOTALL)
# Rules and generation settings share one id namespace: a project selects both through StudioPluginRef.
_SELECTABLE = ("rules", "generation")
_SEPARATE = ("presets", "commands", "panels")


def issue(code: str, *, path: str | None = None, **details: Any) -> Issue:
    """One ``StudioPluginIssue``; ``code`` must be a key of :data:`MESSAGES`."""
    return {"code": code, "message": MESSAGES[code], "path": path, "details": details}


def invalid(issues: Sequence[Issue]) -> ComponentError:
    """The refusal of a package: 422 ``STUDIO_PLUGIN_INVALID`` with at most :data:`MAX_ISSUES` issues
    (``details.truncated`` says whether there were more)."""
    shown = [dict(item) for item in issues[:MAX_ISSUES]]
    first = shown[0]
    where = f"（{first['path']}）" if first["path"] else ""
    return ComponentError(
        INVALID_CODE,
        f"插件包不合規：{first['message']}{where}",
        details={"errors": shown, "truncated": len(issues) > MAX_ISSUES},
    )


def issues_of(error: ComponentError) -> list[Issue]:
    """The issues a :func:`invalid` refusal carries; any other error reads as one ``file_unreadable`` issue."""
    found = error.details.get("errors") if error.code == INVALID_CODE else None
    if isinstance(found, list):
        return [dict(item) for item in found]
    return [issue("file_unreadable", reason=error.code)]


def is_plugin_id(value: object) -> bool:
    """Contract ``StudioPluginId``. An id is also a directory name and a URL segment, hence ``fullmatch``."""
    return isinstance(value, str) and len(value) <= PLUGIN_ID_MAX and bool(_PLUGIN_ID.fullmatch(value))


def is_plugin_ref(value: object) -> bool:
    """Contract ``StudioPluginRef``: a bare built-in contribution id, or ``<plugin_id>/<contribution id>``."""
    if not isinstance(value, str):
        return False
    if "/" not in value:
        return bool(_LOCAL_ID.fullmatch(value))
    owner, _, local = value.rpartition("/")
    return is_plugin_id(owner) and bool(_LOCAL_ID.fullmatch(local))


# ---------------------------------------------------------------------------------------------- reading
def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def _reject_constant(name: str) -> Any:
    raise ValueError(name)


def _read_json(data: bytes) -> Any:
    """Strict JSON: UTF-8 without a byte order mark, no NaN or Infinity, no duplicate keys, bounded nesting."""
    if data.startswith(codecs.BOM_UTF8):
        raise invalid([issue("manifest_not_json", path=MANIFEST_NAME, reason="byte order mark")])
    try:
        return json.loads(data.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=_unique_keys)
    except (ValueError, RecursionError) as exc:  # UnicodeDecodeError is a ValueError
        raise invalid([issue("manifest_not_json", path=MANIFEST_NAME, reason=type(exc).__name__)]) from exc


def _shown(text: str) -> str:
    """Text of a manifest that has not passed the text rule yet, as an issue may carry it: a key can hold anything
    JSON can escape, including what cannot be encoded again."""
    return "".join(char if char.isprintable() else "?" for char in text)


def _schema_issues(doc: Any) -> list[Issue]:
    """What breaks the contract: the first problems in validation order, one more than a refusal shows."""
    found = []
    for text in contracts.first_errors(MANIFEST_SCHEMA, doc, limit=MAX_ISSUES + 1):
        where, _, reason = _shown(text).partition(": ")
        found.append(issue("manifest_invalid", path=None if where == "(root)" else where, reason=reason))
    return found


def _strings(node: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """``(path, text)`` for every string in the document, keys included."""
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}/{key}" if path else str(key)
            yield child, str(key)
            yield from _strings(value, child)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _strings(value, f"{path}/{index}")


def _has_hidden_character(text: str) -> bool:
    if text.isascii():
        return _ASCII_HIDDEN.search(text) is not None
    return any(_hidden(char) for char in text)


def _hidden(char: str) -> bool:
    if char in _TEXT_CONTROLS:
        return False
    if unicodedata.category(char) in _HIDDEN_CATEGORIES:
        return True
    point = ord(char)
    return point >= 0x034F and any(low <= point <= high for low, high in _INVISIBLE_RANGES)


def _text_issues(manifest: Mapping[str, Any]) -> list[Issue]:
    paths = dict.fromkeys(path for path, text in _strings(manifest) if _has_hidden_character(text))
    return [issue("text_invalid", path=path) for path in paths]


def parse_manifest(data: bytes, *, builtin: bool) -> dict[str, Any]:
    """The validated manifest of a package (``builtin``: it ships with the host instead of arriving as data).

    Raises 422 ``STUDIO_PLUGIN_INVALID``: not strict JSON, not the contract, or one of the rules a schema cannot
    express (:func:`semantic_issues`).
    """
    doc = _read_json(data)
    problems = _schema_issues(doc)
    if problems:
        raise invalid(problems)
    manifest: dict[str, Any] = doc
    problems = [*_text_issues(manifest), *semantic_issues(manifest, builtin=builtin)]
    if problems:
        raise invalid(problems)
    return manifest


# ---------------------------------------------------------------------------------------------- semantic rules
def _core(text: str) -> tuple[int, int, int] | None:
    """The release number a version starts with (pre-release and local parts are not compared)."""
    match = _CORE.match(text)
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def engine_range(manifest: Mapping[str, Any]) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """``engines.phasyn`` as ``(lowest, first excluded)`` release numbers."""
    match = _RANGE.fullmatch(str(manifest["engines"]["phasyn"]))
    if match is None:  # the contract's pattern guarantees the form
        raise ValueError("engines.phasyn is not a range")
    numbers = [int(part) for part in match.groups()]
    return (numbers[0], numbers[1], numbers[2]), (numbers[3], numbers[4], numbers[5])


def _duplicates(ids: Iterable[tuple[str, str]]) -> list[Issue]:
    """One ``duplicate_id`` issue per ``(path, id)`` whose id was already seen."""
    seen: set[str] = set()
    found = []
    for path, value in ids:
        if value in seen:
            found.append(issue("duplicate_id", path=path, id=value))
        seen.add(value)
    return found


def _contribution_ids(contributes: Mapping[str, Any], kinds: Sequence[str]) -> Iterator[tuple[str, str]]:
    for kind in kinds:
        for index, item in enumerate(contributes.get(kind) or []):
            yield f"contributes/{kind}/{index}/id", str(item["id"])


def _portable_char(char: str) -> bool:
    return char.isascii() or any(low <= ord(char) <= high for low, high in _CASELESS_BLOCKS)


def _portable_pattern(source: str) -> bool:
    """Whether a built-in pattern stays in what JavaScript and Python read alike: ASCII and the caseless CJK blocks
    only (outside them the two fold case differently), no class escape other than ``\\b \\B \\d \\D \\w \\W``
    (``\\s`` differs), and no group syntax other than ``(?:``, ``(?=`` and ``(?!``."""
    escapes = _ESCAPE.findall(source)
    groups = _GROUP.findall(source.replace("\\\\", "").replace("\\(", ""))
    return (
        all(_portable_char(char) for char in source)
        and all(char in "bBdDwW" or not char.isalnum() for char in escapes)
        and all(char in ":=!" for char in groups)
    )


def _regex_issues(path: str, key: str, source: str, *, builtin: bool) -> list[Issue]:
    if not builtin:
        return [issue("regex_not_allowed", path=f"{path}/{key}")]
    if not _portable_pattern(source):
        return [issue("regex_invalid", path=f"{path}/{key}", reason="outside the JavaScript and Python subset")]
    try:
        re.compile(source, PATTERN_FLAGS)
    except (re.error, RecursionError, OverflowError) as exc:
        return [issue("regex_invalid", path=f"{path}/{key}", reason=type(exc).__name__)]
    return []


def _check_issues(path: str, checks: Mapping[str, Any], *, builtin: bool) -> tuple[list[Issue], list[tuple[str, str]]]:
    """The regular-expression problems of the ``forbid`` and ``require`` items under ``path``, and their ids."""
    found = []
    ids = []
    for section, key in (("forbid", "pattern"), ("require", "any_of")):
        for index, item in enumerate(checks.get(section) or []):
            where = f"{path}/{section}/{index}"
            ids.append((f"{where}/id", str(item["id"])))
            if key in item:
                found += _regex_issues(where, key, str(item[key]), builtin=builtin)
    return found, ids


def _rule_issues(path: str, rule: Mapping[str, Any], *, builtin: bool) -> list[Issue]:
    """A rule's patterns, and the ids of its checks: one namespace for the whole prompt and the per-shot checks,
    because a finding names its check by id."""
    found, ids = _check_issues(path, rule, builtin=builtin)
    shots = rule.get("shots")
    if shots:
        shot_found, shot_ids = _check_issues(f"{path}/shots", shots, builtin=builtin)
        found += shot_found
        ids += shot_ids
        if "every_subject" in shots:
            ids.append((f"{path}/shots/every_subject/id", str(shots["every_subject"]["id"])))
    return [*found, *_duplicates(ids)]


def valid_frames(frames: int) -> bool:
    """MiniMax-H3 frame counts are 17n+5."""
    return frames % 17 == 5


def _generation_issues(path: str, generation: Mapping[str, Any]) -> list[Issue]:
    found = []
    frames = (generation.get("defaults") or {}).get("frames")
    if frames is not None and not valid_frames(frames):
        found.append(issue("frames_invalid", path=f"{path}/defaults/frames", frames=frames))
    requirements = generation.get("require") or []
    for index, item in enumerate(requirements):
        if item["field"] == "frames":
            found += [
                issue("frames_invalid", path=f"{path}/require/{index}/in", frames=value)
                for value in item["in"]
                if not valid_frames(value)
            ]
    ids = [(f"{path}/require/{index}/id", str(item["id"])) for index, item in enumerate(requirements)]
    return [*found, *_duplicates(ids)]


def _code_issues(manifest: Mapping[str, Any], contributes: Mapping[str, Any]) -> list[Issue]:
    """``main`` and ``engines.plugin_api`` come together; everything that only code can use needs ``main``."""
    declared_api = "plugin_api" in manifest["engines"]
    if "main" in manifest:
        return [] if declared_api else [issue("plugin_api_required", path="engines/plugin_api")]
    needs_code = {
        "engines/plugin_api": declared_api,
        "permissions": bool(manifest.get("permissions")),
        "contributes/commands": bool(contributes.get("commands")),
        "contributes/panels": bool(contributes.get("panels")),
    }
    return [issue("main_required", path=path) for path, present in needs_code.items() if present]


def semantic_issues(manifest: Mapping[str, Any], *, builtin: bool) -> list[Issue]:
    """The manifest rules a schema cannot express, for a manifest that already satisfies the contract."""
    found = []
    reserved = str(manifest["id"]).startswith(BUILTIN_PREFIX)
    if reserved and not builtin:
        found.append(issue("reserved_id", path="id"))
    if builtin and not reserved:
        found.append(issue("builtin_id", path="id"))
    lowest, excluded = engine_range(manifest)
    if lowest >= excluded:
        found.append(issue("engines_range_empty", path="engines/phasyn"))
    contributes = manifest.get("contributes") or {}
    found += _code_issues(manifest, contributes)
    found += _duplicates(_contribution_ids(contributes, _SELECTABLE))
    for kind in _SEPARATE:
        found += _duplicates(_contribution_ids(contributes, (kind,)))
    for index, rule in enumerate(contributes.get("rules") or []):
        found += _rule_issues(f"contributes/rules/{index}", rule, builtin=builtin)
    for index, generation in enumerate(contributes.get("generation") or []):
        found += _generation_issues(f"contributes/generation/{index}", generation)
    return found


# ---------------------------------------------------------------------------------------------- compatibility
def _permission_issues(permissions: Iterable[str]) -> list[Issue]:
    found = []
    for name in permissions:
        if name in RESERVED_PERMISSIONS or name.startswith(RESERVED_PERMISSION_PREFIXES):
            found.append(issue("permission_reserved", path="permissions", permission=name))
        elif name not in PERMISSIONS:
            found.append(issue("permission_unknown", path="permissions", permission=name))
    return found


def compatibility_issues(manifest: Mapping[str, Any], *, host_version: str) -> list[Issue]:
    """Why this host cannot use a valid package (empty = compatible).

    ``host_version`` is the Phasyn Studio version: only its release number is compared with ``engines.phasyn``, and a
    version without one (a source tree that was never installed) is compatible with nothing.
    """
    found = []
    lowest, excluded = engine_range(manifest)
    host = _core(host_version)
    if host is None or not lowest <= host < excluded:
        found.append(
            issue("host_version", path="engines/phasyn", required=manifest["engines"]["phasyn"], host=host_version)
        )
    if "main" in manifest and manifest["engines"].get("plugin_api") not in PLUGIN_APIS:
        found.append(
            issue(
                "code_unsupported",
                path="main",
                plugin_api=manifest["engines"].get("plugin_api"),
                supported=list(PLUGIN_APIS),
            )
        )
    return [*found, *_permission_issues(manifest.get("permissions") or [])]


# ---------------------------------------------------------------------------------------------- references
def contribution_ref(plugin_id: str, local_id: str, *, builtin: bool) -> str:
    """How a project names a contribution (contract ``StudioPluginRef``): bare for built-in packages, for ever."""
    return local_id if builtin else f"{plugin_id}/{local_id}"


def _matcher(item: Mapping[str, Any]) -> dict[str, Any]:
    for key in ("pattern", "any_of"):
        if key in item:
            return {key: item[key]}
    key = "terms" if "terms" in item else "any_terms"
    return {key: list(item[key]), "word": bool(item.get("word", False))}


def _rev(content: Any) -> str:
    return sha256_hex(canonical_json(content))[:REV_LENGTH]


def _shot_checks(rule: Mapping[str, Any]) -> dict[str, Any] | None:
    """What a rule checks per shot, as its revision counts it; None when it checks nothing per shot."""
    shots = rule.get("shots") or {}
    content = {
        "forbid": [_matcher(item) for item in shots.get("forbid") or []],
        "require": [_matcher(item) for item in shots.get("require") or []],
        "every_subject": "every_subject" in shots,
    }
    return content if content["forbid"] or content["require"] or content["every_subject"] else None


def rule_rev(rule: Mapping[str, Any]) -> str:
    """Content revision of a rule: what changes its behaviour (kind, group, matchers, per-shot checks, inject), never
    its texts. A rule without per-shot checks hashes exactly what it hashed before they existed, so the revisions
    recorded on takes of such rules stay current."""
    content: dict[str, Any] = {
        "kind": rule["kind"],
        "group": rule.get("group"),
        "forbid": [_matcher(item) for item in rule.get("forbid") or []],
        "require": [_matcher(item) for item in rule.get("require") or []],
        "inject": rule.get("inject") or "",
    }
    shots = _shot_checks(rule)
    if shots is not None:
        content["shots"] = shots
    return _rev(content)


def generation_rev(generation: Mapping[str, Any]) -> str:
    """Content revision of a generation setting: its defaults and what it requires, never its texts."""
    return _rev(
        {
            "defaults": generation.get("defaults") or {},
            "require": [{"field": item["field"], "in": item["in"]} for item in generation.get("require") or []],
        }
    )


__all__ = [
    "BUILTIN_PREFIX",
    "FILE_EXTENSIONS",
    "INVALID_CODE",
    "KIB",
    "LIMITS",
    "MAIN_NAME",
    "MANIFEST_NAME",
    "MANIFEST_SCHEMA",
    "MANIFEST_VERSION",
    "MAX_ISSUES",
    "MESSAGES",
    "MIB",
    "PATTERN_FLAGS",
    "PERMISSIONS",
    "PLAIN_FILE_NAMES",
    "PLUGIN_APIS",
    "PLUGIN_ID_MAX",
    "RESERVED_PERMISSIONS",
    "RESERVED_PERMISSION_PREFIXES",
    "Issue",
    "PluginLimits",
    "compatibility_issues",
    "contribution_ref",
    "engine_range",
    "generation_rev",
    "invalid",
    "is_plugin_id",
    "is_plugin_ref",
    "issue",
    "issues_of",
    "parse_manifest",
    "rule_rev",
    "semantic_issues",
    "valid_frames",
]
