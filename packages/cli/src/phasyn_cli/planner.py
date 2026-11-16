"""Deployment plan for one machine: which routes and components run on which GPU (``phasyn-studio install``).

The plan is a pure function of the detected machine (:mod:`.machine`), the options and the repository's own templates:
every component definition comes from ``examples/components/`` or ``deploy/config/node-a.example.json`` (a BF16 DiT
for GPUs without FP8 comes from ``examples/generate_dit_components.py``), every pipeline from ``examples/pipelines/``,
and weight sizes from the pinned weight manifests of the runtimes. The planner only chooses between those existing
definitions and places them on GPUs; it never invents a model setting: nothing is changed silently, and every choice
carries its reason.

The thresholds below are planning rules, not measurements. Each is listed in the plan's ``rules`` with its basis, so a
reader can see why a route was placed, changed or left out.
"""

from __future__ import annotations

import importlib.util
import json
import os
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import cached_property
from pathlib import Path
from typing import Any

from .machine import Gpu, Machine, version_tuple

PLAN_SCHEMA = "phasyn-studio.install-plan/1"
GIB = 1024**3
GB = 10**9

# ---------------------------------------------------------------------- requirements (README, docs/install.md)
NODE_MIN = (22, 22, 2)
PNPM_MIN_MAJOR = 9  # the lockfile format; CI uses pnpm 12 (package.json packageManager)
DRIVER_MIN_MAJOR = 580  # CUDA 13.0 wheels
X86_CAPABILITY_RANGE = ((8, 6), (12, 0))  # the x86_64 GPU environments target sm86 … sm120
UMA_CAPABILITY = (12, 1)  # aarch64-sm121
FP8_MIN_CAPABILITY = (8, 9)  # runtimes/h3 recipe/runtime/acceleration.py FP8_W8A8_MIN_CAPABILITY
# runtimes/h3 recipe/runtime/backend.py H3_DIT_BF16_DEVICE_BYTES: the native BF16 H3 DiT without AdaLN projections.
# Block offload keeps it in host memory; the FP8 DiT is quantized layer by layer to half of it.
H3_DIT_BF16_BYTES = 40 * GB
H3_DIT_FP8_BYTES = H3_DIT_BF16_BYTES // 2

# ---------------------------------------------------------------------- planning rules (heuristics, see RULES)
VIDEO_MIN_VRAM_GIB = 10
VIDEO_VAE_RESIDENT_MIN_VRAM_GIB = 16
IMAGE_MIN_VRAM_GIB = 8
IMAGE_TESTED_VRAM_GIB = 12
IMAGE_PHASE_MIN_VRAM_GIB = 24
VISION_MIN_VRAM_GIB = 12
HOST_RESERVE_BYTES = 4 * GIB
WEIGHTS_FREE_MARGIN = 1 * GIB  # the Node keeps 1 GiB free when it downloads
DATA_MIN_FREE = 20 * GIB

RULES: tuple[dict[str, str], ...] = (
    {
        "id": "gpu-eligible",
        "rule": "x86_64 GPUs with compute capability 8.6 to 12.0 and dedicated memory are used",
        "basis": "README and docs/install.md: the x86_64 GPU environments target sm86 … sm120",
    },
    {
        "id": "gpu-primary",
        "rule": "the GPU with the most memory (then the newest generation) is the primary GPU: text encoder, DiT, "
        "video VAE, Qwen-Image",
        "basis": "deploy/config/node-a.example.json layout (GPU 0)",
    },
    {
        "id": "gpu-secondary",
        "rule": "a second GPU takes the audio VAE, image vision and the upscaler; without one they share the primary GPU",
        "basis": "deploy/config/node-a.example.json layout (GPU 1); with one GPU the gpu1 templates get the main GPU",
    },
    {
        "id": "dit-precision",
        "rule": "FP8 DiT (fp8_e4m3, PAI 8 steps) on compute capability >= 8.9; BF16 DiT with the same LoRA below",
        "basis": "docs/install.md (FP8 needs compute capability 8.9; BF16 runs on every supported GPU)",
    },
    {
        "id": "video-vram",
        "rule": f"video needs a primary GPU of at least {VIDEO_MIN_VRAM_GIB} GB; below "
        f"{VIDEO_VAE_RESIDENT_MIN_VRAM_GIB} GB the video VAE decoder streams its weights (vae-gpu1-fp32-stream, "
        "bit-identical) instead of moving the 9.7 GB decoder to the GPU",
        "basis": "planner rule: the example decoder moves 9.7 GB of FP32 weights to the GPU per decode "
        "(vae-gpu0); no smaller configuration is tested",
    },
    {
        "id": "video-host-memory",
        "rule": "host RAM must hold the block-offloaded DiT (BF16 40 GB, FP8 20 GB) plus the AdaLN host cache; the "
        "pinned budgets of the text encoder and video VAE come on top",
        "basis": "H3_DIT_BF16_DEVICE_BYTES, the templates' max_pinned_bytes and adaln.host_cache_bytes, "
        "README (plan host RAM above the size of the video model)",
    },
    {
        "id": "image-placement",
        "rule": f"Qwen-Image DiT 'phase' on GPUs of {IMAGE_PHASE_MIN_VRAM_GIB} GB or more, 'group_stream' below; "
        f"image routes need {IMAGE_MIN_VRAM_GIB} GB and are untested below {IMAGE_TESTED_VRAM_GIB} GB",
        "basis": "the qimg-dit-* templates (phase needs the whole 13.3 GB BF16 transformer plus reserve; on 16 GB "
        "use group_stream)",
    },
    {
        "id": "image-host-memory",
        "rule": "group_stream with pin_memory 'static' needs the checkpoint twice in host RAM plus the text encoder; "
        "otherwise pin_memory 'dynamic' is used",
        "basis": "the Qwen-Image DiT's HOST_MEMORY_INSUFFICIENT check (pin_memory 'dynamic' keeps no static copy)",
    },
    {
        "id": "vision-vram",
        "rule": f"Qwen3-VL-4B image vision needs a GPU of at least {VISION_MIN_VRAM_GIB} GB (8.3 GB BF16 weights, "
        "no offload, 2 GB reserves); the second GPU is preferred",
        "basis": "examples/components/qimg-vision-gpu*.json (offload none, reserve and activation reserve 1 GiB each)",
    },
    {
        "id": "unified-memory",
        "rule": "an aarch64 sm121 unified-memory GPU runs the H3 routes on the aarch64-sm121 runtime: te-uma0 and "
        "qimg-vision-uma0 from their templates; the DiTs, VAEs and upscaler from the x86_64 templates with only the "
        "runtime and device changed; host RAM is the shared pool; Qwen-Image generation is not available there",
        "basis": "deploy/config/node-b.example.json, examples/components/*-uma0.json, deploy/runtimes/ (the "
        "Qwen-Image VAE and DiT need the Diffusers build of qimg-x86_64)",
    },
    {
        "id": "one-dit",
        "rule": "a Node keeps one DiT loaded (exclusive group 'dit'): the routes made ready are those of one DiT; "
        "the others stay on standby",
        "basis": "exclusive_group 'dit' of the DiT templates",
    },
)

