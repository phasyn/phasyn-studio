"""Component settings: stored/loaded revisions, patch merging, part-override expansion.

- A settings patch may only touch the ``load``, ``invoke`` and ``recording`` roots; objects merge
  recursively, arrays are replaced whole and ``null`` is the field's literal value (the schema decides
  whether it is allowed), not a deletion.
- ``stored_revision`` grows by one on every save; ``loaded_revision`` is set by the Node only after
  a model actually loaded.
- ``part_overrides`` apply in array order (later wins); a selector with no match, or a field the
  matched part does not accept, is a 422.
- Instance metadata (``label``, ``folder``, ``autostart``, ``limits``: ComponentMetaPatch) is kept
  apart from settings: changing it never bumps ``stored_revision`` or touches a loaded model.
  ``null`` for ``folder`` or ``limits`` removes the field from the definition.
- ``limits`` must be a JSON object of at most 16 KiB (canonical JSON); every path that accepts a
  definition (construction, ``replace_definition``, metadata patches) enforces it.

Rules:
"""

from __future__ import annotations

import copy
import fnmatch
import threading
from collections.abc import Mapping, Sequence
from typing import Any

from . import contracts
from .canonical import canonical_json, digest
from .errors import ComponentError

PATCH_ROOTS = ("load", "invoke", "recording")
META_FIELDS = ("label", "folder", "autostart", "limits")
REMOVABLE_META_FIELDS = ("folder", "limits")  # null in a ComponentMetaPatch removes these
LIMITS_MAX_BYTES = 16 * 1024


def recorder_defaults() -> dict[str, Any]:
    out = contracts.defaults_of("RecorderConfig")
    out.setdefault("mode", "detailed")
    return out


def normalize_recording(config: Mapping[str, Any] | None) -> dict[str, Any]:
    """補齊 RecorderConfig 預設值（mode 預設 detailed）。"""
    merged = recorder_defaults()
    merged["mode"] = "detailed"
    for key, value in (config or {}).items():
        merged[key] = copy.deepcopy(value)
    return merged


def deep_overlay(base: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """object 遞迴合併；array／純量整體替換；null 是字面值。原始 dict 不被修改。"""
    out = copy.deepcopy(dict(base))
    for key, value in patch.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), Mapping):
            out[key] = deep_overlay(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def check_patch_roots(patch: Mapping[str, Any]) -> None:
    unknown = sorted(set(patch) - set(PATCH_ROOTS))
    if unknown:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            f"設定 patch 只允許 load／invoke／recording，不接受：{', '.join(unknown)}",
            details={"unknown_roots": unknown},
        )
    for root in PATCH_ROOTS:
        if root in patch and not isinstance(patch[root], Mapping):
            raise ComponentError("INVALID_ARGUMENT", f"patch.{root} 必須是 object")


def check_limits(limits: object) -> None:
    """``limits`` (absent = ``None``) must be a JSON object of at most 16 KiB in canonical JSON."""
    if limits is None:
        return
    if not isinstance(limits, Mapping):
        raise ComponentError("INVALID_ARGUMENT", "limits 必須是 JSON object", details={"field": "limits"})
    size = len(canonical_json(limits))
    if size > LIMITS_MAX_BYTES:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"limits 序列化後 {size} bytes，超過上限 {LIMITS_MAX_BYTES} bytes",
            details={"field": "limits", "size_bytes": size, "max_bytes": LIMITS_MAX_BYTES},
        )


def validate_definition(definition: Mapping[str, Any]) -> None:
    """InstanceDefinition contract plus the checks JSON Schema cannot express (``limits`` size)."""
    contracts.validate("InstanceDefinition", dict(definition), what="元件定義")
    check_limits(definition.get("limits"))


def restart_required(stored_load: Mapping[str, Any], loaded_load: Mapping[str, Any] | None) -> bool:
    """已有載入中的模型且已保存的 load 設定與它不同時，需要使用者明確 restart。"""
    if loaded_load is None:
        return False
    return canonical_json(stored_load) != canonical_json(loaded_load)


def _match(selector: str, path: str) -> bool:
    return path == selector or fnmatch.fnmatchcase(path, selector)


