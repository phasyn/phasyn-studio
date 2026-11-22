"""A reference video's soundtrack dropped on request (``use_embedded_audio: false``) never reaches the audio path.

Data-integrity boundary: the prepared entry of such a video (``input_has_audio`` true, ``soundtrack_dropped``
true, no waveform) must be a visual source only for every stage that decides "this material contributes audio"
(the audio encode's sources, the AdaLN flags, the empty audio partial), an entry whose waveform disagrees with
that rule is refused, and the DiT merge refuses an audio partial that carries a block for it.
The prepared documents are synthetic (only the keys these functions read); nothing is decoded or encoded.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3 import references
from phasyn_h3.recipe.runtime.errors import InvalidStageInput
from phasyn_h3.recipe.runtime.stages.common import contributes_audio
from phasyn_h3.recipe.runtime.stages.encode_references import (
    reference_metadata,
    scoped_sources,
)
from phasyn_h3.recipe.runtime.stages.prepare_adaln import condition_flags


VIDEO = "video.reference_preserve"


def image(index: int) -> dict[str, Any]:
    return {
        "material_index": index,
        "role": "reference_image",
        "material_chain": "image.reference_preserve",
    }


def video(
    index: int, *, has_audio: bool, dropped: bool = False, waveform: bool | None = None
) -> dict[str, Any]:
    """A prepared reference video; ``waveform`` defaults to what prepare_media writes for the other two flags."""
    entry: dict[str, Any] = {
        "material_index": index,
        "role": "reference_video",
        "material_chain": VIDEO,
        "input_has_audio": has_audio,
    }
    if dropped:
        entry["soundtrack_dropped"] = True
    if waveform if waveform is not None else has_audio and not dropped:
        entry["audio"] = {
            "tensor": f"ref_audio_{index:02d}",
            "source_sample_rate": 48000,
            "channels": "L,R",
        }
    return entry


def audio(index: int) -> dict[str, Any]:
    return {
        "material_index": index,
        "role": "reference_audio",
        "material_chain": "audio",
    }


def indices(items: list[Any]) -> list[int]:
    return [int(m["material_index"]) for m in items]


def test_a_dropped_soundtrack_is_a_visual_source_only() -> None:
    materials = [
        image(0),
        video(1, has_audio=True, dropped=True),
        video(2, has_audio=True),
        audio(3),
    ]
    visual, sound, base = scoped_sources(materials, "all")
    assert indices(visual) == [0, 1, 2]
    assert indices(sound) == [
        2,
        3,
    ]  # the kept soundtrack and the reference audio, never the dropped one
    assert base == 0
    _, sound, base = scoped_sources(materials, "audio")
    assert indices(sound) == [2, 3] and base == 3


def test_only_dropped_soundtracks_give_an_empty_audio_partial_and_no_audio_flag() -> (
    None
):
    materials = [image(0), video(1, has_audio=True, dropped=True)]
    assert scoped_sources(materials, "audio")[1] == []
    assert condition_flags({"materials": materials}, "ref2va") == (True, False)
    doc = references.empty_partial_document(
        {"materials": materials, "payload": {"sha256": "ab" * 32}}, task="ref2va"
    )
    assert doc["metadata"]["blocks"] == []
    assert doc["metadata"]["scope_sources"] == {"visual": [0, 1], "audio": []}


def test_the_pinned_path_still_counts_a_kept_soundtrack() -> None:
    materials = [video(0, has_audio=True)]
    assert contributes_audio(materials[0]) is True
    assert condition_flags({"materials": materials}, "ref2va") == (True, True)
    assert contributes_audio(video(1, has_audio=False)) is False


@pytest.mark.parametrize(
    "entry",
    [
        video(
            0, has_audio=True, dropped=True, waveform=True
        ),  # dropped, yet a waveform travels
        video(
            0, has_audio=True, waveform=False
        ),  # a kept soundtrack without its waveform
        video(
            0, has_audio=False, waveform=True
        ),  # a waveform from a file without sound
    ],
)
def test_an_entry_whose_waveform_disagrees_with_the_rule_is_refused(
    entry: dict[str, Any],
) -> None:
    with pytest.raises(InvalidStageInput) as caught:
        scoped_sources([entry], "audio")
    assert caught.value.reason_code == "REFERENCE_AUDIO_INCONSISTENT"
    with pytest.raises(InvalidStageInput):
        condition_flags({"materials": [entry]}, "ref2va")


def test_the_merge_refuses_an_audio_block_for_a_dropped_soundtrack(
    tmp_path: Path,
) -> None:
    materials = [image(0), video(1, has_audio=True, dropped=True)]
    sha = "cd" * 32
    visual_blocks = [
        {"kind": "image", "tensor": "image_00", "material_index": 0},
        {"kind": "video", "tensor": "video_01", "material_index": 1},
    ]
    vmeta = reference_metadata(
        visual_blocks, materials, "ref2va", scope="visual", prepared_payload_sha256=sha
    )
    ameta = reference_metadata(
        [], materials, "ref2va", scope="audio", prepared_payload_sha256=sha
    )
    ameta["blocks"] = [
        {"kind": "audio", "tensor": "audio_02", "material_index": 1}
    ]  # a leaked soundtrack
    video_part = references.Partial(
        "visual", vmeta, manifest={"kind": "reference_latents"}, payload=tmp_path / "v"
    )
    audio_part = references.Partial(
        "audio", ameta, manifest={"kind": "reference_latents"}, payload=tmp_path / "a"
    )
    with pytest.raises(ComponentError) as caught:
        references.merge_partials(
            video_part,
            audio_part,
            out_dir=tmp_path / "out",
            prepared_payload_sha256=sha,
        )
    assert caught.value.code == "LATENT_SOURCE_MISMATCH"
