"""A run output placed on the timeline is named after its run, not ``"<output key> · <run id>"``.

a line dubbed from the Captions panel showed on A2 as 「audio · 4b55916f-…」 and an applied 局部重製
candidate as 「final · 211b1502-…」. The run label (without 「Studio：」 and the project's title) names the source; a run
without a label keeps the old name.
"""

from __future__ import annotations

from typing import Any

from phasyn_components.timeline_edit.commands import (
    RUN_LABEL,
    execute_command,
    run_source_name,
)
from phasyn_components.timeline_edit.model import empty_timeline


RUN = "00000000-0000-4000-8000-000000000009"
PROJECT: dict[str, Any] = {
    "project_id": "vector", "title": "測試・配音", "revision": 1, "created_at": "2026-11-01T00:00:00.000Z",
    "updated_at": "2026-11-01T00:00:00.000Z", "format": {"width": 768, "height": 448, "fps": {"num": 24, "den": 1}},
    "defaults": {"frames": 124, "route": "route-a", "steps": None}, "shots": [], "exports": [],
}  # fmt: skip
AUDIO = {
    "kind": "audio",
    "asset_id": "00000000-0000-4000-8000-00000000000a",
    "file": {
        "node_id": "00000000-0000-4000-8000-0000000000a1",
        "file_id": "00000000-0000-4000-8000-00000000000a",
        "size_bytes": 437840,
        "sha256": "ab" * 32,
        "media_type": "audio/wav",
        "metadata": {"sample_rate": 24000, "sample_count": 109440, "channels": 1},
    },
    "sample_count": 109440,
    "sample_rate": 24000,
}


def _counter() -> Any:
    count = 0

    def allocate(prefix: str) -> str:
        nonlocal count
        count += 1
        return f"{prefix}{count}"

    return allocate


def _place(label: str | None) -> str:
    project = {**PROJECT, "timeline": empty_timeline({"num": 24, "den": 1})}
    command = {
        "op": "place", "run_id": RUN, "output_key": "audio", "expected_source_sha256": "ab" * 32,
        "mode": "overwrite", "only_if_empty": True, "at": 0, "track_audio": "audio-2", "video": False, "audio": True,
    }  # fmt: skip
    assets: dict[tuple[str, ...], dict[str, Any]] = {(RUN, "audio", "place"): AUDIO}
    if label is not None:
        assets[(RUN, "audio", RUN_LABEL)] = {"label": label}
    result, _ = execute_command(project, command, _counter(), assets)
    (source,) = result["timeline"]["sources"]
    return str(source["name"])


def test_a_placed_dub_is_named_after_its_line() -> None:
    assert (
        _place("測試・配音・台詞配音・今天的海風好舒服") == "台詞配音・今天的海風好舒服"
    )


def test_without_a_run_label_the_old_name_stays() -> None:
    assert _place(None) == f"audio · {RUN}"


def test_run_source_name_drops_the_studio_prefix_and_the_project_title() -> None:
    assert run_source_name("Studio：測試・配音・鏡頭 1", "測試・配音", "x") == "鏡頭 1"
    assert (
        run_source_name("測試・配音 · 鏡頭 1 [48, 96)", "測試・配音", "x")
        == "鏡頭 1 [48, 96)"
    )
    assert (
        run_source_name("另一個專案・鏡頭 1", "測試・配音", "x") == "另一個專案・鏡頭 1"
    )
    assert run_source_name("測試・配音", "測試・配音", "x") == "測試・配音"
    assert run_source_name("  ", "測試・配音", "fallback") == "fallback"
    assert len(run_source_name("鏡" * 500, "", "x")) == 200
