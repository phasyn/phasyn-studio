"""鏡頭切換偵測（``media.probe`` 的 invoke 參數 ``scenes``；契約 ``MediaInfo.scene_cuts_seconds``／``scene_detection``）。

- 分數來源：FFmpeg ``select`` filter 的 ``scene`` 變數（0–1；與前一影格的平均絕對差的變化量，跟常見的
  ``select='gt(scene,0.3)'`` 用法同一個尺度）。分數大於 ``threshold`` 的影格算一個候選切換點，時間是
  該影格（新鏡頭第一幀）的 PTS。
- 時間軸：``setpts=PTS-STARTPTS`` 讓影片軌第一個解碼影格為 0 秒，``settb=AVTB`` 讓 PTS 以微秒整數輸出
  （``metadata=print`` 的 ``pts_time`` 只有 6 位有效數字，長片會失去精度）。
- 合併：只保留 (0, duration) 內的候選；相距小於 ``min_gap_seconds`` 的候選只留分數最高的一個（同分留較早的），
  所以輸出的任兩個切換點至少相距 ``min_gap_seconds``。
- 只解碼選定的影片軌（``0:V:0``，不含封面圖），不輸出任何檔案；子程序同樣走 ``run_tool``（argv、逾時、取消、
  有界輸出）與 ``file:`` URL＋protocol／demuxer 白名單。
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from ._validate import invalid as _invalid
from ._validate import number as _number
from .errors import MediaError
from .files import check_local_file, unchanged_since
from .limits import DEFAULT_LIMITS, MediaLimits
from .tools import find_ffmpeg, input_url, redact, run_tool, summarize_stderr

THRESHOLD_MIN = 0.05
THRESHOLD_MAX = 0.9
THRESHOLD_DEFAULT = 0.3
MIN_GAP_MIN = 0.0
MIN_GAP_MAX = 10.0
MIN_GAP_DEFAULT = 0.5
# 合併後最多回傳的切換點數（MediaInfo 是 inline 輸出，必須遠小於 256 KiB）
MAX_SCENE_CUTS = 5000
_KEYS = ("threshold", "min_gap_seconds")
_US = 1_000_000


@dataclass(frozen=True)
class SceneDetection:
    threshold: float = THRESHOLD_DEFAULT
    min_gap_seconds: float = MIN_GAP_DEFAULT

    def as_dict(self) -> dict[str, float]:
        return {"threshold": self.threshold, "min_gap_seconds": self.min_gap_seconds}


def parse_scene_detection(value: Any, *, path: str = "parameters.scenes") -> SceneDetection | None:
    """解析 invoke 參數 ``scenes``：None＝不偵測；object 的欄位可省略（用預設值）；超出範圍 → INVALID_ARGUMENT。"""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _invalid(path, "必須是 object 或 null")
    unknown = sorted(str(key) for key in value if key not in _KEYS)
    if unknown:
        raise _invalid(path, f"不支援的欄位 {', '.join(unknown)}")
    return SceneDetection(
        threshold=_number(value.get("threshold", THRESHOLD_DEFAULT), f"{path}.threshold", THRESHOLD_MIN, THRESHOLD_MAX),
        min_gap_seconds=_number(
            value.get("min_gap_seconds", MIN_GAP_DEFAULT), f"{path}.min_gap_seconds", MIN_GAP_MIN, MIN_GAP_MAX
        ),
    )


# --------------------------------------------------------------------------- 解析 FFmpeg 輸出與合併（純函式）


@dataclass(frozen=True)
class SceneCandidate:
    seconds: float  # 新鏡頭第一幀的時間（影片軌第一幀＝0）
    score: float  # FFmpeg scene 分數（0–1）


_FRAME_LINE = re.compile(r"^frame:\s*\d+\s+pts:\s*(\S+)")
_SCORE_LINE = re.compile(r"^lavfi\.scene_score=(\S+)$")


def parse_scene_scores(text: str) -> tuple[list[SceneCandidate], int]:
    """解析 ``metadata=mode=print:key=lavfi.scene_score`` 的輸出（PTS 以 AVTB 微秒為單位）。

    回傳（候選切換點, 沒有 PTS 而無法定位的影格數）。
    """
    candidates: list[SceneCandidate] = []
    untimed = 0
    pending: int | None = None
    waiting = False
    for raw in text.splitlines():
        line = raw.strip()
        frame = _FRAME_LINE.match(line)
        if frame is not None:
            if waiting:  # 上一個影格沒有分數行：不猜
                untimed += 1
            token = frame.group(1)
            pending = int(token) if re.fullmatch(r"-?\d+", token) else None
            waiting = True
            continue
        score = _SCORE_LINE.match(line)
        if score is None or not waiting:
            continue
        waiting = False
        try:
            value = float(score.group(1))
        except ValueError:
            untimed += 1
            continue
        if pending is None or not math.isfinite(value):
            untimed += 1
            continue
        candidates.append(SceneCandidate(seconds=pending / _US, score=value))
    if waiting:
        untimed += 1
    return candidates, untimed


def merge_scene_cuts(
    candidates: Iterable[SceneCandidate], *, duration_seconds: float, min_gap_seconds: float
) -> list[float]:
    """只保留 (0, duration) 內的候選；相距小於 min_gap 的只留分數最高者（同分留較早）。回傳遞增的秒數（微秒精度）。"""
    inside = sorted(
        {(round(c.seconds, 6), c.score) for c in candidates if 0 < round(c.seconds, 6) < duration_seconds},
        key=lambda item: (-item[1], item[0]),
    )
    if min_gap_seconds <= 0:
        return sorted({seconds for seconds, _score in inside})
    # 以寬度 gap 的格子分桶：相距小於 gap 的切換點只可能在相鄰三格內（O(n)，不做兩兩比較）
    kept: dict[int, list[float]] = {}
    for seconds, _score in inside:
        cell = math.floor(seconds / min_gap_seconds)
        if any(
            round(abs(other - seconds), 6) < min_gap_seconds
            for offset in (-1, 0, 1)
            for other in kept.get(cell + offset, ())
        ):
            continue
        kept.setdefault(cell, []).append(seconds)
    return sorted(seconds for cell in kept.values() for seconds in cell)


# --------------------------------------------------------------------------- FFmpeg


@dataclass(frozen=True)
class SceneResult:
    detection: SceneDetection
    cuts_seconds: tuple[float, ...]
    candidates: int  # 分數超過門檻的影格數（範圍過濾與合併之前）
    untimed_frames: int  # 沒有 PTS 而無法定位的候選影格
    elapsed_seconds: float

    def fields(self) -> dict[str, Any]:
        """併入 MediaInfo 的欄位（契約 MediaInfo.scene_cuts_seconds／scene_detection）。"""
        return {"scene_cuts_seconds": list(self.cuts_seconds), "scene_detection": self.detection.as_dict()}


def scene_filter(threshold: float) -> str:
    """偵測用的 filtergraph（輸出到 stdout；``repr`` 讓 FFmpeg 解析出與參數完全相同的 double）。"""
    return (
        f"setpts=PTS-STARTPTS,settb=AVTB,select='gt(scene,{float(threshold)!r})',"
        "metadata=mode=print:key=lavfi.scene_score:file=-"
    )


def detect_scene_cuts(
    path: str | os.PathLike[str],
    detection: SceneDetection,
    *,
    duration_seconds: float,
    limits: MediaLimits = DEFAULT_LIMITS,
    ffmpeg: str | None = None,
    cancel: Any = None,
    timeout: float | None = None,
) -> SceneResult:
    """解碼影片軌一次，回傳合併後的切換點。切換點超過 ``MAX_SCENE_CUTS`` → INVALID_ARGUMENT（請提高門檻或間隔）。"""
    if not duration_seconds > 0:
        raise MediaError("INVALID_ARGUMENT", "鏡頭切換偵測需要已知的影片時長")
    local = check_local_file(path, limits=limits)
    exe = ffmpeg or find_ffmpeg()
    url = input_url(local.path)
    argv = [
        exe, "-hide_banner", "-nostdin", "-v", "error",
        "-protocol_whitelist", "file", "-format_whitelist", limits.format_whitelist, *limits.decoder_flags,
        "-i", url, "-map", "0:V:0", "-vf", scene_filter(detection.threshold), "-f", "null", "-",
    ]  # fmt: skip
    result = run_tool(
        argv,
        timeout=timeout or limits.process_timeout_seconds,
        cancel=cancel,
        max_stdout_bytes=limits.max_tool_output_bytes,
        max_stderr_bytes=limits.max_stderr_bytes,
        what="FFmpeg 鏡頭切換偵測",
    )
    if result.returncode != 0:
        detail = summarize_stderr(redact(result.stderr, {os.fspath(path): "<input>", url: "<input>"}), 600)
        raise MediaError("MEDIA_TOOL_FAILED", "鏡頭切換偵測失敗" + (f"：{detail}" if detail else ""))
    if not unchanged_since(local):
        raise MediaError("INTEGRITY_MISMATCH", "媒體檔案在鏡頭切換偵測期間被修改")
    candidates, untimed = parse_scene_scores(result.stdout.decode("utf-8", errors="replace"))
    cuts = merge_scene_cuts(candidates, duration_seconds=duration_seconds, min_gap_seconds=detection.min_gap_seconds)
    if len(cuts) > MAX_SCENE_CUTS:
        raise MediaError(
            "INVALID_ARGUMENT",
            f"偵測到 {len(cuts)} 個切換點，超過上限 {MAX_SCENE_CUTS}；請提高 threshold 或 min_gap_seconds",
            field_paths=["parameters.scenes"],
        )
    return SceneResult(
        detection=detection,
        cuts_seconds=tuple(cuts),
        candidates=len(candidates),
        untimed_frames=untimed,
        elapsed_seconds=result.elapsed_seconds,
    )


__all__ = [
    "MAX_SCENE_CUTS",
    "MIN_GAP_DEFAULT",
    "MIN_GAP_MAX",
    "MIN_GAP_MIN",
    "THRESHOLD_DEFAULT",
    "THRESHOLD_MAX",
    "THRESHOLD_MIN",
    "SceneCandidate",
    "SceneDetection",
    "SceneResult",
    "detect_scene_cuts",
    "merge_scene_cuts",
    "parse_scene_detection",
    "parse_scene_scores",
    "scene_filter",
]
