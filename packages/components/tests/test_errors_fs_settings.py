"""Wire errors never carry stacks or local paths; the memory pre-check codes; atomic writes; instance-definition
metadata rules."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from phasyn_components.errors import (
    exception_details,
    exception_message,
    to_component_error,
)
from phasyn_components.fs import atomic_write_bytes, atomic_write_json, atomic_writer
from phasyn_components.pathscrub import mask_paths, redact_paths


def _raise_and_catch(exc: BaseException) -> BaseException:
    try:
        raise exc
    except BaseException as caught:
        return caught


def test_wire_error_details_have_no_stack_or_local_path() -> None:
    missing = _raise_and_catch(FileNotFoundError(2, "No such file or directory", "/srv/private/weights.bin"))
    err = to_component_error(missing)
    assert (err.code, err.status) == ("FILE_NOT_FOUND", 404)
    wire = json.dumps(err.to_dict(), ensure_ascii=False)
    assert "/srv/private" not in wire and "Traceback" not in wire and "weights.bin" in wire
    assert set(err.details) == {"exception_type", "exception_message"}

    boom = _raise_and_catch(RuntimeError("kernel launch failed"))
    assert set(to_component_error(boom).details) == {"exception_type", "exception_message"}
    assert "Traceback" in exception_details(boom)["stack"]  # the stack stays available for logs


def test_an_error_on_a_descriptor_is_reported_without_a_file_name() -> None:
    # os.scandir(fd) and calls with dir_fd= put the descriptor's number where a path is expected
    assert exception_message(OSError(5, "Input/output error", 7)) == "[Errno 5] Input/output error: ?"


def test_paths_inside_other_exception_messages_are_masked() -> None:
    boom = _raise_and_catch(RuntimeError("Error while loading /srv/models/x/y.safetensors (see http://192.0.2.10/a/b)"))
    wire = to_component_error(boom).to_dict()
    text = json.dumps(wire, ensure_ascii=False)
    assert "/srv/models" not in text and "y.safetensors" in text
    assert "http://192.0.2.10/a/b" in wire["message"]  # URLs are not paths
    assert (
        to_component_error(_raise_and_catch(ValueError("ratio 24000/1001 on 2026/10/19"))).details["exception_message"]
        == "ratio 24000/1001 on 2026/10/19"
    )


def test_local_file_urls_are_masked_like_paths() -> None:
    assert mask_paths("open file:///home/user/data/clip.mp4 failed") == "open file:clip.mp4 failed"
    assert redact_paths("src=FILE:///home/user/x.txt.") == "src=file:<redacted>/x.txt."
    kept = "see https://example.invalid/a/b and file://host/share/x"  # remote URLs and file shares are not paths
    assert mask_paths(kept) == kept and redact_paths(kept) == kept


def test_atomic_writer_replaces_whole_file_or_nothing(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "state.json"
    atomic_write_json(target, {"v": 1})
    assert json.loads(target.read_text()) == {"v": 1}
    with pytest.raises(RuntimeError), atomic_writer(target) as fh:
        fh.write(b'{"v": 2')
        raise RuntimeError("interrupted")
    assert json.loads(target.read_text()) == {"v": 1}
    assert [p.name for p in target.parent.iterdir()] == ["state.json"]  # no temp file left behind
    atomic_write_bytes(target, b"{}")
    assert target.read_bytes() == b"{}"
    with pytest.raises(ValueError):
        atomic_write_json(target, {"nan": float("nan")})
    assert target.read_bytes() == b"{}"
