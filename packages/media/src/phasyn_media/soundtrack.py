"""序列的外部音軌（``media.sequence.v1`` 的 ``audio_track``，契約 ``MediaSequenceAudioTrack``）.

- 時間 0=來源影片軌第一幀（純音訊檔=音軌起點），與 ``media.probe`` 的 ``scene_cuts_seconds`` 同一個時間軸；
  ``start_seconds`` 換算成容器時間後以 ``atrim`` 取 sample 精準的起點。
- 輸出長度固定為序列總長的 sample 數（``apad``+``atrim``，48 kHz；總長=幀數÷影格率，已含速度與轉場）。
  來源比起點晚開始 → 前面補靜音（``adelay``）；來源提早結束 → 後面補靜音；兩者都寫進 notes。
- 沒有音軌、或起點已超過音軌結尾 → INVALID_ARGUMENT（不輸出整段靜音假裝成功）。
- 片段原本的聲音與聲音效果（音量、靜音、聲音淡入淡出、聲音轉場）都不使用；影片效果不受影響。
- ``aresample=async=1``：來源時間戳有缺口（超過 0.1 秒）時依時間戳補靜音，維持與影片同步（與播放器的行為相同）。
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from ._validate import filter_number as _num, invalid as _invalid, number as _number
from .effects import AUDIO_RATE, samples_for
from .errors import MediaError
from .files import check_local_file
from .limits import DEFAULT_LIMITS, MediaLimits
from .probe import _float, _int, run_ffprobe_json
from .timeline import scan_timeline


GAIN_MIN_DB = -30.0
GAIN_MAX_DB = 12.0
_KEYS = frozenset({"file", "start_seconds", "gain_db"})
# MP4 標頭的時長以毫秒記錄（edit list），只精確到約 1 ms：小於這個長度的補靜音不寫 notes（仍照實補齊）
NOTE_MIN_SECONDS = 0.002


@dataclass(frozen=True)
class AudioTrack:
    """One source audio stream and its placement in the mix."""

    file: Mapping[str, Any]
    start_seconds: float
    gain_db: float = 0.0


def parse_audio_track(value: Any, *, path: str = "sequence.audio_track") -> AudioTrack:
    """解析 ``audio_track``（純函式）；形狀或範圍不合法 → INVALID_ARGUMENT（帶 field_paths）."""
    if not isinstance(value, Mapping):
        raise _invalid(path, "必須是 object")
    unknown = sorted(str(key) for key in value if key not in _KEYS)
    if unknown:
        raise _invalid(path, f"不支援的欄位 {', '.join(unknown)}")
    file = value.get("file")
    if not isinstance(file, Mapping) or not file.get("file_id"):
        raise _invalid(f"{path}.file", "必須是 FileRef")
    if "start_seconds" not in value:
        raise _invalid(f"{path}.start_seconds", "必填")
    return AudioTrack(
        file=dict(file),
        start_seconds=_number(
            value["start_seconds"], f"{path}.start_seconds", 0.0, math.inf
        ),
        gain_db=_number(
            value.get("gain_db", 0), f"{path}.gain_db", GAIN_MIN_DB, GAIN_MAX_DB
        ),
    )


# --------------------------------------------------------------------------- 來源時間軸（ffprobe）


@dataclass(frozen=True)
class AudioSource:
    """來源檔的時間軸事實（容器時間，秒）."""

    origin_seconds: float  # 時間 0：影片=影片軌起點；純音訊=音軌起點
    audio_start_seconds: float
    audio_end_seconds: float | None  # None=標頭與 packet 掃描都無法得知
    end_method: str  # header|packet_scan|unknown
    sample_rate: int | None
    channels: int | None

    def as_dict(self) -> dict[str, Any]:
        """記錄用：時間換成以 origin 為 0."""
        end = self.audio_end_seconds
        return {
            "audio_start_seconds": round(
                self.audio_start_seconds - self.origin_seconds, 6
            ),
            "audio_end_seconds": None
            if end is None
            else round(end - self.origin_seconds, 6),
            "audio_end_method": self.end_method,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
        }


def audio_source(
    path: str | os.PathLike[str],
    *,
    limits: MediaLimits = DEFAULT_LIMITS,
    ffprobe: str | None = None,
    cancel: Any = None,
) -> AudioSource:
    """讀取來源的影片軌起點與第一條音軌（``a:0``）的起訖。沒有音軌 → INVALID_ARGUMENT.

    音軌結尾優先用標頭的 start_time+duration；標頭沒有串流時長（例如 Matroska）時以 packet 掃描補上。
    """
    local = check_local_file(path, limits=limits)
    doc = run_ffprobe_json(
        local.path,
        [
            "-show_entries",
            "stream=index,codec_type,start_time,duration,sample_rate,channels:stream_disposition=attached_pic",
        ],
        limits=limits,
        ffprobe=ffprobe,
        cancel=cancel,
    )
    streams = [s for s in doc.get("streams") or [] if isinstance(s, Mapping)]
    videos = [
        s
        for s in streams
        if s.get("codec_type") == "video"
        and not (s.get("disposition") or {}).get("attached_pic")
    ]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if not audios:
        raise MediaError(
            "INVALID_ARGUMENT",
            "audio_track 的檔案沒有音軌",
            field_paths=["sequence.audio_track.file"],
        )
    audio = audios[0]
    audio_start = _float(audio.get("start_time"))
    video_start = _float(videos[0].get("start_time")) if videos else None
    # 影片起點未知（極少見）時假設與音軌對齊，而不是假設容器時間 0
    origin = (
        video_start
        if video_start is not None
        else (audio_start if audio_start is not None else 0.0)
    )
    if audio_start is None:
        audio_start = origin
    duration = _float(audio.get("duration"))
    end: float | None = None
    method = "unknown"
    if duration is not None and duration > 0:
        end, method = audio_start + duration, "header"
    else:
        index = _int(audio.get("index"))
        try:
            streams_scanned = scan_timeline(
                local.path, limits=limits, ffprobe=ffprobe, cancel=cancel
            ).streams
        except MediaError as exc:
            if exc.code == "CANCELLED":
                raise
            streams_scanned = ()  # 掃描失敗：結尾記為未知（notes 會說明），不阻擋匯出
        for stream in streams_scanned:
            if stream.index == index and stream.packets > 0:
                end, method = stream.end_seconds, "packet_scan"
                break
    return AudioSource(
        origin_seconds=origin,
        audio_start_seconds=audio_start,
        audio_end_seconds=end,
        end_method=method,
        sample_rate=_int(audio.get("sample_rate")),
        channels=_int(audio.get("channels")),
    )


# --------------------------------------------------------------------------- 規劃與 filtergraph（純函式）


@dataclass(frozen=True)
class SoundtrackPlan:
    """The ordered audio tracks and duration of a soundtrack."""

    samples: int  # 輸出 sample 數（48 kHz）=序列總長
    trim_start_seconds: (
        float | None
    )  # 來源容器時間上的起點；None=從音軌第一個 sample 開始
    lead_samples: int  # 前面補的靜音（來源比起點晚開始）
    tail_samples: int | None  # 後面補的靜音（依來源音軌結尾估計；None=未知）
    gain_db: float
    notes: tuple[str, ...]

    @property
    def seconds(self) -> float:
        """Return the timeline duration in seconds."""
        return self.samples / AUDIO_RATE

    def as_dict(self) -> dict[str, Any]:
        """Return the serializable field values."""
        return {
            "samples": self.samples,
            "duration_seconds": round(self.seconds, 6),
            "lead_silence_seconds": round(self.lead_samples / AUDIO_RATE, 6),
            "tail_silence_seconds": None
            if self.tail_samples is None
            else round(self.tail_samples / AUDIO_RATE, 6),
        }


def plan_soundtrack(
    track: AudioTrack,
    source: AudioSource,
    *,
    total_frames: int,
    fps: Fraction,
    path: str = "sequence.audio_track",
) -> SoundtrackPlan:
    """序列總長 total_frames 幀（fps）的聲音：從來源 start_seconds 起取 samples 個 sample，不足補靜音."""
    samples = samples_for(total_frames, fps)
    if samples <= 0:
        raise _invalid(path, "序列長度為 0，沒有聲音可產生")
    seconds = samples / AUDIO_RATE
    requested = source.origin_seconds + track.start_seconds
    audio_start = source.audio_start_seconds - source.origin_seconds
    lead = max(0, round((source.audio_start_seconds - requested) * AUDIO_RATE))
    if lead >= samples:
        raise _invalid(
            f"{path}.start_seconds",
            f"來源音軌從 {audio_start:.3f} 秒才開始，{track.start_seconds:.3f} 秒起的 {seconds:.3f} 秒內沒有聲音",
        )
    trim_start = (
        requested if lead == 0 and requested > source.audio_start_seconds else None
    )
    tail: int | None = None
    if source.audio_end_seconds is not None:
        first = max(requested, source.audio_start_seconds)
        available = source.audio_end_seconds - first
        end = source.audio_end_seconds - source.origin_seconds
        if available * AUDIO_RATE < 1:
            raise _invalid(
                f"{path}.start_seconds",
                f"起點 {track.start_seconds:.3f} 秒已超過來源音軌結尾（{end:.3f} 秒）",
            )
        tail = max(0, samples - lead - math.floor(available * AUDIO_RATE))
    notes = [
        f"聲音改用 audio_track：來源 {track.start_seconds:.3f} 秒起 {seconds:.3f} 秒（{samples} samples @ 48 kHz）；片段原本的聲音與聲音效果（音量、靜音、聲音淡入淡出、聲音轉場）不使用"
    ]
    if lead / AUDIO_RATE >= NOTE_MIN_SECONDS:
        notes.append(
            f"來源音軌在 {audio_start:.3f} 秒才開始：前面補 {lead / AUDIO_RATE:.3f} 秒靜音"
        )
    if source.audio_end_seconds is None:
        notes.append(
            "來源音軌長度未知（容器沒有記錄、也無法掃描）：不足的部分以靜音補齊"
        )
    elif tail is not None and tail / AUDIO_RATE >= NOTE_MIN_SECONDS:
        end = source.audio_end_seconds - source.origin_seconds
        notes.append(
            f"來源音軌在 {end:.3f} 秒結束：最後約 {tail / AUDIO_RATE:.3f} 秒以靜音補齊"
        )
    if track.gain_db > 0:
        notes.append(f"音軌增益 +{_num(track.gain_db)} dB（沒有限幅器，峰值可能削波）")
    elif track.gain_db < 0:
        notes.append(f"音軌增益 {_num(track.gain_db)} dB")
    return SoundtrackPlan(
        samples=samples,
        trim_start_seconds=trim_start,
        lead_samples=lead,
        tail_samples=tail,
        gain_db=track.gain_db,
        notes=tuple(notes),
    )


def soundtrack_chain(
    input_index: int, plan: SoundtrackPlan, *, label: str = "a"
) -> str:
    """``[input:a:0]…[label]``：取段、重取樣成 48 kHz stereo、補前段靜音、增益，最後固定成 plan.samples 個 sample."""
    parts: list[str] = []
    if plan.trim_start_seconds is not None:
        parts.append(f"atrim=start={plan.trim_start_seconds:.6f}")
    parts += [
        "asetpts=PTS-STARTPTS",
        f"aresample={AUDIO_RATE}:async=1",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
    ]
    if plan.lead_samples:
        parts.append(f"adelay=delays={plan.lead_samples}S:all=1")
    if plan.gain_db:
        parts.append(f"volume={_num(plan.gain_db)}dB")
    parts += [
        f"apad=whole_len={plan.samples}",
        f"atrim=end_sample={plan.samples}",
        "asetpts=PTS-STARTPTS",
    ]
    return f"[{input_index}:a:0]{','.join(parts)}[{label}]"


__all__ = [
    "GAIN_MAX_DB",
    "GAIN_MIN_DB",
    "NOTE_MIN_SECONDS",
    "AudioSource",
    "AudioTrack",
    "SoundtrackPlan",
    "audio_source",
    "parse_audio_track",
    "plan_soundtrack",
    "soundtrack_chain",
]