GROUPS = ("video", "image", "vision", "upscale")
GROUP_PIPELINES: Mapping[str, tuple[str, ...]] = {
    "video": ("t2va-local", "fl2va-local", "ref2va-local"),
    "image": ("t2i-local", "i2i-local"),
    "vision": ("prompt-analyze-local", "prompt-compare-local", "prompt-pairwise-local", "prompt-revise-local"),
    "upscale": ("upscale-take-2x",),
}
# the routes `up` makes ready by default: the ones served by one DiT, plus routes that hold no DiT
READY_ROUTES: Mapping[str, tuple[str, ...]] = {
    "video": ("t2va-local", "fl2va-local"),
    "image": ("t2i-local", "i2i-local"),
    "vision": GROUP_PIPELINES["vision"],
    "upscale": ("upscale-take-2x",),
}
GROUP_RUNTIME = {"video": "x86_64", "image": "qimg-x86_64", "vision": "qimg-x86_64", "upscale": "x86_64"}
CPU_QIMG_COMPONENTS = {"image": ("qimg-prepare", "image-compose"), "vision": ("prompt-compile", "prompt-score")}
TEMPLATE_NODE_ID = "00000000-0000-4000-8000-0000000000a1"
TEMPLATE_MODELS = "/path/to/models"
UMA_RUNTIME = "aarch64-sm121"
RUNTIME_DIRS = {"x86_64": "x86_64", "qimg-x86_64": "qimg-x86_64", UMA_RUNTIME: UMA_RUNTIME}
H3_RUNTIMES = ("x86_64", UMA_RUNTIME)  # the tuples with phasyn-h3 (importcheck and the sidecar tool)

LICENSES: Mapping[str, dict[str, str]] = {
    "minimax-h3": {
        "name": "MiniMax H3 Community License",
        "url": "https://huggingface.co/MiniMaxAI/MiniMax-H3",
        "note": "Use of the model and its outputs is licensed only outside the European Union, the United Kingdom, "
        "the Republic of Korea and the United States (§V.4); outputs may be used to improve only MiniMax H3 and its "
        "derivatives (§V.3); the Acceptable Use Policy applies",
    },
    "alibaba-pai-acc": {
        "name": "MiniMax H3 Community License",
        "url": "https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs",
        "note": "Acceleration LoRAs, Model Derivatives of MiniMax-H3: the same territory and use restrictions apply",
    },
    "qwen-image-2.1": {
        "name": "Qwen Research License",
        "url": "https://huggingface.co/Qwen/Qwen-Image-2.1",
        "note": "Non-commercial use only (research and evaluation)",
    },
    "qwen3-vl-4b-instruct": {
        "name": "Apache-2.0",
        "url": "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct",
        "note": "",
    },
}


# ---------------------------------------------------------------------- inputs
@dataclass(frozen=True)
class Options:
    repo_dir: Path
    data_dir: Path
    models_dir: Path
    controller_port: int = 8080
    node_port: int = 8090
    routes: frozenset[str] | None = None  # requested groups; None = every group this machine can run
    primary_gpu: str | None = None  # GPU index or UUID that overrides the primary choice
    instance: str = "main"
    service_mode: str = "auto"  # auto | systemd | foreground
    controller_id: str | None = None  # ids of an existing installation (kept on re-runs)
    node_id: str | None = None

    @property
    def config_dir(self) -> Path:
        return self.data_dir / "config"