def resolve_parts(
    parts: Sequence[Mapping[str, Any]],
    base: Mapping[str, Any],
    overrides: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """展開 instance 共用設定與 part_overrides 到命中的完整 part path。

    ``parts`` 是 provider describe 的 Part（path、settings_schema）。base 只取該 part
    schema 接受的欄位。任何 selector 沒有命中、或命中的 part 不接受某欄位 → 422。
    """
    accepted: dict[str, set[str] | None] = {}
    for part in parts:
        props = (part.get("settings_schema") or {}).get("properties")
        accepted[str(part["path"])] = set(props) if isinstance(props, Mapping) else None
    result: dict[str, dict[str, Any]] = {}
    for path, fields in accepted.items():
        if fields is None:
            result[path] = {}
        else:
            result[path] = {k: copy.deepcopy(v) for k, v in base.items() if k in fields}
    for index, item in enumerate(overrides):
        selector = str(item.get("selector", ""))
        settings = item.get("settings")
        if not selector or not isinstance(settings, Mapping):
            raise ComponentError("INVALID_ARGUMENT", f"part_overrides[{index}] 需要 selector 與 settings object")
        matched = [p for p in accepted if _match(selector, p)]
        if not matched:
            raise ComponentError(
                "UNSUPPORTED_SETTING",
                f"part_overrides[{index}] 的 selector「{selector}」沒有命中任何子部件",
                details={"selector": selector, "index": index, "matched": 0},
            )
        for path in matched:
            fields = accepted[path]
            rejected = sorted(k for k in settings if fields is None or k not in fields)
            if rejected:
                raise ComponentError(
                    "UNSUPPORTED_SETTING",
                    f"子部件 {path} 不接受設定欄位：{', '.join(rejected)}",
                    details={"selector": selector, "part": path, "rejected_fields": rejected, "index": index},
                )
            result[path] = deep_overlay(result[path], settings)
    return result


def validate_part_values(parts: Sequence[Mapping[str, Any]], expanded: Mapping[str, Mapping[str, Any]]) -> None:
    """展開後的每個 part 值以該 part 的 settings_schema 驗證（enum／型別）。"""
    schemas = {str(p["path"]): p.get("settings_schema") or {} for p in parts}
    for path, values in expanded.items():
        part_schema = schemas.get(path)
        if part_schema and values:
            contracts.validate_with_schema(
                {"type": "object", "properties": part_schema.get("properties", {}), "additionalProperties": True},
                dict(values),
                code="UNSUPPORTED_SETTING",
                what=f"子部件 {path} 的設定不被支援",
            )


def validate_settings(
    settings: Mapping[str, Any],
    *,
    settings_schema: Mapping[str, Any] | None,
    parts: Sequence[Mapping[str, Any]] = (),
) -> None:
    """一份完整設定的檢查（保存 patch 與 Node 保存定義共用）：InstanceSettings 契約、provider 的
    settings_schema（含未知欄位）、part_overrides 對 provider 的 parts。不符合就 422 UNSUPPORTED_SETTING。"""
    contracts.validate("InstanceSettings", dict(settings), code="UNSUPPORTED_SETTING", what="設定")
    if settings_schema:
        contracts.validate_with_schema(
            settings_schema, dict(settings), code="UNSUPPORTED_SETTING", what="provider 不支援此設定"
        )
    load = settings["load"]
    if parts or load.get("part_overrides"):
        validate_part_values(parts, resolve_parts(parts, load.get("precision") or {}, load.get("part_overrides") or []))


class SettingsState:
    """單一 instance 的設定狀態（Node 持有；thread-safe）。"""

    def __init__(self, definition: Mapping[str, Any], stored_revision: int = 1) -> None:
        validate_definition(definition)
        self._lock = threading.Lock()
        self.definition: dict[str, Any] = copy.deepcopy(dict(definition))
        self.stored_revision = max(1, int(stored_revision))
        self.loaded_revision: int | None = None
        self.loaded: dict[str, Any] | None = None

    @property
    def stored(self) -> dict[str, Any]:
        return self.definition["settings"]

    def snapshot(self) -> tuple[dict[str, Any], int]:
        with self._lock:
            return copy.deepcopy(self.definition["settings"]), self.stored_revision

    def view(self, settings_schema: Mapping[str, Any], parameters_schema: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            return {
                "stored_revision": self.stored_revision,
                "loaded_revision": self.loaded_revision,
                "stored": copy.deepcopy(self.definition["settings"]),
                "loaded": copy.deepcopy(self.loaded),
                "restart_required": restart_required(self.definition["settings"]["load"], self.loaded),
                "settings_schema": dict(settings_schema),
                "parameters_schema": dict(parameters_schema),
            }

    def apply_patch(
        self,
        patch: Mapping[str, Any],
        *,
        expected_revision: int | None,
        settings_schema: Mapping[str, Any] | None,
        parts: Sequence[Mapping[str, Any]] = (),
        lock_identity: bool = False,
    ) -> dict[str, Any]:
        """保存 patch，回傳新的 stored settings。不觸碰 loaded 狀態、不啟動推論。"""
        check_patch_roots(patch)
        with self._lock:
            if expected_revision is not None and int(expected_revision) != self.stored_revision:
                raise ComponentError(
                    "REVISION_CONFLICT",
                    f"設定已被更新（目前 revision {self.stored_revision}，送出時為 {expected_revision}）；請重新讀取後再保存",
                    details={"stored_revision": self.stored_revision, "expected_revision": expected_revision},
                )
            merged = deep_overlay(self.definition["settings"], patch)
            if lock_identity:
                old_device = self.definition["settings"]["load"].get("device")
                if merged["load"].get("device") != old_device:
                    raise ComponentError(
                        "STATE_CONFLICT",
                        "元件執行中不可更改 device；請先 stop 再修改",
                        details={"field": "load.device"},
                    )
            validate_settings(merged, settings_schema=settings_schema, parts=parts)
            self.definition["settings"] = merged
            self.stored_revision += 1
            return copy.deepcopy(merged)

    def replace_definition(self, definition: Mapping[str, Any]) -> None:
        validate_definition(definition)
        with self._lock:
            self.definition = copy.deepcopy(dict(definition))
            self.stored_revision += 1

    @staticmethod
    def _with_meta(definition: Mapping[str, Any], meta: Mapping[str, Any]) -> dict[str, Any]:
        contracts.validate("ComponentMetaPatch", dict(meta), what="元件資訊 patch")
        updated = copy.deepcopy(dict(definition))
        for key in META_FIELDS:
            if key not in meta:
                continue
            if key in REMOVABLE_META_FIELDS and meta[key] is None:
                updated.pop(key, None)
            else:
                updated[key] = copy.deepcopy(meta[key])
        validate_definition(updated)
        return updated

    def meta_record(self, meta: Mapping[str, Any]) -> dict[str, Any]:
        """套用 ComponentMetaPatch 後要保存的完整紀錄（已驗證；不修改目前狀態、stored_revision 不變）。"""
        with self._lock:
            return {"definition": self._with_meta(self.definition, meta), "stored_revision": self.stored_revision}

    def apply_meta(self, meta: Mapping[str, Any]) -> None:
        """Apply a ComponentMetaPatch; settings and ``stored_revision`` stay unchanged."""
        with self._lock:
            self.definition = self._with_meta(self.definition, meta)

    def mark_loaded(self, load: Mapping[str, Any], revision: int) -> None:
        with self._lock:
            self.loaded = copy.deepcopy(dict(load))
            self.loaded_revision = int(revision)

    def mark_unloaded(self) -> None:
        with self._lock:
            self.loaded = None
            self.loaded_revision = None

    def to_record(self) -> dict[str, Any]:
        with self._lock:
            return {"definition": copy.deepcopy(self.definition), "stored_revision": self.stored_revision}


def effective_context(
    *,
    requested: Mapping[str, Any],
    effective: Mapping[str, Any],
    observed: Mapping[str, Any],
    stored_revision: int,
    loaded_revision: int | None,
    expanded_parts: Mapping[str, Mapping[str, Any]],
    model_identity: Mapping[str, Any],
    runtime_identity: Mapping[str, Any],
) -> dict[str, Any]:
    """EffectiveContext：config_digest 取 effective 的 canonical SHA-256。"""
    return {
        "requested": copy.deepcopy(dict(requested)),
        "effective": copy.deepcopy(dict(effective)),
        "observed": copy.deepcopy(dict(observed)),
        "stored_revision": int(stored_revision),
        "loaded_revision": loaded_revision,
        "expanded_parts": {k: dict(v) for k, v in expanded_parts.items()},
        "config_digest": digest(effective),
        "model_identity": dict(model_identity),
        "runtime_identity": dict(runtime_identity),
    }


__all__ = [
    "LIMITS_MAX_BYTES",
    "META_FIELDS",
    "PATCH_ROOTS",
    "REMOVABLE_META_FIELDS",
    "SettingsState",
    "check_limits",
    "check_patch_roots",
    "deep_overlay",
    "effective_context",
    "normalize_recording",
    "recorder_defaults",
    "resolve_parts",
    "restart_required",
    "validate_definition",
    "validate_part_values",
    "validate_settings",
]
