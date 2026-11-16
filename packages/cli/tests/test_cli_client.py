"""``phasyn-studio records``: the HTTP client lists pages, streams exports atomically and passes ``redact`` through."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from phasyn_cli import client
from phasyn_cli import main as cli
from phasyn_components.errors import ComponentError
from phasyn_components.testing import ids

RID = ids.uid(1001)


def _transport(
    seen: list[httpx.Request], *, export_status: int = 200, filename: str = f"diagnostic-{RID}.zip"
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/recordings":
            return httpx.Response(200, json={"items": [], "next_cursor": None})
        if request.url.path.endswith("/export") and export_status == 200:
            return httpx.Response(
                200, content=b"PK-zip", headers={"Content-Disposition": f'attachment; filename="{filename}"'}
            )
        err = ComponentError("RECORDING_NOT_FOUND", "找不到")
        return httpx.Response(err.status, json=err.to_dict())

    return httpx.MockTransport(handler)


def test_list_and_export_stream_into_place(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    transport = _transport(seen)
    page = client.list_recordings(
        "controller-host:8080", component_id="dit-main", limit=5, run_id=None, transport=transport
    )
    assert page == {"items": [], "next_cursor": None}
    assert dict(seen[-1].url.params) == {"component_id": "dit-main", "limit": "5"}
    assert str(seen[-1].url).startswith("http://controller-host:8080/api/recordings")

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    path = client.export_recording(
        "http://controller-host:8080", RID, "zip", out_dir, redact=["prompts", "paths"], transport=transport
    )
    assert path == out_dir / f"diagnostic-{RID}.zip" and path.read_bytes() == b"PK-zip"
    assert seen[-1].url.params.multi_items() == [("format", "zip"), ("redact", "prompts"), ("redact", "paths")]
    assert list(out_dir.iterdir()) == [path]  # the temporary file was renamed, nothing left behind
    with pytest.raises(ComponentError) as info:
        client.get_recording("http://controller-host:8080", RID, transport=transport)
    assert info.value.code == "RECORDING_NOT_FOUND" and info.value.status == 404
    with pytest.raises(ComponentError):
        client.export_recording("http://controller-host:8080", RID, "pdf", out_dir, transport=transport)


def test_a_server_cannot_name_a_dotfile_or_a_path_in_the_output_directory(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / ".bashrc").write_text("mine\n", encoding="utf-8")
    for hostile in (".bashrc", "../escape.zip", "/etc/cron.d/job.zip", "run.sh", "x.zip/../.profile"):
        path = client.export_recording("http://h:8080", RID, "zip", home, transport=_transport([], filename=hostile))
        assert path == home / f"recording-{RID}.zip", hostile
    assert (home / ".bashrc").read_text(encoding="utf-8") == "mine\n"
    assert sorted(p.name for p in tmp_path.rglob("*")) == [".bashrc", "home", f"recording-{RID}.zip"]


def test_failed_export_leaves_no_file(tmp_path: Path) -> None:
    target = tmp_path / "diag.zip"
    with pytest.raises(ComponentError) as info:
        client.export_recording("http://h:8080", RID, "zip", target, transport=_transport([], export_status=404))
    assert info.value.code == "RECORDING_NOT_FOUND"
    assert list(tmp_path.iterdir()) == []


def test_records_export_command_passes_redact_and_maps_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[str, tuple[str, ...]]] = []

    def fake_export(url: str, rid: str, fmt: str, output: Path, *, redact: tuple[str, ...]) -> Path:
        calls.append((fmt, tuple(redact)))
        if rid == "missing":
            raise ComponentError("RECORDING_NOT_FOUND", "找不到")
        return output

    monkeypatch.setattr(client, "export_recording", fake_export)
    argv = ["records", "export", "--url", "h:8080", "--output", str(tmp_path / "x.zip")]
    assert cli.main([*argv, "--recording", RID, "--redact", "prompts", "--redact", "all"]) == 0
    assert calls == [("zip", ("prompts", "all"))]
    assert cli.main([*argv, "--recording", "missing"]) == cli.EXIT_FAILED
    assert "RECORDING_NOT_FOUND" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        cli.main([*argv, "--recording", RID, "--redact", "secrets"])  # argparse rejects unknown categories
