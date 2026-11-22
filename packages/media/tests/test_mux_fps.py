"""``media.mux`` reads the video Asset's frame rate as the contract's Rational ``{num, den}``: any other shape is an
INVALID_ARGUMENT input error before a file is touched, never an AttributeError. Synthetic inputs; no FFmpeg."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from phasyn_components.errors import ERROR_CODES, ComponentError
from phasyn_components.files import FileStore
from phasyn_components.provider import InputValue, ProviderHost, RunContext
from phasyn_components.recorder import Recorder
from phasyn_components.testing.ids import NODE_A_ID, uid

from phasyn_media.providers.mux import MuxProvider, _asset_fps


def _invoke(tmp_path: Path, fps: Any, fit: str) -> None:
    store = FileStore(tmp_path / "data", NODE_A_ID)
    writer = store.new_writer("video/mp4", {})
    writer.write(b"synthetic")
    ref = writer.commit()
    asset = {"asset_id": uid(9), "kind": "final", "file": ref, "source_latent": None, "frame_count": 48,
             "fps": fps, "width": 64, "height": 64, "complete": True, "actual_settings": {}}  # fmt: skip
    rec = Recorder(recordings_root=tmp_path / "recordings", recording_id=uid(1), stream_id="runtime",
                   node_id=NODE_A_ID, component_id="mux", provider_id="media.mux", process_instance_id=uid(2),
                   operation="invoke")  # fmt: skip
    work = tmp_path / "work"
    work.mkdir()
    ctx = RunContext(
        call_id=uid(3), run_id=uid(4), step_id=None, parameters={"audio_fit": fit},
        inputs={"video": InputValue(type_id="media.asset.v1", value=asset),
                "audio": InputValue(type_id="media.audio.v1", path=tmp_path / "missing.wav")},
        store=store, deadline_ns=time.monotonic_ns() + 60 * 10**9, cancel_event=threading.Event(),
        output_types={"asset": "media.asset.v1"}, recorder=rec, device={"kind": "cpu"}, work_dir=work, settings={},
        resolver=lambda r, _remaining: str(store.payload_path(r["file_id"])),
    )  # fmt: skip
    host = ProviderHost(node_id=NODE_A_ID, component_id="mux", data_dir=tmp_path, work_dir=work, device={},
                        process_instance_id="x")  # fmt: skip
    MuxProvider(host).invoke(ctx)


@pytest.mark.parametrize(
    "fps",
    [
        24,
        23.976,
        "24",
        {"num": 24},
        {"num": 0, "den": 1},
        {"num": True, "den": 1},
        [24, 1],
    ],
)
@pytest.mark.parametrize("fit", ["exact", "conform"])
def test_a_frame_rate_that_is_not_a_rational_is_an_input_error(
    tmp_path: Path, fps: Any, fit: str
) -> None:
    with pytest.raises(ComponentError) as caught:
        _invoke(tmp_path, fps, fit)
    assert caught.value.code == "INVALID_ARGUMENT"
    assert caught.value.code in ERROR_CODES
    assert "num、den" in caught.value.message
    assert caught.value.details["field_path"] == "inputs.video.fps"


def test_a_rational_or_null_frame_rate_is_accepted() -> None:
    assert _asset_fps({"fps": {"num": 30000, "den": 1001}}) == (30000, 1001)
    assert _asset_fps({"fps": None}) is None
    assert _asset_fps({}) is None
