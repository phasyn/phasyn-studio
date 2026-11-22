"""Keep all caption times on the normalized source clock and serialize valid SubRip."""

from __future__ import annotations

from importlib import import_module
from math import isfinite
from typing import TYPE_CHECKING, Any, TypedDict

from phasyn_components.errors import ComponentError

from .script import (
    Conversion,
    apply_script,
    converter,
    requested_script,
    steering_prompt,
)
from .source import SAMPLE_RATE


if TYPE_CHECKING:
    from pathlib import Path

    from phasyn_components.provider import RunContext


class Word(TypedDict):
    """One recognized word on the source clock."""

    start_ms: int
    end_ms: int
    text: str
    probability: float


class Cue(TypedDict, total=False):
    """One model segment and its optionally requested word alignment."""

    start_ms: int
    end_ms: int
    text: str
    words: list[Word]


def _ms(seconds: float, last_ms: int) -> int:
    if not isfinite(seconds):
        raise ComponentError("MEDIA_INCOMPLETE", "ASR produced an invalid timestamp")
    return min(max(0, round(seconds * 1000)), last_ms)


def _clock(milliseconds: int) -> str:
    seconds, fraction = divmod(milliseconds, 1000)
    minutes, second = divmod(seconds, 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour:02}:{minute:02}:{second:02},{fraction:03}"


def subtitles(segments: list[Cue], *, offset_ms: int = 0) -> bytes:
    """Encode numbered UTF-8 cues; an empty transcript has an empty subtitle file."""
    blocks: list[str] = []
    for row in segments:
        start, end = max(0, row["start_ms"] - offset_ms), row["end_ms"] - offset_ms
        if end <= start:
            continue
        text = " ".join(row["text"].split())
        span = f"{_clock(start)} --> {_clock(end)}"
        blocks.append(f"{len(blocks) + 1}\n{span}\n{text}\n\n")
    return "".join(blocks).encode("utf-8")


def _speech_intervals(samples: Any) -> list[float]:
    vad = import_module("faster_whisper.vad")
    chunks = vad.get_speech_timestamps(samples, vad.VadOptions())
    return [chunk[edge] / SAMPLE_RATE for chunk in chunks for edge in ("start", "end")]


def _cue(segment: Any, duration_ms: int, *, words: bool) -> Cue | None:
    start = _ms(segment.start, duration_ms)
    end = _ms(segment.end, duration_ms)
    text = segment.text.strip()
    if end <= start or not text:
        return None
    cue: Cue = {"start_ms": start, "end_ms": end, "text": text}
    if words:
        cue["words"] = [
            {
                "start_ms": _ms(word.start, duration_ms),
                "end_ms": _ms(word.end, duration_ms),
                "text": word.word,
                "probability": word.probability,
            }
            for word in segment.words or ()
        ]
    return cue


class Recognition(TypedDict):
    """What recognize returns besides the cues."""

    language: str | None
    confidence: float | None
    # How the requested Chinese script was applied: opencc (deterministic), prompt (steered), none
    script_conversion: Conversion


def recognize(
    ctx: RunContext, model: Any, pcm: Path, sample_count: int
) -> tuple[list[Cue], Recognition]:
    """Recognize original-clock audio; VAD selects intervals without renumbering time."""
    nothing: Recognition = {
        "language": None,
        "confidence": None,
        "script_conversion": "none",
    }
    language = ctx.parameters.get("language")
    if language is not None and language not in model.supported_languages:
        raise ComponentError(
            "INVALID_ARGUMENT", "Language is unsupported by the selected ASR model"
        )
    numpy = import_module("numpy")
    if sample_count == 0:
        return [], nothing
    samples = numpy.fromfile(pcm, dtype="<f4", count=sample_count)
    if len(samples) != sample_count:
        raise ComponentError("MEDIA_INCOMPLETE", "Decoded ASR audio is truncated")
    if not numpy.any(samples):
        return [], nothing
    windows: str | list[float] = "0"
    if ctx.parameters.get("vad", True):
        with ctx.recorder.phase("voice_activity"):
            windows = _speech_intervals(samples)
        if not windows:
            return [], nothing
    ctx.check_cancelled()
    words = ctx.parameters.get("word_timestamps", False)
    script = requested_script(ctx.parameters.get("chinese_script"))
    convert = converter(script) if script else None
    prompt = steering_prompt(
        script, convert, language, lambda: model.detect_language(samples)[0]
    )
    segments, info = model.transcribe(
        samples,
        language=language,
        task="transcribe",
        beam_size=5,
        word_timestamps=words,
        vad_filter=False,
        clip_timestamps=windows,
        initial_prompt=prompt,
    )
    duration_ms = round(sample_count * 1000 / SAMPLE_RATE)
    cues = []
    for segment in segments:
        ctx.check_cancelled()
        row = _cue(segment, duration_ms, words=words)
        if row is not None:
            cues.append(row)
    ctx.check_cancelled()
    return cues, {
        "language": info.language,
        "confidence": info.language_probability,
        "script_conversion": apply_script(cues, convert, prompt, info.language),
    }
