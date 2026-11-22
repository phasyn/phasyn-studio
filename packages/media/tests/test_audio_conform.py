"""The soundtrack conform step: any chosen audio becomes float32 stereo WAV of exactly the video's length.

A TTS dub is typically mono 16-bit at 22.05/24 kHz and not as long as the take, while the mux
needs 2-channel 32-bit float. Real FFmpeg on tiny synthetic files.
"""

from __future__ import annotations

import threading
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore
from phasyn_components.provider import InputValue, ProviderHost, RunContext
from phasyn_components.recorder import Recorder
from phasyn_components.testing.ids import NODE_A_ID, uid

from phasyn_media.audio import read_wav_header
from phasyn_media.audio_conform import SAMPLE_RATE, conform_audio, target_samples
from phasyn_media.errors import MediaError
from phasyn_media.mux import mux
from phasyn_media.providers.mux import MuxProvider
from phasyn_media.testing import ffmpeg_unavailable
from phasyn_media.tools import find_ffmpeg, run_tool


@pytest.fixture(autouse=True)
def _ffmpeg() -> None:
    reason = ffmpeg_unavailable("libx264", "aac", "pcm_s16le", "pcm_f32le")
    if reason:
        pytest.skip(reason)


def _tool(*args: str) -> None:
    result = run_tool(
        [find_ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-y", *args],
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-500:]


def _tts(path: Path, seconds: float, rate: int) -> Path:
    """Mono 16-bit PCM, like a TTS output."""
    _tool("-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={rate}:duration={seconds}", "-ac", "1",
          "-c:a", "pcm_s16le", str(path))  # fmt: skip
    return path


def _video(path: Path, frames: int) -> Path:
    _tool("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24", "-frames:v", str(frames), "-c:v", "libx264",
          "-preset", "ultrafast", "-bf", "0", "-pix_fmt", "yuv420p", str(path))  # fmt: skip
    return path


def test_target_samples_follow_the_video_clock() -> None:
    assert target_samples(48, Fraction(24)) == 2 * SAMPLE_RATE
    assert target_samples(1, Fraction(30000, 1001)) == 1602
    with pytest.raises(MediaError):
        target_samples(0, Fraction(24))


@pytest.mark.parametrize(("seconds", "fit"), [(1.0, "padded"), (3.0, "trimmed")])
def test_mono_int16_audio_is_conformed_and_padded_or_trimmed(
    tmp_path: Path, seconds: float, fit: str
) -> None:
    source = _tts(tmp_path / "tts.wav", seconds, 22050)
    out = conform_audio(source, tmp_path / "fit.wav", frames=48, fps=Fraction(24))
    header = read_wav_header(out.path)
    assert (header.channels, header.sample_rate, header.frames) == (
        2,
        SAMPLE_RATE,
        2 * SAMPLE_RATE,
    )
    assert out.source_channels == 1 and out.source_sample_rate == 22050
    assert (out.padded_seconds > 0.9) is (fit == "padded")
    assert (out.trimmed_seconds > 0.9) is (fit == "trimmed")
    assert source.exists()  # the chosen file is never changed


def test_a_conformed_tts_dub_muxes_onto_the_take(tmp_path: Path) -> None:
    video = _video(tmp_path / "take.mp4", 48)
    fitted = conform_audio(
        _tts(tmp_path / "tts.wav", 1.3, 24000),
        tmp_path / "fit.wav",
        frames=48,
        fps=Fraction(24),
    )
    result = mux(video_track=video, pcm=fitted.path, output=tmp_path / "out.mp4", fps_num=24, fps_den=1,
                 expected_source_frames=48)  # fmt: skip
    assert result.delivered_frames == 48 and result.channels == 2


def test_a_file_without_sound_is_refused(tmp_path: Path) -> None:
    with pytest.raises(MediaError):
        conform_audio(
            _video(tmp_path / "silent.mp4", 12),
            tmp_path / "fit.wav",
            frames=12,
            fps=Fraction(24),
        )


def _mux_ctx(tmp_path: Path, audio: Path, video: Path, fit: str) -> Any:
    store = FileStore(tmp_path / "data", NODE_A_ID)
    writer = store.new_writer("video/mp4", {})
    writer.write(video.read_bytes())
    ref = writer.commit()
    asset = {"asset_id": uid(9), "kind": "final", "file": ref, "source_latent": None, "frame_count": 48,
             "fps": {"num": 24, "den": 1}, "width": 64, "height": 64, "complete": True, "actual_settings": {}}  # fmt: skip
    rec = Recorder(recordings_root=tmp_path / "recordings", recording_id=uid(1), stream_id="runtime",
                   node_id=NODE_A_ID, component_id="mux", provider_id="media.mux", process_instance_id=uid(2),
                   operation="invoke")  # fmt: skip
    work = tmp_path / "work"
    work.mkdir()
    ctx = RunContext(
        call_id=uid(3), run_id=uid(4), step_id=None, parameters={"audio_fit": fit},
        inputs={"video": InputValue(type_id="media.asset.v1", value=asset),
                "audio": InputValue(type_id="media.audio.v1", path=audio)},
        store=store, deadline_ns=time.monotonic_ns() + 120 * 10**9, cancel_event=threading.Event(),
        output_types={"asset": "media.asset.v1"}, recorder=rec, device={"kind": "cpu"}, work_dir=work, settings={},
        resolver=lambda r, _remaining: str(store.payload_path(r["file_id"])),
    )  # fmt: skip
    host = ProviderHost(node_id=NODE_A_ID, component_id="mux", data_dir=tmp_path, work_dir=work, device={},
                        process_instance_id="x")  # fmt: skip
    return ctx, MuxProvider(host), work


def test_mux_conform_replaces_the_soundtrack_with_a_tts_dub(tmp_path: Path) -> None:
    video = _video(tmp_path / "take.mp4", 48)
    dub = _tts(tmp_path / "dub.wav", 1.2, 24000)
    ctx, provider, work = _mux_ctx(tmp_path, dub, video, "conform")
    provider.invoke(ctx)
    asset = ctx.outputs["asset"]["value"]
    assert asset["has_audio"] is True and asset["frame_count"] == 48
    fit = asset["actual_settings"]["mux"]["audio_fit"]
    assert (
        fit["mode"] == "conform"
        and fit["source_channels"] == 1
        and fit["padded_seconds"] > 0.7
    )
    assert not list(work.glob("*-soundtrack.wav"))  # the conformed copy is removed


def test_mux_exact_still_refuses_audio_that_is_not_float_stereo(tmp_path: Path) -> None:
    video = _video(tmp_path / "take.mp4", 48)
    ctx, provider, _work = _mux_ctx(
        tmp_path, _tts(tmp_path / "dub.wav", 2.0, 48000), video, "exact"
    )
    with pytest.raises(ComponentError):
        provider.invoke(ctx)


def test_lead_silence_comes_before_the_source(tmp_path: Path) -> None:
    out = conform_audio(_tts(tmp_path / "tts.wav", 1.0, 48000), tmp_path / "fit.wav", frames=48, fps=Fraction(24),
                        lead_seconds=Fraction(1, 2))  # fmt: skip
    header = read_wav_header(out.path)
    data = np.fromfile(out.path, dtype="<f4", offset=header.data_offset).reshape(-1, 2)
    assert data.shape[0] == 2 * SAMPLE_RATE and out.lead_seconds == 0.5
    assert np.abs(data[: SAMPLE_RATE // 2 - 10]).max() == 0  # the lead is silent
    assert np.abs(data[SAMPLE_RATE // 2 + 100 : SAMPLE_RATE]).max() > 0.12
    assert (
        np.abs(data[SAMPLE_RATE * 3 // 2 + 100 :]).max() == 0
    )  # padded after the source ends
