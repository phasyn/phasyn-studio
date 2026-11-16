"""2–8 個 recording 的設定／量測比較。

比較不是資格門檻，也不判定勝負：只列設定差異、各自量測與已知干擾因素（shape、seed、模型、
裝置、冷暖、compile／cache、recorder 模式、trace）。沒有共用 clock 的事件不做跨機時間軸。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..errors import ComponentError
from ..ids import require_uuid
from ..recorder.metrics import metric
from .store import RecordingStore


def _flatten(obj: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(obj, Mapping):
        out: dict[str, Any] = {}
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            out.update(_flatten(value, path))
        if not obj and prefix:
            out[prefix] = {}
        return out
    return {prefix: obj}


def _get(obj: Any, *path: str) -> Any:
    cur = obj
    for key in path:
        if not isinstance(cur, Mapping):
            return None
        cur = cur.get(key)
    return cur


def _input_hashes(context: Mapping[str, Any]) -> list[str]:
    out = []
    for name, item in sorted((context.get("input_summary") or {}).items()):
        file = (item or {}).get("file") if isinstance(item, Mapping) else None
        if isinstance(file, Mapping) and file.get("sha256"):
            out.append(f"{name}:{file['sha256']}")
        elif isinstance(item, Mapping) and item.get("value_digest"):
            out.append(f"{name}:{item['value_digest']}")
    return out


def compare(store: RecordingStore, recording_ids: Sequence[str]) -> dict[str, Any]:
    ids = [require_uuid(r, "recording_ids") for r in recording_ids]
    if len(ids) < 2 or len(ids) > 8:
        raise ComponentError("INVALID_ARGUMENT", "比較需要 2 到 8 個 recording")
    if len(set(ids)) != len(ids):
        raise ComponentError("INVALID_ARGUMENT", "recording_ids 不可重複")
    recs = [store.get(r) for r in ids]
    contexts = [r["context"] for r in recs]
    summaries = [r["summary"] for r in recs]

    flats = [_flatten((c.get("settings") or {}).get("effective") or {}) for c in contexts]
    paths = sorted(set().union(*[set(f) for f in flats]))
    settings_diff: list[dict[str, Any]] = []
    for path in paths:
        values = [f.get(path) for f in flats]
        present = [path in f for f in flats]
        if len({repr(v) for v in values}) > 1 or not all(present):
            row: dict[str, Any] = {"path": path, "values": values, "present": present}
            if len(ids) == 2:
                row.update(
                    {"before": values[0], "after": values[1], "before_present": present[0], "after_present": present[1]}
                )
            settings_diff.append(row)

    names = sorted(set().union(*[set((s.get("metrics") or {}).keys()) for s in summaries]))
    metrics: dict[str, list[dict[str, Any]]] = {}
    for name in names:
        row_metrics = []
        for s in summaries:
            m = (s.get("metrics") or {}).get(name)
            row_metrics.append(
                dict(m) if m else metric(name, None, quality="unavailable", reason="此 recording 沒有此量測")
            )
        metrics[name] = row_metrics

    confounders: list[str] = []

    def differs(label: str, values: list[Any]) -> None:
        if len({repr(v) for v in values}) > 1:
            confounders.append(f"{label}不同：" + " ｜ ".join(str(v) for v in values))

    differs("provider", [c.get("provider_id") for c in contexts])
    differs("operation", [c.get("operation") for c in contexts])
    differs("Node", [c.get("node_id") for c in contexts])
    differs("裝置", [_get(c, "environment", "device", "id") for c in contexts])
    differs("模型身分", [_get(c, "settings", "model_identity") for c in contexts])
    differs("runtime", [_get(c, "settings", "runtime_identity") for c in contexts])
    differs("seed", [_get(c, "settings", "effective", "parameters", "seed") for c in contexts])
    differs("輸入", [_input_hashes(c) for c in contexts])
    differs("recorder 模式", [_get(c, "recording", "mode") for c in contexts])
    differs(
        "trace 設定", [(_get(c, "recording", "trace_steps"), _get(c, "recording", "trace_parts")) for c in contexts]
    )
    differs("source revision", [_get(c, "environment", "source_revision") for c in contexts])
    for key in ("compile", "cache", "result_cache"):
        differs(f"{key} 設定", [_get(c, "settings", "effective", "invoke", key) for c in contexts])
    differs("冷／暖（同程序已執行過呼叫）", [_get(c, "settings", "observed", "warm") for c in contexts])
    if any(c.get("synthetic") for c in contexts):
        confounders.append("包含合成示例（synthetic）資料，不代表實際量測")
    if any(not s.get("context_available", True) for s in summaries):
        confounders.append("部分 recording 缺 context，設定差異不完整")
    if any(s.get("coverage") != "full" for s in summaries):
        confounders.append("部分 recording 的 coverage 不完整（有丟失或未覆蓋的 hook）")
    confounders.append("每個 recording 都是單次量測（n=1），不計 p95，也不能據此斷言某設定造成加速")

    hashes = [_input_hashes(c) for c in contexts]
    if all(not h for h in hashes):
        same_source: bool | None = None
    else:
        same_source = all(h == hashes[0] for h in hashes)
    return {
        "recording_ids": ids,
        "settings_diff": settings_diff,
        "metrics": metrics,
        "confounders": confounders,
        "same_source": same_source,
    }


__all__ = ["compare"]
