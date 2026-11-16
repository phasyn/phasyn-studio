"""``phasyn-studio install``: the hardware → plan mapping, on fixture machines (no real detection, nothing written).

Every plan is also rendered into configuration files and checked with the services' own loaders, and every pipeline
step must name a component the generated Node defines: a plan that would seed a broken install fails here.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from phasyn_cli import configgen, install, planner, service
from phasyn_cli.machine import machine_from_dict, parse_cuda_version, parse_smi_query
from phasyn_components.testing.ids import CONTROLLER_ID, NODE_A_ID, gpu_uuid

REPO = Path(__file__).resolve().parents[3]
GIB = 1024**3
TOOLS = {
    "uv": {"path": "/usr/bin/uv", "version": "uv 0.9.0"},
    "git": {"path": "/usr/bin/git", "version": "git version 2.47.0"},
    "node": {"path": "/usr/bin/node", "version": "v22.22.2"},
    "pnpm": {"path": "/usr/bin/pnpm", "version": "12.21.0"},
    "ffmpeg": {"path": "/usr/bin/ffmpeg", "version": "ffmpeg version 7.1"},
    "ffprobe": {"path": "/usr/bin/ffprobe", "version": "ffprobe version 7.1"},
}
SM86_12GB = ("NVIDIA GPU sm86 12 GB", 12288, "8.6")
SM120_16GB = ("NVIDIA GPU sm120 16 GB", 16303, "12.0")
SM89_24GB = ("NVIDIA GPU sm89 24 GB", 24564, "8.9")
UMA_SM121: tuple[str, int | None, str] = ("NVIDIA unified-memory GPU sm121", None, "12.1")  # memory.total [N/A]


def fixture(
    *gpus: tuple[str, int | None, str],
    ram_gib: int = 64,
    models_free_gib: int = 2000,
    driver: str = "580.95.05",
    ports: dict[int, dict[str, Any]] | None = None,
    tools: dict[str, Any] | None = None,
    arch: str = "x86_64",
) -> dict[str, Any]:
    return {
        "os": "Linux",
        "arch": arch,
        "distro_id": "debian",
        "distro_like": [],
        "distro_name": "Debian GNU/Linux 13",
        "cpu_count": 16,
        "ram_total_bytes": ram_gib * GIB,
        "ram_available_bytes": ram_gib * GIB // 2,
        "driver_version": driver if gpus else None,
        "cuda_version": "13.0" if gpus else None,
        "gpus": [
            {
                "index": i,
                "uuid": gpu_uuid(i + 1),
                "name": name,
                "memory_total_mib": mib,
                "memory_used_mib": 0,
                "compute_capability": cap,
            }
            for i, (name, mib, cap) in enumerate(gpus)
        ],
        "gpu_error": None if gpus else "nvidia-smi: not found",
        "python": "3.12.13",
        "tools": tools if tools is not None else TOOLS,
        "disks": {
            "data": {"path": "/data", "probe_path": "/data", "free_bytes": 500 * GIB, "total_bytes": 4000 * GIB},
            "models": {
                "path": "/models",
                "probe_path": "/",
                "free_bytes": models_free_gib * GIB,
                "total_bytes": 4000 * GIB,
            },
        },
        "ports": {str(p): s for p, s in (ports or {8080: {"free": True}, 8090: {"free": True}}).items()},
        "systemd_user": True,
    }


def plan_for(doc: dict[str, Any], tmp_path: Path, **options: Any) -> dict[str, Any]:
    opts = planner.Options(repo_dir=REPO, data_dir=tmp_path / "data", models_dir=tmp_path / "models", **options)
    return planner.make_plan(machine_from_dict(doc), opts, planner.Templates(REPO))


def placed(plan: dict[str, Any]) -> dict[str, int | None]:
    return {c["component_id"]: c["gpu_index"] for c in plan["components"]}


def rendered_ok(plan: dict[str, Any], tmp_path: Path) -> dict[str, Any]:
    rendered = configgen.render_all(plan, planner.Templates(REPO), configgen.Ids(CONTROLLER_ID, NODE_A_ID))
    assert configgen.validate(rendered, tmp_path / "data" / "config") == []
    node = rendered["node.json"]
    defined = {c["component_id"] for c in node["components"]}
    for pid, pipeline in rendered["pipelines"].items():
        for step in pipeline["steps"]:
            assert step["node_id"] == NODE_A_ID, pid
            assert step["component_id"] in defined, (pid, step["component_id"])
    text = json.dumps(rendered)
    assert "GPU-REPLACE-" not in text and "/path/to/models" not in text
    for comp in node["components"]:
        device = comp["settings"]["load"]["device"]
        if device["kind"] == "cuda":
            assert device["id"] in {g["uuid"] for g in plan["gpus"] if g["role"] != "unused"}
    return rendered


def test_one_sm86_12gb_gpu_runs_bf16_dit_with_streaming_decoder(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM86_12GB), tmp_path)
    assert plan["ok"] and plan["profile"] == "single-gpu"
    comps = placed(plan)
    # sm86 has no FP8: the BF16 DiT of examples/generate_dit_components.py, same LoRA and sidecar
    assert "dit-fl2va-bf16-pai8" in comps and "dit-fl2va-fp8-pai8" not in comps
    assert "vae-gpu1-fp32-stream" in comps and "vae-gpu0" not in comps
    assert comps["audio-gpu1"] == 0 and comps["qimg-dit-bf16-stream-gpu0"] == 0
    assert comps["qimg-vision-gpu0"] == 0  # vision shares the only GPU …
    assert "prompt-analyze-local" in plan["standby_routes"]  # … so it is not loaded next to the DiT
    assert plan["ready_routes"] == ["t2va-local", "fl2va-local", "upscale-take-2x"]
    assert any("untested" in w for w in plan["warnings"])
    rendered = rendered_ok(plan, tmp_path)
    dit = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "dit-fl2va-bf16-pai8")
    assert dit["settings"]["load"]["precision"]["quantization"]["scheme"] == "none"
    assert dit["settings"]["load"]["provider_options"]["adaln"]["cache_ref"] == "h3-fl2va-pdd8"
    t2va = rendered["pipelines"]["t2va-local"]
    assert {s["component_id"] for s in t2va["steps"]} >= {"dit-fl2va-bf16-pai8", "vae-gpu1-fp32-stream"}


def test_one_sm120_16gb_gpu_runs_fp8_and_streams_the_image_dit(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM120_16GB), tmp_path)
    comps = placed(plan)
    assert plan["ok"] and {"dit-fl2va-fp8-pai8", "dit-ref2va-fp8-pai8", "vae-gpu0"} <= comps.keys()
    assert "qimg-dit-bf16-stream-gpu0" in comps and "qimg-dit-bf16-phase-gpu0" not in comps
    assert set(comps.values()) == {0}
    assert "ref2va-local" in plan["standby_routes"] and "t2i-local" in plan["standby_routes"]
    rendered = rendered_ok(plan, tmp_path)
    stream = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "qimg-dit-bf16-stream-gpu0")
    assert stream["settings"]["load"]["offload"]["pin_memory"] == "static"
    vae = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "qimg-vae-gpu0")
    assert vae["settings"]["invoke"]["mode"] == "full"


def test_one_24gb_gpu_uses_phase_for_qwen_image(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM89_24GB, ram_gib=128), tmp_path)
    comps = placed(plan)
    assert "qimg-dit-bf16-phase-gpu0" in comps and "dit-fl2va-fp8-pai8" in comps
    assert not any("host RAM" in w for w in plan["warnings"])
    rendered_ok(plan, tmp_path)


def test_two_gpus_put_audio_vision_and_upscaler_on_the_second(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM86_12GB, SM120_16GB), tmp_path)
    assert plan["profile"] == "dual-gpu"
    roles = {g["name"]: g["role"] for g in plan["gpus"]}
    assert roles == {SM120_16GB[0]: "primary", SM86_12GB[0]: "secondary"}  # the larger GPU, whatever its index
    comps = placed(plan)
    assert comps["dit-fl2va-fp8-pai8"] == 1 and comps["vae-gpu0"] == 1
    assert comps["audio-gpu1"] == comps["aenc-gpu1"] == comps["qimg-vision-gpu1"] == comps["upscale-anime4k-gpu1"] == 0
    assert "prompt-analyze-local" in plan["ready_routes"]
    rendered = rendered_ok(plan, tmp_path)
    groups = {
        c["component_id"]: c["settings"]["load"]["device"]["resource_group"]
        for c in rendered["node.json"]["components"]
    }
    assert groups["dit-fl2va-fp8-pai8"] == "gpu-0" and groups["audio-gpu1"] == "gpu-1"
    # an explicit primary wins
    forced = plan_for(fixture(SM86_12GB, SM120_16GB), tmp_path, primary_gpu="0")
    assert placed(forced)["dit-fl2va-bf16-pai8"] == 0


def test_no_gpu_sets_up_the_control_plane_only(tmp_path: Path) -> None:
    plan = plan_for(fixture(), tmp_path)
    assert plan["ok"] and plan["profile"] == "no-gpu"
    assert all(g["status"] == "disabled" for g in plan["groups"].values())
    assert plan["components"] == [] and plan["runtimes"] == [] and plan["ready_routes"] == []
    assert plan["weights"]["bytes_missing"] == 0
    rendered = rendered_ok(plan, tmp_path)
    assert [r["runtime_id"] for r in rendered["node.json"]["runtimes"]] == ["cpu"]


def test_low_disk_is_reported_and_fewer_routes_need_less(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM120_16GB, models_free_gib=100), tmp_path)
    assert plan["ok"] and not plan["weights"]["fits"]  # the install works; the download would not fit
    assert any("models directory" in w for w in plan["warnings"])
    small = plan_for(fixture(SM120_16GB, models_free_gib=100), tmp_path, routes=frozenset({"image", "upscale"}))
    assert small["weights"]["fits"] and small["groups"]["video"]["status"] == "not_requested"
    assert small["ready_routes"] == ["t2i-local", "i2i-local", "upscale-take-2x"]
    rendered_ok(small, tmp_path)


def test_host_memory_disables_or_downgrades_only_with_a_reason(tmp_path: Path) -> None:
    tight = plan_for(fixture(SM120_16GB, ram_gib=40), tmp_path)
    assert tight["groups"]["video"]["status"] == "enabled"  # FP8 DiT + AdaLN cache fit, the pinned budgets do not
    assert any("HOST_MEMORY_INSUFFICIENT" in w for w in tight["warnings"])
    stream = next(c for c in tight["components"] if c["component_id"] == "qimg-dit-bf16-stream-gpu0")
    assert stream["choices"]["pin_memory"] == "dynamic"
    small = plan_for(fixture(SM86_12GB, ram_gib=40), tmp_path)  # BF16 DiT needs ~49 GiB
    assert small["groups"]["video"]["status"] == "disabled" and small["groups"]["video"]["reasons"]
    assert small["ready_routes"][:2] == ["t2i-local", "i2i-local"]  # without video the image DiT is made ready
    rendered_ok(small, tmp_path)


def test_blocking_problems_and_sudo_commands_are_printed_not_run(tmp_path: Path) -> None:
    tools = {k: v for k, v in TOOLS.items() if k not in ("ffmpeg", "ffprobe")}
    tools["node"] = {"path": "/usr/bin/node", "version": "v20.11.0"}
    plan = plan_for(fixture(SM120_16GB, tools=tools), tmp_path)
    codes = {p["id"]: p for p in plan["problems"]}
    assert not plan["ok"] and {"MISSING_FFMPEG", "MISSING_FFPROBE", "OLD_NODE"} <= codes.keys()
    assert codes["MISSING_FFMPEG"]["needs_root"] and codes["MISSING_FFMPEG"]["fix"].startswith("sudo apt-get")
    old = plan_for(fixture(SM120_16GB, driver="550.54.14"), tmp_path)
    assert all(g["status"] == "disabled" for g in old["groups"].values())
    assert any("driver" in w for w in old["warnings"])


def test_ports_of_another_installation_block_but_our_own_do_not(tmp_path: Path) -> None:
    busy = {
        8080: {"free": False, "occupant": "controller", "occupant_id": CONTROLLER_ID},
        8081: {"free": True},
        8090: {"free": False, "occupant": "other"},
        8091: {"free": True},
    }
    plan = plan_for(fixture(SM120_16GB, ports=busy), tmp_path)
    messages = [p for p in plan["problems"] if p["id"] == "PORT_IN_USE"]
    assert len(messages) == 2 and "--controller-port 8081" in messages[0]["fix"]
    rerun = plan_for(fixture(SM120_16GB, ports=busy), tmp_path, controller_id=CONTROLLER_ID, node_port=8091)
    assert rerun["ok"] and any("already running" in n for n in rerun["notes"])


def test_nvidia_smi_parsing() -> None:
    gpus, driver = parse_smi_query(
        f"0, {gpu_uuid(1)}, NVIDIA GPU sm120, 16303, 1422, 12.0, 580.95.05\n"
        f"1, {gpu_uuid(2)}, NVIDIA unified-memory GPU, [N/A], [N/A], 12.1, 580.95.05\n"
    )
    assert driver == "580.95.05" and gpus[0].capability() == (12, 0) and not gpus[0].integrated
    assert gpus[1].integrated and gpus[1].memory_total_mib is None
    assert parse_cuda_version("| NVIDIA-SMI 580.95.05   Driver Version: 580.95.05   CUDA Version: 13.0 |") == "13.0"
    assert parse_cuda_version("| NVIDIA-SMI 615.71   KMD Version: 615.71   CUDA UMD Version: 13.4 |") == "13.4"


@pytest.mark.static
def test_planner_constants_match_the_runtime_sources() -> None:
    """The planner restates two runtime constants (the control plane never imports the runtimes)."""
    backend = (REPO / "runtimes/h3/src/phasyn_h3/recipe/runtime/backend.py").read_text(encoding="utf-8")
    assert re.search(r"^H3_DIT_BF16_DEVICE_BYTES = 40 \* 10\*\*9$", backend, re.M)
    assert planner.H3_DIT_BF16_BYTES == 40 * 10**9
    accel = (REPO / "runtimes/h3/src/phasyn_h3/recipe/runtime/acceleration.py").read_text(encoding="utf-8")
    assert f"FP8_W8A8_MIN_CAPABILITY = {planner.FP8_MIN_CAPABILITY}" in accel


def test_aarch64_unified_memory_gpu_runs_video_on_the_sm121_runtime(tmp_path: Path) -> None:
    plan = plan_for(fixture(UMA_SM121, ram_gib=119, arch="aarch64"), tmp_path)
    assert plan["ok"] and plan["profile"] == "uma"
    assert plan["gpus"][0]["role"] == "primary" and plan["gpus"][0]["unified_memory"]
    assert [r["runtime_id"] for r in plan["runtimes"]] == ["aarch64-sm121"]
    comps = {c["component_id"]: c for c in plan["components"]}
    assert {"te-uma0", "dit-fl2va-fp8-pai8-uma", "dit-ref2va-fp8-pai8-uma", "vae-uma0", "audio-uma0"} <= comps.keys()
    assert comps["dit-fl2va-fp8-pai8-uma"]["source"] == "dit-fl2va-fp8-pai8"  # the x86_64 template, runtime changed
    image = plan["groups"]["image"]
    assert image["status"] == "disabled" and "qimg-x86_64" in image["reasons"][0]
    assert plan["groups"]["vision"]["status"] == "enabled" and "prompt-analyze-local" in plan["standby_routes"]
    assert plan["ready_routes"] == ["t2va-local", "fl2va-local", "upscale-take-2x"]
    assert any("no unified-memory template" in w for w in plan["warnings"])  # said, not hidden
    assert "/aarch64-sm121/" in plan["sidecars"][0]["command"][0]
    rendered = rendered_ok(plan, tmp_path)
    for comp in rendered["node.json"]["components"]:
        if comp["settings"]["load"]["device"]["kind"] == "cuda":
            assert comp["runtime_id"] == "aarch64-sm121"
            assert comp["settings"]["load"]["device"]["resource_group"] == "gpu-uma"
    dit = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "dit-fl2va-fp8-pai8-uma")
    assert dit["settings"]["load"]["precision"]["quantization"]["scheme"] == "fp8_e4m3"
    te = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "te-uma0")
    assert te["settings"]["load"]["offload"]["mode"] == "none"  # examples/components/te-uma0.json as it is
    compile_ = next(c for c in rendered["node.json"]["components"] if c["component_id"] == "prompt-compile")
    assert compile_["runtime_id"] == "aarch64-sm121"
    steps = {s["component_id"] for s in rendered["pipelines"]["t2va-local"]["steps"]}
    assert steps == {"te-uma0", "dit-fl2va-fp8-pai8-uma", "vae-uma0", "audio-uma0", "mux"}
    small = plan_for(fixture(UMA_SM121, ram_gib=64, arch="aarch64"), tmp_path)
    assert (
        small["groups"]["video"]["status"] == "disabled" and "unified memory" in small["groups"]["video"]["reasons"][0]
    )
    other = plan_for(fixture(("NVIDIA GPU sm90 96 GB", 97871, "9.0"), arch="aarch64"), tmp_path)
    assert other["profile"] == "no-gpu" and "aarch64-sm121" in other["gpus"][0]["reason"]


def test_same_size_gpus_prefer_the_fp8_capable_one(tmp_path: Path) -> None:
    older = ("NVIDIA GPU sm86 24 GB", 24576, "8.6")  # a few MiB more than the newer card
    plan = plan_for(fixture(older, SM89_24GB, ram_gib=128), tmp_path)
    assert {g["name"]: g["role"] for g in plan["gpus"]}[SM89_24GB[0]] == "primary"
    assert "dit-fl2va-fp8-pai8" in placed(plan)


def _installed(plan: dict[str, Any], tmp_path: Path) -> dict[str, Any]:
    rendered = configgen.render_all(plan, planner.Templates(REPO), configgen.Ids(CONTROLLER_ID, NODE_A_ID))
    for pid, doc in rendered["pipelines"].items():
        configgen.write_json(Path(plan["config_dir"]) / "pipelines" / f"{pid}.json", doc, reconfigure=True)
    return rendered


def test_a_group_means_the_routes_of_one_dit(tmp_path: Path) -> None:
    plan = plan_for(fixture(SM120_16GB), tmp_path)
    _installed(plan, tmp_path)
    assert install.resolve_routes("video", plan) == ["t2va-local", "fl2va-local"]
    assert install.resolve_routes("ref2va-local", plan) == ["ref2va-local"]
    with pytest.raises(install.StepError, match="different DiTs"):
        install.resolve_routes("video,ref2va-local", plan)
    with pytest.raises(install.StepError, match="different DiTs"):
        install.resolve_routes("video,image", plan)


def test_units_of_another_installation_are_never_taken_over(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    plan = plan_for(fixture(SM120_16GB), tmp_path)
    assert install.unit_conflicts(plan) == []
    units = tmp_path / "xdg" / "systemd" / "user"
    units.mkdir(parents=True)
    node = plan["services"]["node"]
    other = tmp_path / "other install" / "node 100%.json"  # quoting and specifiers survive the round trip
    (units / node["unit"]).write_text(
        service.unit_text("node", "main", other, python_bin=Path("/venv/bin/python")), encoding="utf-8"
    )
    assert install.unit_config(units / node["unit"]) == str(other)
    problems = install.unit_conflicts(plan)
    assert [p["id"] for p in problems] == ["UNIT_IN_USE"] and "--instance" in problems[0]["fix"]
    (units / node["unit"]).write_text(
        service.unit_text("node", "main", Path(node["config"]), python_bin=Path("/venv/bin/python")), encoding="utf-8"
    )
    assert install.unit_conflicts(plan) == []  # our own unit: a re-run may refresh it
