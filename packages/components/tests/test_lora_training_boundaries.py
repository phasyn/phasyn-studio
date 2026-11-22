"""LoRA training boundaries: registration never escapes or overwrites; evaluation never sees training data."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.lora_training import captions, selection
from phasyn_components.providers import lora_register as lr


def _src(tmp_path: Path, data: bytes = b"weights") -> tuple[Path, str]:
    p = tmp_path / "in.safetensors"
    p.write_bytes(data)
    return p, hashlib.sha256(data).hexdigest()


def test_target_paths_stay_in_the_model_library(tmp_path: Path) -> None:
    (tmp_path / "loras").mkdir()
    weight, manifest, rel = lr.target_paths(str(tmp_path), "trained-a-1234", None)
    assert weight == tmp_path / "loras" / "trained" / "trained-a-1234.peft.safetensors"
    assert manifest == tmp_path / "loras" / "trained-a-1234.json"
    assert rel == "loras/trained/trained-a-1234.peft.safetensors"
    for bad in ("../x", "A", "a/b", ""):
        with pytest.raises(ComponentError):
            lr.target_paths(str(tmp_path), bad, None)
    with pytest.raises(ComponentError):
        lr.target_paths(str(tmp_path), "ok", "../job")


def test_a_symlinked_library_is_refused(tmp_path: Path) -> None:
    other = tmp_path / "elsewhere"
    other.mkdir()
    models = tmp_path / "models"
    models.mkdir()
    (models / "loras").symlink_to(other)
    with pytest.raises(ComponentError):
        lr.target_paths(str(models), "ok", None)


def test_place_weight_verifies_and_never_overwrites(tmp_path: Path) -> None:
    src, sha = _src(tmp_path)
    target = tmp_path / "lib" / "w.safetensors"
    assert lr.place_weight(src, target, sha256=sha, size_bytes=7) is True
    assert lr.place_weight(src, target, sha256=sha, size_bytes=7) is False
    (tmp_path / "x").mkdir()
    other, other_sha = _src(tmp_path / "x", b"different")
    with pytest.raises(ComponentError) as caught:
        lr.place_weight(other, target, sha256=other_sha, size_bytes=9)
    assert caught.value.code == "STATE_CONFLICT"
    assert target.read_bytes() == b"weights"


def test_place_weight_leaves_nothing_on_a_hash_mismatch(tmp_path: Path) -> None:
    src, _ = _src(tmp_path)
    target = tmp_path / "lib" / "w.safetensors"
    with pytest.raises(ComponentError):
        lr.place_weight(src, target, sha256="0" * 64, size_bytes=7)
    assert not target.exists()
    assert list(target.parent.iterdir()) == []


def _clip(cid: str, source: str, role: str, dh: str, sharp: float = 100.0) -> dict:
    return {
        "clip_id": cid,
        "source_id": source,
        "role": role,
        "dhash": dh,
        "stats": {"sharpness": sharp, "motion": 1.0},
    }


REVIEW = {"style": "2d animation", "big_text": False, "caption": "two fighters clash and one is thrown back",
          "shot": "wide", "camera": "shake"}  # fmt: skip


def test_heldout_near_duplicates_are_removed_from_training() -> None:
    same = "f" * 32
    dataset = {"clips": [_clip("a1", "s01", "train", same), _clip("a2", "s01", "train", "0" * 32),
                         _clip("h1", "s02", "heldout", same)]}  # fmt: skip
    out = selection.select(
        dataset, dict.fromkeys(("a1", "a2", "h1"), REVIEW), selection.SelectionOptions()
    )
    assert [t["clip_id"] for t in out["train"]] == ["a2"]
    assert out["rejected"]["a1"] == "leak"
    assert out["eval"] == ["h1"]
    assert {t["source_id"] for t in out["train"]}.isdisjoint(
        {h["source_id"] for h in out["heldout"]}
    )


def test_identity_leaks_in_captions_drop_the_clip() -> None:
    assert captions.identity_problems("A girl with pink hair runs.")
    assert captions.identity_problems("The man named Kaito jumps.")
    assert not captions.identity_problems(
        "A young woman leaps over the wall. The camera pans."
    )
    dataset = {"clips": [_clip("a1", "s01", "train", "0" * 32)]}
    bad = {**REVIEW, "caption": "Saitama punches a monster"}
    out = selection.select(dataset, {"a1": bad}, selection.SelectionOptions())
    assert out["train"] == []
    assert out["rejected"]["a1"] == "identity"


def test_a_logo_the_detector_could_not_place_drops_the_clip() -> None:
    logo = [{"region": [1040, 0, 1280, 90], "reason": "static_overlay"}]
    placed = {**_clip("a1", "s01", "train", "0" * 32), "loss_masks": logo}
    unplaced = _clip("a2", "s01", "train", "f" * 32)
    seen = {**REVIEW, "logo": True}
    out = selection.select(
        {"clips": [placed, unplaced]},
        {"a1": seen, "a2": seen},
        selection.SelectionOptions(),
    )
    assert [t["clip_id"] for t in out["train"]] == ["a1"]
    assert out["train"][0]["loss_masks"] == logo
    assert out["rejected"]["a2"] == "logo"
