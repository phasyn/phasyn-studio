"""Read-only detection of this machine for ``phasyn-studio install`` (operating system, CPU, memory, disks, GPUs,
tools and ports).

Nothing here changes the machine: it reads ``/proc``, ``/etc/os-release``, runs ``nvidia-smi`` and ``--version``
queries with short timeouts, checks whether a TCP port is taken and, when it is, asks the listener whether it is a
Phasyn Studio service (a plain ``GET`` of its info endpoint). Every reading that fails is ``None`` with a reason,
never a guessed value.
"""

from __future__ import annotations

import contextlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PROBE_TIMEOUT_S = 15
VERSION_TIMEOUT_S = 10
PORT_TIMEOUT_S = 0.5
HTTP_TIMEOUT_S = 2.0
MIB = 1024**2

Runner = Callable[[Sequence[str], float], tuple[int, str]]

TOOLS = ("uv", "git", "node", "pnpm", "ffmpeg", "ffprobe", "nvidia-smi", "systemctl", "nvcc", "ninja")
_VERSION_ARGS: Mapping[str, Sequence[str]] = {"ffmpeg": ("-version",), "ffprobe": ("-version",)}
_SMI_FIELDS = "index,uuid,name,memory.total,memory.used,compute_cap,driver_version"
_CUDA_RE = re.compile(r"CUDA(?: UMD)? Version:\s*([0-9]+(?:\.[0-9]+)?)")
_SEMVER_RE = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")


@dataclass(frozen=True)
class Gpu:
    index: int
    uuid: str
    name: str
    memory_total_mib: int | None  # None: the driver reports no dedicated memory (unified-memory GPU)
    memory_used_mib: int | None
    compute_capability: str | None  # "12.0"; None when the driver does not report it

    @property
    def integrated(self) -> bool:
        return self.memory_total_mib is None

    def capability(self) -> tuple[int, int] | None:
        if not self.compute_capability:
            return None
        major, _, minor = self.compute_capability.partition(".")
        try:
            return int(major), int(minor or 0)
        except ValueError:
            return None


@dataclass(frozen=True)
class Tool:
    name: str
    path: str | None
    version: str | None = None


@dataclass(frozen=True)
class PortState:
    port: int
    free: bool
    occupant: str | None = None  # "controller", "node", "other" (taken by something that is not Phasyn Studio)
    occupant_id: str | None = None  # the controller's instance id or the Node's node id


@dataclass(frozen=True)
class Disk:
    path: str
    probe_path: str | None  # the nearest existing directory that was measured
    free_bytes: int | None
    total_bytes: int | None


@dataclass(frozen=True)
class Machine:
    os: str
    arch: str
    distro_id: str | None
    distro_like: tuple[str, ...]
    distro_name: str | None
    cpu_count: int | None
    ram_total_bytes: int | None
    ram_available_bytes: int | None
    driver_version: str | None
    cuda_version: str | None
    gpus: tuple[Gpu, ...]
    gpu_error: str | None
    python: str
    tools: dict[str, Tool]
    disks: dict[str, Disk]
    ports: dict[int, PortState]
    systemd_user: bool
    notes: tuple[str, ...] = field(default_factory=tuple)

    def tool(self, name: str) -> Tool:
        return self.tools.get(name) or Tool(name, None)

    def to_dict(self) -> dict[str, Any]:
        doc = asdict(self)
        doc["ports"] = {str(k): v for k, v in doc["ports"].items()}
        for gpu, entry in zip(self.gpus, doc["gpus"], strict=True):
            entry["integrated"] = gpu.integrated
        return doc