@dataclass
class Templates:
    """The repository files the plan is built from (read lazily, read-only)."""

    repo_dir: Path
    _cache: dict[str, Any] = field(default_factory=dict)

    def _json(self, relative: str) -> Any:
        if relative not in self._cache:
            self._cache[relative] = json.loads((self.repo_dir / relative).read_text(encoding="utf-8"))
        return self._cache[relative]

    def controller(self) -> dict[str, Any]:
        doc: dict[str, Any] = self._json("deploy/config/controller.example.json")
        return doc

    def node(self) -> dict[str, Any]:
        doc: dict[str, Any] = self._json("deploy/config/node-a.example.json")
        return doc

    def component(self, component_id: str) -> dict[str, Any]:
        doc: dict[str, Any] = self._json(f"examples/components/{component_id}.json")
        return doc

    def pipeline(self, pipeline_id: str) -> dict[str, Any]:
        doc: dict[str, Any] = self._json(f"examples/pipelines/{pipeline_id}.json")
        return doc

    def weight_manifest(self, name: str) -> dict[str, Any]:
        path = {
            "minimax-h3": "runtimes/h3/src/phasyn_h3/weight_manifests/minimax-h3.json",
            "qwen-image-2.1": "runtimes/qimg/src/phasyn_qimg/weight_manifests/qwen-image-2.1.json",
            "qwen3-vl-4b-instruct": "runtimes/qimg/src/phasyn_qimg/weight_manifests/qwen3-vl-4b-instruct.json",
        }[name]
        doc: dict[str, Any] = self._json(path)
        return doc

    def lora_manifest(self, name: str) -> dict[str, Any]:
        doc: dict[str, Any] = self._json(f"runtimes/h3/src/phasyn_h3/loras/{name}")
        return doc

    @cached_property
    def dit_generator(self) -> Callable[..., dict[str, Any]]:
        """``definition()`` of ``examples/generate_dit_components.py`` (standard library only)."""
        path = self.repo_dir / "examples" / "generate_dit_components.py"
        spec = importlib.util.spec_from_file_location("phasyn_examples_generate_dit_components", path)
        if spec is None or spec.loader is None:
            raise FileNotFoundError(path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        definition: Callable[..., dict[str, Any]] = module.definition
        return definition


def vram_gib(gpu: Gpu) -> int:
    """The GPU's memory class in GB (16303 MiB → 16, 12288 MiB → 12); 0 for unified memory."""
    return round((gpu.memory_total_mib or 0) / 1024)


def gib(value: int | float | None) -> float | None:
    return None if value is None else round(value / GIB, 1)


# ---------------------------------------------------------------------- prerequisites
def _package_hint(machine: Machine, package: str) -> str:
    family = {machine.distro_id or "", *machine.distro_like}
    if family & {"debian", "ubuntu"}:
        return f"sudo apt-get install -y {package}"
    if family & {"fedora", "rhel", "centos"}:
        return f"sudo dnf install -y {package}" + (" (FFmpeg comes from RPM Fusion)" if package == "ffmpeg" else "")
    if family & {"arch"}:
        return f"sudo pacman -S --needed {package}"
    if family & {"suse", "opensuse"}:
        return f"sudo zypper install -y {package}"
    return f"install {package} with your distribution's package manager (needs root)"


def prerequisites(machine: Machine) -> tuple[list[dict[str, Any]], list[str]]:
    """Blocking problems (each with a fix) and warnings for the software the install needs."""
    problems: list[dict[str, Any]] = []
    warnings: list[str] = []

    def problem(code: str, message: str, fix: str, *, sudo: bool = False) -> None:
        problems.append({"id": code, "message": message, "fix": fix, "needs_root": sudo})

    if machine.os != "Linux":
        problem(
            "UNSUPPORTED_OS", f"{machine.os} is not supported; Phasyn Studio runs on Linux only", "use a Linux host"
        )
    if machine.arch not in ("x86_64", "aarch64"):
        problem("UNSUPPORTED_ARCH", f"architecture {machine.arch} is not supported", "use an x86_64 or aarch64 host")
    if machine.tool("uv").path is None:
        problem("MISSING_UV", "uv is not on PATH", "curl -LsSf https://astral.sh/uv/install.sh | sh  (no root needed)")
    if machine.tool("git").path is None:
        problem("MISSING_GIT", "git is not on PATH", _package_hint(machine, "git"), sudo=True)
    node = machine.tool("node")
    node_version = version_tuple(node.version)
    if node.path is None:
        problem(
            "MISSING_NODE",
            "Node.js is not on PATH",
            "install Node.js 22.22.2 or newer (https://nodejs.org, your distribution or a version manager)",
        )
    elif node_version is None or node_version < NODE_MIN:
        problem(
            "OLD_NODE",
            f"Node.js {node.version or '(unknown version)'} is older than 22.22.2",
            "install Node.js 22.22.2 or newer (https://nodejs.org, your distribution or a version manager)",
        )
    pnpm = machine.tool("pnpm")
    pnpm_version = version_tuple(pnpm.version)
    if pnpm.path is None:
        problem(
            "MISSING_PNPM",
            "pnpm is not on PATH",
            "corepack enable pnpm  (prefix with sudo only if Node.js was installed system-wide), "
            "or: npm install -g pnpm@12",
        )
    elif pnpm_version is None or pnpm_version[0] < PNPM_MIN_MAJOR:
        problem("OLD_PNPM", f"pnpm {pnpm.version} is too old (9 or newer; 12 is tested)", "npm install -g pnpm@12")
    for tool in ("ffmpeg", "ffprobe"):
        if machine.tool(tool).path is None:
            problem(f"MISSING_{tool.upper()}", f"{tool} is not on PATH", _package_hint(machine, "ffmpeg"), sudo=True)
    if not machine.systemd_user:
        warnings.append(
            "no systemd user session: services cannot be installed; `phasyn-studio up --foreground` runs them in "
            "this terminal"
        )
    return problems, warnings


# ---------------------------------------------------------------------- GPUs
def _eligible(machine: Machine, gpu: Gpu) -> str | None:
    """None when the GPU can be used, otherwise why not."""
    cap = gpu.capability()
    if machine.arch == "aarch64":
        if cap == UMA_CAPABILITY or (cap is None and gpu.integrated):
            return None
        return (
            f"on aarch64 only the sm121 unified-memory GPU has a runtime (aarch64-sm121); this one reports compute "
            f"capability {gpu.compute_capability or 'unknown'}"
        )
    if gpu.integrated:
        return "no dedicated GPU memory reported"
    if cap is None:
        return None  # unknown generation: used, with the most conservative precision (BF16)
    low, high = X86_CAPABILITY_RANGE
    if not low <= cap <= high:
        return f"compute capability {gpu.compute_capability} is outside sm86 … sm120"
    return None


def assign_gpus(machine: Machine, override: str | None) -> tuple[Gpu | None, Gpu | None, list[dict[str, Any]], str]:
    """(primary, secondary, per-GPU report, profile)."""
    report: list[dict[str, Any]] = []
    usable: list[Gpu] = []
    for gpu in machine.gpus:
        reason = _eligible(machine, gpu)
        if reason is None:
            usable.append(gpu)
        report.append(
            {
                "index": gpu.index,
                "uuid": gpu.uuid,
                "name": gpu.name,
                "vram_gib": None if gpu.integrated else vram_gib(gpu),
                "unified_memory": gpu.integrated or machine.arch == "aarch64",
                "memory_total_mib": gpu.memory_total_mib,
                "memory_used_mib": gpu.memory_used_mib,
                "compute_capability": gpu.compute_capability,
                "role": "unused",
                "reason": reason,
            }
        )
    # by memory class (24564 and 24576 MiB are both 24 GB), then FP8 capability, then generation
    usable.sort(
        key=lambda g: (vram_gib(g), (g.capability() or (0, 0)) >= FP8_MIN_CAPABILITY, g.capability() or (0, 0)),
        reverse=True,
    )
    if override is not None:
        chosen = [g for g in usable if override in (str(g.index), g.uuid)]
        if chosen:
            usable.remove(chosen[0])
            usable.insert(0, chosen[0])
    primary = usable[0] if usable else None
    secondary = usable[1] if len(usable) > 1 and machine.arch != "aarch64" else None
    uma = machine.arch == "aarch64"
    for entry in report:
        entry["resource_group"] = None
        if primary is not None and entry["uuid"] == primary.uuid:
            entry["role"] = "primary"
            entry["resource_group"] = "gpu-uma" if uma else "gpu-0"
        elif secondary is not None and entry["uuid"] == secondary.uuid:
            entry["role"] = "secondary"
            entry["resource_group"] = "gpu-1"
        elif entry["reason"] is None:
            entry["reason"] = "one Node uses at most two GPUs in this plan; add components by hand to use it"
    if machine.arch == "aarch64" and primary is not None:
        profile = "uma"
    elif primary is None:
        profile = "no-gpu"
    else:
        profile = "dual-gpu" if secondary is not None else "single-gpu"
    return primary, secondary, report, profile


def driver_problem(machine: Machine) -> str | None:
    if not machine.gpus:
        return None
    version = version_tuple(machine.driver_version)
    if version is None:
        return "the NVIDIA driver version could not be read"
    if version[0] < DRIVER_MIN_MAJOR:
        return f"NVIDIA driver {machine.driver_version} is older than R{DRIVER_MIN_MAJOR} (CUDA 13.0)"
    return None


# ---------------------------------------------------------------------- weights
def _present(models_dir: Path, relative: str, size: int) -> bool:
    try:
        return (models_dir / relative).stat().st_size == size
    except OSError:
        return False


def weight_sets(templates: Templates, groups: Iterable[str], models_dir: Path) -> list[dict[str, Any]]:
    """What the enabled groups download (pinned manifests), and how much of it is still missing."""
    wanted = set(groups)
    sets: list[dict[str, Any]] = []

    def add(
        set_id: str, label: str, repo: str, revision: str, files: Sequence[tuple[str, int, str]], used_by: str
    ) -> None:
        seen: set[str] = set()
        total = missing = 0
        for relative, size, key in files:
            if key in seen:  # identical file of the other H3 variant: hard-linked, not downloaded twice
                continue
            seen.add(key)
            total += size
            if not _present(models_dir, relative, size):
                missing += size
        sets.append(
            {
                "set_id": set_id,
                "label": label,
                "repo": repo,
                "revision": revision,
                "license": LICENSES[set_id.split(":", maxsplit=1)[0]],
                "bytes_total": total,
                "bytes_missing": missing,
                "used_by": used_by,
            }
        )

    if "video" in wanted:
        h3 = templates.weight_manifest("minimax-h3")
        files = [
            (f"MiniMax-H3/{f['path']}", int(f["size"]), str(f.get("sha256") or f.get("git_oid") or f["path"]))
            for f in h3["files"]
        ]
        add("minimax-h3", "MiniMax-H3 FL2VA and Ref2VA", h3["repo"], h3["revision"], files, "video")
        for name in ("pai-h3-fl2va-acc8.json", "pai-h3-ref2va-acc8.json"):
            lora = templates.lora_manifest(name)
            item = lora["file"]
            add(
                f"alibaba-pai-acc:{lora['lora_id']}",
                str(lora["lora_id"]),
                lora["source_repo"],
                lora["source_revision"],
                [(item["relative_path"], int(item["size_bytes"]), item["sha256"])],
                "video",
            )
    if "image" in wanted:
        qimg = templates.weight_manifest("qwen-image-2.1")
        files = [(f"qwen-image-2.1/{f['path']}", int(f["size"]), f["path"]) for f in qimg["files"]]
        add("qwen-image-2.1", "Qwen-Image 2.1", qimg["repo"], qimg["revision"], files, "image")
    if "vision" in wanted:
        vl = templates.weight_manifest("qwen3-vl-4b-instruct")
        files = [(f"Qwen3-VL-4B-Instruct/{f['path']}", int(f["size"]), f["path"]) for f in vl["files"]]
        add("qwen3-vl-4b-instruct", "Qwen3-VL-4B-Instruct", vl["repo"], vl["revision"], files, "vision")
    return sets


def _manifest_bytes(templates: Templates, name: str, prefix: str) -> int:
    return sum(int(f["size"]) for f in templates.weight_manifest(name)["files"] if f["path"].startswith(prefix))


# ---------------------------------------------------------------------- the plan
@dataclass
class _Group:
    name: str
    status: str = "enabled"  # enabled | disabled | not_requested
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    components: list[dict[str, Any]] = field(default_factory=list)
    renames: dict[str, str] = field(default_factory=dict)

    def disable(self, reason: str) -> None:
        self.status = "disabled"
        self.reasons.append(reason)

    def place(
        self,
        template: str,
        gpu: Gpu | None,
        *,
        why: str,
        component_id: str | None = None,
        source: str | None = None,
        runtime_id: str | None = None,
        **choices: Any,
    ) -> None:
        """``template``: the component the example pipelines name; ``source``: the examples/components file the
        definition is read from (default: the component id); ``runtime_id``: replaces the template's runtime."""
        self.components.append(
            {
                "component_id": component_id or template,
                "template": template,
                "source": source or component_id or template,
                "runtime_id": runtime_id,
                "gpu_uuid": None if gpu is None else gpu.uuid,
                "gpu_index": None if gpu is None else gpu.index,
                "why": why,
                "choices": choices,
            }
        )
        if component_id and component_id != template:
            self.renames[template] = component_id


def _video(group: _Group, machine: Machine, primary: Gpu, secondary: Gpu | None) -> None:
    size = vram_gib(primary)
    if size < VIDEO_MIN_VRAM_GIB:
        group.disable(f"the primary GPU has {size} GB; video needs at least {VIDEO_MIN_VRAM_GIB} GB (rule video-vram)")
        return
    cap = primary.capability()
    fp8 = cap is not None and cap >= FP8_MIN_CAPABILITY
    dit_bytes = H3_DIT_FP8_BYTES if fp8 else H3_DIT_BF16_BYTES
    adaln = 8 * GIB  # adaln.host_cache_bytes of the DiT templates
    resident_vae = size >= VIDEO_VAE_RESIDENT_MIN_VRAM_GIB
    pinned = 4 * GIB + (11 * GIB if resident_vae else 0)  # te-gpu0 and vae-gpu0 max_pinned_bytes
    ram = machine.ram_total_bytes or 0
    floor = dit_bytes + adaln + HOST_RESERVE_BYTES
    if ram and ram < floor:
        group.disable(
            f"host RAM {gib(ram)} GiB is below what the {'FP8' if fp8 else 'BF16'} DiT holds in host memory "
            f"(~{gib(floor)} GiB with the AdaLN cache; rule video-host-memory)"
        )
        return
    if ram and ram < floor + pinned:
        group.warnings.append(
            f"host RAM {gib(ram)} GiB is below the ~{gib(floor + pinned)} GiB the video components may pin together; "
            "a load can fail with HOST_MEMORY_INSUFFICIENT or HOST_OOM"
        )
    if size < VIDEO_VAE_RESIDENT_MIN_VRAM_GIB:
        group.warnings.append(
            f"a {size} GB primary GPU is below the {VIDEO_VAE_RESIDENT_MIN_VRAM_GIB} GB class the example layout is run "
            "on: video on it is untested"
        )
    side = secondary or primary
    group.place("te-gpu0", primary, why="text encoder, block offload (weights dropped after use)")
    group.place("venc-gpu0", primary, why="video VAE encoder (0.7 GB, moved to the GPU per call)")
    group.place("aenc-gpu1", side, why="audio VAE encoder" + ("" if secondary else " (single GPU: shares the primary)"))
    for variant in ("fl2va", "ref2va"):
        if fp8:
            group.place(
                f"dit-{variant}-fp8-pai8",
                primary,
                why=f"{variant} DiT, FP8 (compute capability {primary.compute_capability} >= 8.9), PAI 8 steps, "
                "block offload",
                precision="fp8",
            )
        else:
            group.place(
                f"dit-{variant}-fp8-pai8",
                primary,
                component_id=f"dit-{variant}-bf16-pai8",
                why=f"{variant} DiT, BF16 (compute capability {primary.compute_capability or 'unknown'} has no FP8), "
                "PAI 8 steps, block offload",
                precision="bf16",
                generated=True,
            )
    if resident_vae:
        group.place("vae-gpu0", primary, why="video VAE decoder, 9.7 GB FP32 moved to the GPU per decode")
    else:
        group.place(
            "vae-gpu0",
            side,
            component_id="vae-gpu1-fp32-stream",
            why="video VAE decoder with FP32 weight streaming (~2 GB on the GPU, bit-identical to vae-gpu0)",
        )
    group.place(
        "audio-gpu1", side, why="audio VAE decoder" + ("" if secondary else " (single GPU: shares the primary)")
    )
    if secondary is None:
        group.warnings.append("single GPU: the audio VAE shares the primary GPU with the DiT")


def _image(group: _Group, machine: Machine, templates: Templates, primary: Gpu) -> None:
    size = vram_gib(primary)
    if size < IMAGE_MIN_VRAM_GIB:
        group.disable(f"the primary GPU has {size} GB; image routes need at least {IMAGE_MIN_VRAM_GIB} GB")
        return
    if size < IMAGE_TESTED_VRAM_GIB:
        group.warnings.append(
            f"Qwen-Image on a {size} GB GPU is untested; the memory pre-check refuses what does not fit"
        )
    transformer = _manifest_bytes(templates, "qwen-image-2.1", "transformer/")
    encoder = _manifest_bytes(templates, "qwen-image-2.1", "text_encoder/")
    ram = machine.ram_total_bytes or 0
    floor = encoder + transformer + HOST_RESERVE_BYTES
    if ram and ram < floor:
        group.disable(f"host RAM {gib(ram)} GiB is below the ~{gib(floor)} GiB the image text encoder and DiT hold")
        return
    group.place("qimg-te-gpu0", primary, why="Qwen-Image text encoder, sequential offload (weights stay in host RAM)")
    if size >= IMAGE_PHASE_MIN_VRAM_GIB:
        group.place(
            "qimg-dit-bf16-phase-gpu0",
            primary,
            why=f"Qwen-Image DiT 'phase': the whole {gib(transformer)} GiB transformer moves to the {size} GB GPU per call",
        )
    else:
        pin = "static" if not ram or ram >= floor + transformer else "dynamic"
        why = (
            f"Qwen-Image DiT 'group_stream' (a {size} GB GPU is too small for 'phase' next to the text encoder and VAE)"
        )
        if pin == "dynamic":
            group.warnings.append(
                f"host RAM {gib(ram)} GiB cannot hold a static pinned copy of the DiT: pin_memory 'dynamic' is used"
            )
        group.place(
            "qimg-dit-bf16-phase-gpu0",
            primary,
            component_id="qimg-dit-bf16-stream-gpu0",
            why=why,
            pin_memory=pin,
        )
    group.place("qimg-vae-gpu0", primary, why="Qwen-Image VAE decoder (full decode by default)")
    group.place("qimg-venc-gpu0", primary, why="Qwen-Image VAE encoder for reference images")


def _vision(group: _Group, primary: Gpu, secondary: Gpu | None) -> None:
    if secondary is not None and vram_gib(secondary) >= VISION_MIN_VRAM_GIB:
        group.place("qimg-vision-gpu1", secondary, why="Qwen3-VL-4B image vision on the second GPU")
        return
    if vram_gib(primary) >= VISION_MIN_VRAM_GIB:
        group.place(
            "qimg-vision-gpu1",
            primary,
            component_id="qimg-vision-gpu0",
            why="Qwen3-VL-4B image vision on the primary GPU",
        )
        group.warnings.append(
            "image vision shares the primary GPU: it does not fit next to a loaded DiT (its capacity check refuses)"
        )
        return
    group.disable(f"no GPU with at least {VISION_MIN_VRAM_GIB} GB for Qwen3-VL-4B")


def _upscale(group: _Group, primary: Gpu, secondary: Gpu | None) -> None:
    gpu = secondary or primary
    group.place("upscale-anime4k-gpu1", gpu, why="Anime4K 2x video upscaler (weights built in, 1 GiB CUDA cap)")


UMA_UNTEMPLATED = (
    "{ids} have no unified-memory template in examples/: they use the x86_64 templates' settings unchanged on the "
    "aarch64-sm121 runtime"
)


def _video_uma(group: _Group, machine: Machine, templates: Templates, gpu: Gpu) -> None:
    """H3 video on one unified-memory GPU: GPU and CPU share host RAM, so every resident model counts against it."""
    encoder = _manifest_bytes(templates, "minimax-h3", "FL2VA/text_encoder/")  # te-uma0 keeps it resident
    adaln = 8 * GIB
    ram = machine.ram_total_bytes or 0
    floor = encoder + H3_DIT_FP8_BYTES + adaln + HOST_RESERVE_BYTES
    if ram and ram < floor:
        group.disable(
            f"unified memory {gib(ram)} GiB is below the ~{gib(floor)} GiB the resident text encoder and the FP8 DiT "
            "with its AdaLN cache hold (rule unified-memory)"
        )
        return
    if ram and ram < floor + 11 * GIB:
        group.warnings.append(
            f"unified memory {gib(ram)} GiB is below the ~{gib(floor + 11 * GIB)} GiB with the video decoder's pinned "
            "copy; a load can fail with HOST_MEMORY_INSUFFICIENT or HOST_OOM"
        )
    rt = UMA_RUNTIME
    group.place("te-gpu0", gpu, component_id="te-uma0", why="H3 text encoder resident on the unified-memory GPU")
    group.place("venc-gpu0", gpu, component_id="venc-uma0", source="venc-gpu0", runtime_id=rt, why="video VAE encoder")
    group.place("aenc-gpu1", gpu, component_id="aenc-uma0", source="aenc-gpu1", runtime_id=rt, why="audio VAE encoder")
    for variant in ("fl2va", "ref2va"):
        group.place(
            f"dit-{variant}-fp8-pai8",
            gpu,
            component_id=f"dit-{variant}-fp8-pai8-uma",
            source=f"dit-{variant}-fp8-pai8",
            runtime_id=rt,
            why=f"{variant} DiT, FP8 (compute capability {gpu.compute_capability or '12.1'}), PAI 8 steps, block offload",
            precision="fp8",
        )
    group.place("vae-gpu0", gpu, component_id="vae-uma0", source="vae-gpu0", runtime_id=rt, why="video VAE decoder")
    group.place(
        "audio-gpu1", gpu, component_id="audio-uma0", source="audio-gpu1", runtime_id=rt, why="audio VAE decoder"
    )
    group.warnings.append(
        UMA_UNTEMPLATED.format(ids="dit-fl2va-fp8-pai8-uma, dit-ref2va-fp8-pai8-uma, vae-uma0")
        + " (only the runtime and the device differ)"
    )
    group.warnings.append(
        UMA_UNTEMPLATED.format(ids="venc-uma0, aenc-uma0, audio-uma0")
        + "; the example configuration places these on a discrete GPU, so on a unified-memory GPU they are untested"
    )


def _uma_groups(group: _Group, machine: Machine, templates: Templates, gpu: Gpu) -> None:
    if group.name == "video":
        _video_uma(group, machine, templates, gpu)
    elif group.name == "image":
        group.disable(
            "Qwen-Image's text encoder, VAE and DiT need the Diffusers build pinned in qimg-x86_64, which exists for "
            "x86_64 only; on aarch64-sm121 they report PROVIDER_NOT_INSTALLED"
        )
    elif group.name == "vision":
        group.place("qimg-vision-gpu1", gpu, component_id="qimg-vision-uma0", why="Qwen3-VL-4B image vision")
        group.warnings.append(
            "image vision shares the unified memory with the DiT; it is loaded on demand, not next to a loaded DiT"
        )
    else:
        group.place(
            "upscale-anime4k-gpu1",
            gpu,
            component_id="upscale-anime4k-uma0",
            source="upscale-anime4k-gpu1",
            runtime_id=UMA_RUNTIME,
            why="Anime4K 2x video upscaler (phasyn_captioner is part of aarch64-sm121)",
        )
        group.warnings.append(
            UMA_UNTEMPLATED.format(ids="upscale-anime4k-uma0")
            + "; no example runs it on a unified-memory GPU (untested)"
        )


def _resolve_profile_groups(
    machine: Machine, options: Options, templates: Templates, primary: Gpu | None, secondary: Gpu | None
) -> dict[str, _Group]:
    groups = {name: _Group(name) for name in GROUPS}
    blocked: str | None = None
    if primary is None:
        blocked = "no usable NVIDIA GPU" + (f" ({machine.gpu_error})" if machine.gpu_error else "")
    elif problem := driver_problem(machine):
        blocked = problem
    for name, group in groups.items():
        if options.routes is not None and name not in options.routes:
            group.status = "not_requested"
            continue
        if blocked is not None or primary is None:
            group.disable(blocked or "no usable NVIDIA GPU")
            continue
        if machine.arch == "aarch64":
            _uma_groups(group, machine, templates, primary)
        elif name == "video":
            _video(group, machine, primary, secondary)
        elif name == "image":
            _image(group, machine, templates, primary)
        elif name == "vision":
            _vision(group, primary, secondary)
        else:
            _upscale(group, primary, secondary)
    return groups


def _runtime_entry(options: Options, runtime_id: str) -> dict[str, Any]:
    tuple_dir = options.repo_dir / "deploy" / "runtimes" / RUNTIME_DIRS[runtime_id]
    python = tuple_dir / ".venv" / "bin" / "python"
    return {
        "runtime_id": runtime_id,
        "dir": str(tuple_dir),
        "python": str(python),
        "built": python.exists(),
        "sync": ["uv", "sync", "--frozen", "--python", "3.12"],
        "sync_env": {"SGLANG_BUILD_RUST_EXTS": "none"},
        "check": (
            [str(tuple_dir / ".venv" / "bin" / "phasyn-h3-importcheck"), "--pins"]
            if runtime_id in H3_RUNTIMES
            else [str(python), "-m", "phasyn_components.runtime_host", "--list"]
        ),
        "check_env": {"CUDA_VISIBLE_DEVICES": ""},
    }


def _sidecars(options: Options, components: Sequence[dict[str, Any]], primary: Gpu | None) -> list[dict[str, Any]]:
    """The fixed AdaLN sidecars of the PAI 8-step DiTs (docs/install.md), built on the primary GPU."""
    models = options.models_dir
    loras = options.repo_dir / "runtimes" / "h3" / "src" / "phasyn_h3" / "loras"
    shapes = {"fl2va": ["t2va", "fl2va"], "ref2va": ["ref2va-image", "ref2va-audio", "ref2va-mixed"]}
    out: list[dict[str, Any]] = []
    for entry in components:
        if not entry["template"].startswith("dit-"):
            continue
        variant = "fl2va" if "fl2va" in entry["template"] else "ref2va"
        ref = f"h3-{variant}-pdd8"
        runtime = entry.get("runtime_id") or "x86_64"
        tool = (
            options.repo_dir
            / "deploy"
            / "runtimes"
            / RUNTIME_DIRS[runtime]
            / ".venv"
            / "bin"
            / "phasyn-h3-adaln-sidecar"
        )
        target = models / "adaln-cache" / f"{ref}.safetensors"
        command = [str(tool), "--variant", variant]
        for shape in shapes[variant]:
            command += ["--task-shape", shape]
        command += [
            "--steps",
            "8",
            "--video-shift",
            "12",
            "--audio-shift",
            "3",
            "--transformer-path",
            str(models / "MiniMax-H3" / ("FL2VA" if variant == "fl2va" else "Ref2VA") / "transformer"),
            "--model-root",
            str(models),
            "--lora-manifest",
            str(loras / f"pai-h3-{variant}-acc8.json"),
            "--output",
            str(target),
        ]
        out.append(
            {
                "cache_ref": ref,
                "for_component": entry["component_id"],
                "path": str(target),
                "present": target.is_file(),
                "command": command,
                "env": {"CUDA_VISIBLE_DEVICES": primary.uuid if primary else ""},
            }
        )
    return out


def _ports(machine: Machine, options: Options) -> tuple[list[dict[str, Any]], list[str]]:
    """Port problems; a port held by this installation's own service is fine (a re-run)."""
    problems: list[dict[str, Any]] = []
    notes: list[str] = []
    own = {"controller": options.controller_id, "node": options.node_id}
    for role, port in (("controller", options.controller_port), ("node", options.node_port)):
        state = machine.ports.get(port)
        if state is None or state.free:
            continue
        if state.occupant == role and state.occupant_id and state.occupant_id == own[role]:
            notes.append(f"port {port}: this installation's {role} is already running")
            continue
        taken = {options.controller_port, options.node_port}
        alternatives = [p for p, s in sorted(machine.ports.items()) if s.free and p > port and p not in taken]
        flag = "--controller-port" if role == "controller" else "--node-port"
        who = {
            "controller": "a running Phasyn Studio controller of another installation",
            "node": "a running Phasyn Studio Node of another installation",
        }.get(state.occupant or "", "another program")
        suggestion = f"{flag} {alternatives[0]}" if alternatives else f"{flag} <free port>"
        problems.append(
            {
                "id": "PORT_IN_USE",
                "message": f"port {port} for the {role} is in use by {who}"
                + (f" ({state.occupant_id})" if state.occupant_id else ""),
                "fix": f"choose another port ({suggestion}); for a second installation next to the first also pass "
                f"--instance <name> and --data-dir <dir>; or stop what holds port {port}",
                "needs_root": False,
            }
        )
    return problems, notes


def make_plan(
    machine: Machine, options: Options, templates: Templates, *, now: datetime | None = None
) -> dict[str, Any]:
    """The whole plan (JSON-serializable). ``ok`` is false when a problem blocks the install."""
    problems, warnings = prerequisites(machine)
    primary, secondary, gpu_report, profile = assign_gpus(machine, options.primary_gpu)
    if options.primary_gpu is not None and (
        primary is None or options.primary_gpu not in (str(primary.index), primary.uuid)
    ):
        problems.append(
            {
                "id": "UNKNOWN_GPU",
                "message": f"--primary-gpu {options.primary_gpu} is not a usable GPU of this machine",
                "fix": "pass the index or UUID of a GPU listed under gpus",
                "needs_root": False,
            }
        )
    if (driver := driver_problem(machine)) is not None:
        warnings.append(
            f"{driver}: GPU routes are disabled. Update the NVIDIA driver with your distribution's tools "
            "(needs root and a reboot), then run the install again"
        )
    groups = _resolve_profile_groups(machine, options, templates, primary, secondary)
    enabled = [g for g in groups.values() if g.status == "enabled"]
    for group in groups.values():
        warnings += [f"{group.name}: {w}" for w in group.warnings]
        if options.routes is not None and group.name in options.routes and group.status == "disabled":
            warnings.append(f"{group.name} was requested but is disabled: {'; '.join(group.reasons)}")

    uma = machine.arch == "aarch64"
    runtimes = ["cpu", *dict.fromkeys(UMA_RUNTIME if uma else GROUP_RUNTIME[g.name] for g in enabled)]
    components = [c for g in enabled for c in g.components]
    renames = {k: v for g in enabled for k, v in g.renames.items()}
    cpu_qimg = [
        {"component_id": cid, "runtime_id": UMA_RUNTIME if uma else None}
        for g in enabled
        for cid in CPU_QIMG_COMPONENTS.get(g.name, ())
    ]
    pipelines = [
        {"pipeline_id": pid, "group": g.name, "component_map": {k: v for k, v in g.renames.items()}}
        for g in enabled
        for pid in GROUP_PIPELINES[g.name]
    ]
    # One DiT per Node: the routes made ready are those of the video DiT (or, without video, the image DiT). Vision on
    # the primary GPU does not fit next to a loaded DiT, so it stays on standby then.
    names = {g.name for g in enabled}
    dit_group = "video" if "video" in names else ("image" if "image" in names else None)
    vision_on_primary = any(c["component_id"] in ("qimg-vision-gpu0", "qimg-vision-uma0") for c in components)
    ready: list[str] = []
    for group in enabled:
        if group.name in ("video", "image") and group.name != dit_group:
            continue
        if group.name == "vision" and vision_on_primary and dit_group is not None:
            continue
        ready += READY_ROUTES[group.name]
    standby = [p["pipeline_id"] for p in pipelines if p["pipeline_id"] not in ready]

    port_problems, port_notes = _ports(machine, options)
    problems += port_problems

    sets = weight_sets(templates, [g.name for g in enabled], options.models_dir)
    missing = sum(s["bytes_missing"] for s in sets)
    models_disk = machine.disks.get("models")
    free = None if models_disk is None else models_disk.free_bytes
    fits = free is None or missing == 0 or free - WEIGHTS_FREE_MARGIN >= missing
    if not fits:
        warnings.append(
            f"the models directory has {gib(free)} GiB free but the weights still missing need {gib(missing)} GiB "
            "(+1 GiB margin): free space, choose another --models-dir, or install fewer --routes"
        )
    data_disk = machine.disks.get("data")
    if data_disk is not None and data_disk.free_bytes is not None and data_disk.free_bytes < DATA_MIN_FREE:
        warnings.append(f"the data directory has only {gib(data_disk.free_bytes)} GiB free for runs and recordings")

    service_mode = options.service_mode
    if service_mode == "auto":
        service_mode = "systemd" if machine.systemd_user else "foreground"
    elif service_mode == "systemd" and not machine.systemd_user:
        problems.append(
            {
                "id": "NO_SYSTEMD_USER",
                "message": "--services systemd needs a systemd user session",
                "fix": "run with --services foreground, or log in to a session with systemd --user",
                "needs_root": False,
            }
        )

    controller_url = f"http://127.0.0.1:{options.controller_port}"
    node_url = f"http://127.0.0.1:{options.node_port}"
    config_dir = options.config_dir
    plan: dict[str, Any] = {
        "schema": PLAN_SCHEMA,
        "created_at": (now or datetime.now(UTC)).isoformat(timespec="seconds"),
        "ok": not problems,
        "profile": profile,
        "repo_dir": str(options.repo_dir),
        "data_dir": str(options.data_dir),
        "models_dir": str(options.models_dir),
        "config_dir": str(config_dir),
        "machine": {
            "os": machine.os,
            "arch": machine.arch,
            "distro": machine.distro_name,
            "cpu_count": machine.cpu_count,
            "ram_total_gib": gib(machine.ram_total_bytes),
            "ram_available_gib": gib(machine.ram_available_bytes),
            "driver_version": machine.driver_version,
            "cuda_version": machine.cuda_version,
            "gpu_error": machine.gpu_error,
            "python": machine.python,
            "tools": {name: {"path": t.path, "version": t.version} for name, t in machine.tools.items()},
            "disks": {k: {"path": d.path, "free_gib": gib(d.free_bytes)} for k, d in machine.disks.items()},
            "ports": {
                str(p): {"free": s.free, "occupant": s.occupant}
                for p, s in machine.ports.items()
                if p in (options.controller_port, options.node_port)
            },
            "systemd_user": machine.systemd_user,
        },
        "gpus": gpu_report,
        "groups": {
            g.name: {
                "status": g.status,
                "reasons": g.reasons,
                "warnings": g.warnings,
                "pipelines": list(GROUP_PIPELINES[g.name]) if g.status == "enabled" else [],
            }
            for g in groups.values()
        },
        "runtimes": [_runtime_entry(options, r) for r in runtimes if r != "cpu"],
        "components": components,
        "cpu_components": cpu_qimg,
        "component_renames": renames,
        "pipelines": pipelines,
        "ready_routes": ready,
        "standby_routes": standby,
        "weights": {
            "sets": sets,
            "bytes_missing": missing,
            "missing_gib": gib(missing),
            "models_free_gib": gib(free),
            "fits": fits,
        },
        "sidecars": _sidecars(options, components, primary),
        "services": {
            "mode": service_mode,
            "instance": options.instance,
            "controller": {
                "port": options.controller_port,
                "url": controller_url,
                "config": str(config_dir / "controller.json"),
                "unit": f"phasyn-studio-controller@{options.instance}.service",
            },
            "node": {
                "port": options.node_port,
                "url": node_url,
                "config": str(config_dir / "node.json"),
                "unit": f"phasyn-studio-node@{options.instance}.service",
            },
        },
        "web_ui": controller_url,
        "notes": port_notes + list(machine.notes),
        "rules": list(RULES),
        "problems": problems,
        "warnings": warnings,
    }
    return plan


def default_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "phasyn-studio"


__all__ = [
    "GROUPS",
    "GROUP_PIPELINES",
    "PLAN_SCHEMA",
    "RULES",
    "Options",
    "Templates",
    "assign_gpus",
    "default_data_dir",
    "make_plan",
    "prerequisites",
    "vram_gib",
    "weight_sets",
]
