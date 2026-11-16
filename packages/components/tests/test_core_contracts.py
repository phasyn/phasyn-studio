"""核心契約：設定 revision／parts、型別接線、檔案原子發布與 Range、Recorder 丟失與 null 語意。"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.files import FileStore, parse_range
from phasyn_components.ids import is_local_id
from phasyn_components.settings import SettingsState, normalize_recording, resolve_parts

NODE = str(uuid.uuid4())
PARTS = [
    {
        "path": "echo.stage_a",
        "settings_schema": {"properties": {"compute_dtype": {"enum": ["native", "fp32", "fp16"]}}},
    },
    {
        "path": "echo.stage_b",
        "settings_schema": {"properties": {"compute_dtype": {"enum": ["native", "fp32", "fp16"]}}},
    },
]


def definition() -> dict:
    return {
        "component_id": "echo",
        "label": "echo",
        "provider_id": "test.echo",
        "runtime_id": "cpu",
        "settings": {
            "load": {
                "device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu"},
                "precision": {"compute_dtype": "native"},
            },
            "invoke": {},
            "recording": normalize_recording(None),
        },
    }


def test_settings_patch_revision_parts_and_restart_required() -> None:
    state = SettingsState(definition())
    state.mark_loaded(state.stored["load"], 1)
    state.apply_patch(
        {"load": {"part_overrides": [{"selector": "echo.stage_b", "settings": {"compute_dtype": "fp32"}}]}},
        expected_revision=1,
        settings_schema=None,
        parts=PARTS,
    )
    view = state.view({}, {})
    assert view["stored_revision"] == 2 and view["loaded_revision"] == 1 and view["restart_required"] is True
    expanded = resolve_parts(PARTS, view["stored"]["load"]["precision"], view["stored"]["load"]["part_overrides"])
    assert expanded == {"echo.stage_a": {"compute_dtype": "native"}, "echo.stage_b": {"compute_dtype": "fp32"}}
    with pytest.raises(ComponentError) as conflict:
        state.apply_patch({"invoke": {"x": 1}}, expected_revision=1, settings_schema=None)
    assert conflict.value.code == "REVISION_CONFLICT" and conflict.value.status == 409
    for patch, code in (
        (
            {"load": {"part_overrides": [{"selector": "nothing.*", "settings": {"compute_dtype": "fp32"}}]}},
            "UNSUPPORTED_SETTING",
        ),
        (
            {"load": {"part_overrides": [{"selector": "echo.*", "settings": {"accumulation_dtype": "fp32"}}]}},
            "UNSUPPORTED_SETTING",
        ),
        ({"bogus": {}}, "UNSUPPORTED_SETTING"),
    ):
        with pytest.raises(ComponentError) as err:
            state.apply_patch(patch, expected_revision=None, settings_schema=None, parts=PARTS)
        assert err.value.code == code and err.value.status == 422
    assert state.stored_revision == 2  # 失敗的保存不改變 revision


def test_file_store_atomic_publish_hash_and_range(tmp_path: Path) -> None:
    store = FileStore(tmp_path, NODE, buffer_bytes=65536)
    writer = store.new_writer("application/octet-stream")
    writer.write(b"a" * 1000)
    assert store.meta(writer.file_id) is None  # `.part` 不對外可讀
    ref = writer.commit()
    contracts.validate("FileRef", ref)
    assert store.local_path_for(ref).read_bytes() == b"a" * 1000
    bad = store.new_writer("application/octet-stream")
    bad.write(b"truncated")
    with pytest.raises(ComponentError) as err:
        bad.commit(expected_size=999)
    assert err.value.code == "FILE_TRUNCATED" and store.meta(bad.file_id) is None
    with pytest.raises(ComponentError) as err:
        store.local_path_for(dict(ref, sha256="0" * 64))
    assert err.value.code == "FILE_HASH_MISMATCH"
    assert parse_range("bytes=10-19", 1000) == (10, 19) and parse_range("bytes=-10", 1000) == (990, 999)
    with pytest.raises(ComponentError) as err:
        parse_range("bytes=2000-", 1000)
    assert err.value.status == 416


def test_identifiers_ending_in_a_line_break_are_refused() -> None:
    """Identifiers become file names and URL segments: "$" must not let a trailing newline through."""
    assert is_local_id("echo") and not is_local_id("echo\n") and not is_local_id("echo\r\n")
    schema = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$"}
    contracts.validate_with_schema(schema, "echo", code="INVALID_ARGUMENT", what="id")
    with pytest.raises(ComponentError, match="does not match"):
        contracts.validate_with_schema(schema, "echo\n", code="INVALID_ARGUMENT", what="id")
    bad = definition() | {"component_id": "echo\n"}
    assert not contracts.is_valid("InstanceDefinition", bad) and contracts.is_valid("InstanceDefinition", definition())