def machine_from_dict(doc: Mapping[str, Any]) -> Machine:
    """The inverse of :meth:`Machine.to_dict` (used for fixtures and for reading a saved plan)."""
    return Machine(
        os=str(doc["os"]),
        arch=str(doc["arch"]),
        distro_id=doc.get("distro_id"),
        distro_like=tuple(doc.get("distro_like") or ()),
        distro_name=doc.get("distro_name"),
        cpu_count=doc.get("cpu_count"),
        ram_total_bytes=doc.get("ram_total_bytes"),
        ram_available_bytes=doc.get("ram_available_bytes"),
        driver_version=doc.get("driver_version"),
        cuda_version=doc.get("cuda_version"),
        gpus=tuple(
            Gpu(
                index=int(g["index"]),
                uuid=str(g["uuid"]),
                name=str(g["name"]),
                memory_total_mib=g.get("memory_total_mib"),
                memory_used_mib=g.get("memory_used_mib"),
                compute_capability=g.get("compute_capability"),
            )
            for g in doc.get("gpus") or ()
        ),
        gpu_error=doc.get("gpu_error"),
        python=str(doc.get("python") or ""),
        tools={
            name: Tool(name, (t or {}).get("path"), (t or {}).get("version"))
            for name, t in (doc.get("tools") or {}).items()
        },
        disks={
            key: Disk(str(d["path"]), d.get("probe_path"), d.get("free_bytes"), d.get("total_bytes"))
            for key, d in (doc.get("disks") or {}).items()
        },
        ports={
            int(port): PortState(int(port), bool(p["free"]), p.get("occupant"), p.get("occupant_id"))
            for port, p in (doc.get("ports") or {}).items()
        },
        systemd_user=bool(doc.get("systemd_user")),
        notes=tuple(doc.get("notes") or ()),
    )


# ---------------------------------------------------------------------- helpers
def run_command(argv: Sequence[str], timeout: float) -> tuple[int, str]:
    """Run a read-only command; (returncode, stdout). A missing program or a timeout is (127 / 124, reason)."""
    try:
        result = subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError:
        return 127, f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]}: no answer within {timeout:g} s"
    except OSError as exc:
        return 126, f"{argv[0]}: {exc.strerror or exc}"
    return result.returncode, result.stdout if result.returncode == 0 else (result.stderr or result.stdout)


def version_tuple(text: str | None) -> tuple[int, int, int] | None:
    """The first ``major.minor[.patch]`` in a version string (``v22.22.2`` → (22, 22, 2))."""
    match = _SEMVER_RE.search(text or "")
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3) or 0)


