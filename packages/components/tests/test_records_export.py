"""Streamed recording exports: up-front validation, bounded chunks and optional redaction."""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Callable
from pathlib import Path

import pytest

from phasyn_components.errors import ComponentError
from phasyn_components.recorder import Recorder
from phasyn_components.records import RecordingStore, export, parse_redact
from phasyn_components.records.export import ExportResult
from phasyn_components.records.redact import REDACT_FIELDS
from phasyn_components.testing.ids import NODE_A_ID, gpu_uuid, uid


GPU = gpu_uuid(1)
HOST = "workstation-0042"
PROMPT = "a lighthouse at dusk, synthetic test prompt"
MODEL_DIR = "/srv/models/private-checkpoint"


def _recording(root: Path, rid: str, *, messages: list[str] | None = None) -> None:
    rec = Recorder(
        recordings_root=root,
        recording_id=rid,
        stream_id="runtime",
        node_id=NODE_A_ID,
        component_id="dit-gpu0",
        provider_id="test.echo",
        process_instance_id=uid(9001),
        operation="invoke",
        config={"mode": "detailed"},
    )
    rec.write_context(
        settings={
            "requested": {
                "load": {"model_path": f"{MODEL_DIR}/model.safetensors"},
                "invoke": {"prompt": PROMPT},
            }
        },
        input_summary={"prompt": {"type_id": "text.prompt.v1", "value": PROMPT}},
        environment={
            "hostname": HOST,
            "device": {"kind": "cuda", "id": GPU},
            "cuda_visible_devices": GPU,
        },
    )
    rec.log("info", f"loaded {MODEL_DIR}/model.safetensors on {GPU}")
    for message in messages or []:
        rec.log("info", message)
    rec.transfer(
        "weight_h2d", direction="H2D", submitted_bytes=8, src="host", dst=f"{GPU}:w0"
    )
    rec.finalize("succeeded")


@pytest.fixture
def store(tmp_path: Path) -> RecordingStore:
    root = tmp_path / "recordings"
    _recording(root, uid(1))
    trace_dir = root / uid(1) / "trace"
    trace_dir.mkdir()
    (trace_dir / "step-0.json").write_text(
        json.dumps({"traceEvents": [], "host": HOST}), encoding="utf-8"
    )
    store = RecordingStore(root)
    store.index_local()
    return store


def _secrets_absent(text: str) -> None:
    for secret in (HOST, GPU, PROMPT, MODEL_DIR):
        assert secret not in text, secret


def test_export_rejects_bad_requests_before_streaming(store: RecordingStore) -> None:
    cases: list[tuple[Callable[[], ExportResult], str]] = [
        (lambda: export(store, uid(1), "xml"), "INVALID_ARGUMENT"),
        (
            lambda: export(store, uid(1), "zip", redact=["hostnames"]),
            "INVALID_ARGUMENT",
        ),
        (lambda: export(store, uid(2), "jsonl"), "RECORDING_NOT_FOUND"),
        (lambda: export(store, uid(1), "trace", redact=["paths"]), "INVALID_ARGUMENT"),
    ]
    for call, code in cases:
        with pytest.raises(ComponentError) as err:
            call()
        assert err.value.code == code
    (store.directory(uid(1)) / "trace" / "step-0.json").unlink()
    with pytest.raises(ComponentError) as err:
        export(store, uid(1), "trace")
    assert err.value.code == "TRACE_UNAVAILABLE" and err.value.status == 404


def test_parse_redact_expands_all_and_rejects_unknown_names() -> None:
    assert parse_redact(["all"]) == REDACT_FIELDS
    assert parse_redact(["hostname,paths", " prompts ", ""]) == {
        "hostname",
        "paths",
        "prompts",
    }
    with pytest.raises(ValueError, match="device"):
        parse_redact(["devices"])


def test_redacted_exports_hide_hosts_devices_prompts_and_paths(
    store: RecordingStore,
) -> None:
    jsonl = b"".join(export(store, uid(1), "jsonl", redact=["all"]).chunks).decode()
    _secrets_absent(jsonl)
    records = [json.loads(line) for line in jsonl.splitlines()]
    context = records[0]["data"]
    assert context["environment"]["hostname"] == "<redacted>"
    assert (
        context["settings"]["requested"]["load"]["model_path"]
        == "<redacted>/model.safetensors"
    )
    assert context["input_summary"]["prompt"] == {
        "type_id": "text.prompt.v1",
        "value": "<redacted>",
    }
    assert context["recording_id"] == uid(1)  # ids that are not device ids stay usable

    archive = zipfile.ZipFile(
        io.BytesIO(b"".join(export(store, uid(1), "zip", redact=["all"]).chunks))
    )
    assert not [n for n in archive.namelist() if n.startswith("trace/")]
    assert "Redacted export" in archive.read("README.txt").decode()
    for name in archive.namelist():
        _secrets_absent(archive.read(name).decode())

    only_host = b"".join(
        export(store, uid(1), "jsonl", redact=["hostname"]).chunks
    ).decode()
    assert HOST not in only_host and GPU in only_host and PROMPT in only_host


def test_redaction_reaches_addresses_names_in_text_and_paths_with_spaces(
    tmp_path: Path,
) -> None:
    """``hostname`` also covers Node addresses and the names in later messages; ``paths`` a directory with a space."""
    root = tmp_path / "recordings"
    peer = "gpu-node-07.corp.example.net"
    messages = [
        f"步驟 s1 送出 invoke 到 Node {HOST}（http://{peer}:8090）",
        "peer download failed: http://192.0.2.20:8090/api/files/x and http://node-b:8090/api/files/y",
        "weights come from https://huggingface.co/Qwen/Qwen-Image-2.1",
        "cannot open /srv/shared models/private checkpoints/model.safetensors",
    ]
    _recording(root, uid(2), messages=messages)
    rec = Recorder(
        recordings_root=root,
        recording_id=uid(3),
        stream_id="controller",
        node_id=NODE_A_ID,
        component_id="controller",
        provider_id="controller",
        process_instance_id=uid(9002),
        operation="run",
        config={"mode": "detailed"},
    )
    rec.write_context(environment={"hostname": HOST, "controller_label": "studio-main"})
    rec.log("info", "invoke sent", endpoint=f"http://{peer}:8090", node_label=HOST)
    rec.log(
        "error", f"無法連線到 Node {HOST}（http://{peer}:8090）；studio-main 稍後不重送"
    )
    rec.finalize("failed")
    store = RecordingStore(root)
    store.index_local()

    text = b"".join(export(store, uid(2), "jsonl", redact=["all"]).chunks).decode()
    for secret in (
        HOST,
        "192.0.2.20",
        "node-b",
        "shared models",
        "private checkpoints",
    ):
        assert secret not in text, secret
    assert (
        "https://huggingface.co/Qwen/Qwen-Image-2.1" in text
    )  # a public source is not this installation
    assert "<redacted>/model.safetensors" in text

    text = b"".join(export(store, uid(3), "jsonl", redact=["hostname"]).chunks).decode()
    for secret in (HOST, peer, "studio-main"):
        assert secret not in text, secret
    assert "http://<redacted>:8090" in text
