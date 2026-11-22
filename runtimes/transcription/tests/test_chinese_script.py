"""Chinese transcripts come back in the requested script, whichever script Whisper drifted into."""

from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from phasyn_transcription import transcript
from phasyn_transcription.script import PROMPTS, convert_cues, requested_script


class _Model:
    supported_languages = ("zh", "en")

    def __init__(self, language: str, text: str) -> None:
        self.language = language
        self.text = text
        self.prompts: list[str | None] = []
        self.detected = 0

    def detect_language(self, _samples: Any) -> tuple[str, float, list[Any]]:
        self.detected += 1
        return self.language, 0.99, []

    def transcribe(self, _samples: Any, **options: Any) -> tuple[list[Any], Any]:
        self.prompts.append(options.get("initial_prompt"))
        segment = SimpleNamespace(start=0.0, end=1.0, text=self.text, words=None)
        return [segment], SimpleNamespace(
            language=self.language, language_probability=0.99
        )


def _ctx(**parameters: Any) -> Any:
    recorder = SimpleNamespace(phase=lambda _name: nullcontext())
    return SimpleNamespace(
        parameters={"vad": False, **parameters},
        recorder=recorder,
        check_cancelled=lambda: None,
    )


def _pcm(tmp_path: Path) -> tuple[Path, int]:
    samples = np.full(16_000, 0.1, dtype="<f4")
    path = tmp_path / "source.pcm"
    samples.tofile(path)
    return path, len(samples)


def test_only_the_two_scripts_are_requests() -> None:
    assert requested_script("traditional") == "traditional"
    assert requested_script("simplified") == "simplified"
    assert requested_script(None) is None
    assert requested_script("zh-TW") is None


def test_conversion_touches_text_only() -> None:
    cues: list[Any] = [
        {
            "start_ms": 0,
            "end_ms": 900,
            "text": "这是",
            "words": [{"start_ms": 0, "end_ms": 400, "text": "这", "probability": 0.5}],
        }
    ]
    convert_cues(cues, lambda text: text.replace("这", "這"))
    assert cues == [
        {
            "start_ms": 0,
            "end_ms": 900,
            "text": "這是",
            "words": [{"start_ms": 0, "end_ms": 400, "text": "這", "probability": 0.5}],
        }
    ]


def test_opencc_converts_chinese_deterministically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        transcript,
        "converter",
        lambda _script: lambda text: text.replace("这里", "這裡"),
    )
    model = _Model("zh", "这里很安静")
    cues, recognition = transcript.recognize(
        _ctx(chinese_script="traditional"), model, *_pcm(tmp_path)
    )
    assert [cue["text"] for cue in cues] == ["這裡很安静"]
    assert recognition["script_conversion"] == "opencc"
    assert model.prompts == [None]


def test_without_opencc_the_decoder_is_steered_for_chinese_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(transcript, "converter", lambda _script: None)
    chinese = _Model("zh", "這裡很安靜")
    _cues, recognition = transcript.recognize(
        _ctx(chinese_script="traditional"), chinese, *_pcm(tmp_path)
    )
    assert chinese.prompts == [PROMPTS["traditional"]]
    assert recognition["script_conversion"] == "prompt"
    english = _Model("en", "It is quiet here")
    _cues, recognition = transcript.recognize(
        _ctx(chinese_script="traditional"), english, *_pcm(tmp_path)
    )
    assert english.prompts == [None]
    assert recognition["script_conversion"] == "none"


def test_no_request_leaves_the_model_alone(tmp_path: Path) -> None:
    model = _Model("zh", "这里很安静")
    cues, recognition = transcript.recognize(_ctx(), model, *_pcm(tmp_path))
    assert [cue["text"] for cue in cues] == ["这里很安静"]
    assert (model.prompts, model.detected, recognition["script_conversion"]) == (
        [None],
        0,
        "none",
    )