def read_os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip():
            out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def read_meminfo(path: Path = Path("/proc/meminfo")) -> tuple[int | None, int | None]:
    """(MemTotal, MemAvailable) in bytes."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, None
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            values[key] = int(parts[0]) * 1024
    return values.get("MemTotal"), values.get("MemAvailable")


def _int_or_none(value: str) -> int | None:
    value = value.strip()
    return int(value) if value.isdigit() else None


def parse_smi_query(text: str) -> tuple[list[Gpu], str | None]:
    """``nvidia-smi --query-gpu=<_SMI_FIELDS> --format=csv,noheader,nounits`` → GPUs and the driver version."""
    gpus: list[Gpu] = []
    driver: str | None = None
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.split(",")]
        if len(cells) < 7 or not cells[0].isdigit():
            continue
        capability = cells[5] if re.fullmatch(r"\d+\.\d+", cells[5]) else None
        gpus.append(
            Gpu(
                index=int(cells[0]),
                uuid=cells[1],
                name=cells[2],
                memory_total_mib=_int_or_none(cells[3]),
                memory_used_mib=_int_or_none(cells[4]),
                compute_capability=capability,
            )
        )
        driver = driver or cells[6] or None
    return gpus, driver


def parse_cuda_version(text: str) -> str | None:
    match = _CUDA_RE.search(text)
    return match.group(1) if match else None


def detect_gpus(run: Runner = run_command) -> tuple[tuple[Gpu, ...], str | None, str | None, str | None]:
    """(GPUs, driver version, CUDA version the driver supports, error). ``nvidia-smi`` first, NVML second."""
    code, out = run(["nvidia-smi", f"--query-gpu={_SMI_FIELDS}", "--format=csv,noheader,nounits"], PROBE_TIMEOUT_S)
    if code == 0:
        parsed, driver = parse_smi_query(out)
        _, header = run(["nvidia-smi"], PROBE_TIMEOUT_S)
        return tuple(parsed), driver, parse_cuda_version(header), None
    smi_error = out.strip().splitlines()[0] if out.strip() else f"nvidia-smi exited with {code}"
    from .doctor import gpus as nvml_gpus

    report = nvml_gpus()
    found = report.get("gpus") or []
    if not found:
        return (), None, None, f"{smi_error}; NVML: {report.get('nvml_error') or 'no GPU'}"
    nvml = tuple(
        Gpu(
            index=int(g["index"]),
            uuid=str(g["uuid"]),
            name=str(g["name"]),
            memory_total_mib=None if g.get("memory_total_bytes") is None else int(g["memory_total_bytes"]) // MIB,
            memory_used_mib=None,
            compute_capability=None,
        )
        for g in found
    )
    return nvml, report.get("driver"), None, f"{smi_error} (GPUs read through NVML, without compute capability)"


def detect_tools(names: Iterable[str] = TOOLS, run: Runner = run_command) -> dict[str, Tool]:
    tools: dict[str, Tool] = {}
    for name in names:
        path = shutil.which(name)
        version: str | None = None
        if path and name not in ("systemctl", "nvidia-smi"):
            code, out = run([path, *_VERSION_ARGS.get(name, ("--version",))], VERSION_TIMEOUT_S)
            first = out.strip().splitlines()[0] if out.strip() else ""
            version = first[:120] if code == 0 and first else None
        tools[name] = Tool(name, path, version)
    return tools


def measure_disk(path: Path) -> Disk:
    """Free and total bytes of the file system that holds ``path`` (or its nearest existing parent)."""
    probe = path.expanduser().absolute()
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return Disk(str(path), None, None, None)
    return Disk(str(path), str(probe), int(usage.free), int(usage.total))


# loopback probes never go through a proxy from the environment (HTTP_PROXY and friends)
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _identify(port: int) -> tuple[str, str | None]:
    """Who listens on a taken loopback port: a Phasyn Studio controller or Node (with its id), or something else."""
    for endpoint, kind, key in (("/api/controller", "controller", "controller_id"), ("/api/node", "node", "node_id")):
        request = urllib.request.Request(f"http://127.0.0.1:{port}{endpoint}", headers={"Accept": "application/json"})
        try:
            with _DIRECT.open(request, timeout=HTTP_TIMEOUT_S) as resp:
                doc = json.loads(resp.read(1 << 20))
        except (urllib.error.URLError, OSError, ValueError):
            continue
        if isinstance(doc, dict) and doc.get("protocol_version") and doc.get(key):
            return kind, str(doc[key])
    return "other", None


def check_port(port: int, *, identify: bool = True) -> PortState:
    """A port is free when nothing answers on 127.0.0.1 and this process could bind it (also catches 0.0.0.0)."""
    with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=PORT_TIMEOUT_S):
        kind, ident = _identify(port) if identify else ("other", None)
        return PortState(port, False, kind, ident)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return PortState(port, False, "other", None)
    return PortState(port, True)


def systemd_user_available(run: Runner = run_command) -> bool:
    if shutil.which("systemctl") is None:
        return False
    code, _ = run(["systemctl", "--user", "show-environment"], VERSION_TIMEOUT_S)
    return code == 0


def detect(*, disk_paths: Mapping[str, Path], ports: Iterable[int], run: Runner = run_command) -> Machine:
    """Everything the planner needs, read-only."""
    release = read_os_release()
    total, available = read_meminfo()
    gpus, driver, cuda, gpu_error = detect_gpus(run)
    tools = detect_tools(run=run)
    notes: list[str] = []
    if platform.system() != "Linux":
        notes.append(f"{platform.system()} is not supported: Phasyn Studio runs on Linux only")
    return Machine(
        os=platform.system(),
        arch=platform.machine(),
        distro_id=release.get("ID"),
        distro_like=tuple(release.get("ID_LIKE", "").split()),
        distro_name=release.get("PRETTY_NAME"),
        cpu_count=os.cpu_count(),
        ram_total_bytes=total,
        ram_available_bytes=available,
        driver_version=driver,
        cuda_version=cuda,
        gpus=gpus,
        gpu_error=gpu_error,
        python=sys.version.split()[0],
        tools=tools,
        disks={key: measure_disk(path) for key, path in disk_paths.items()},
        ports={port: check_port(port) for port in dict.fromkeys(ports)},
        systemd_user=systemd_user_available(run),
        notes=tuple(notes),
    )


__all__ = [
    "Disk",
    "Gpu",
    "Machine",
    "PortState",
    "Tool",
    "check_port",
    "detect",
    "detect_gpus",
    "machine_from_dict",
    "measure_disk",
    "parse_cuda_version",
    "parse_smi_query",
    "read_meminfo",
    "read_os_release",
    "run_command",
    "version_tuple",
]
