"""``phasyn-studio install`` and ``phasyn-studio up``: one-machine install that adapts to the detected hardware.

``install`` detects the machine (read-only), plans which routes and components run on which GPU, shows the plan, and
after confirmation (or ``--yes``) runs the repository's own install steps, writes the configuration into the user's
data directory, starts the controller and the Node and brings the planned routes to ready. ``--dry-run`` stops after
the plan and writes nothing. It never runs anything as root: commands that need root are printed for the user.

``up`` starts an installed deployment again and checks it end to end (Node online, components started, routes ready).
``status`` only reads: it sends GET requests and never starts, creates or changes anything.

Exit codes: 0 ready (or a dry run whose plan has no problem), 2 invalid arguments, 3 the machine or plan blocks the
install (problems listed), 4 a step failed, 5 installed but not ready (not running, or routes not ready; next steps
listed), 130 the foreground services were stopped with Ctrl+C after they had been ready.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from . import bringup, configgen, doctor, machine, planner, service

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_BLOCKED = 3
EXIT_FAILED = 4
EXIT_NOT_READY = 5
EXIT_INTERRUPTED = 130
UI_INPUTS = ("apps/frontend", "contracts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
UI_STAMP = "apps/frontend/dist/.phasyn-build-stamp"
PORT_PROBE_SPAN = 10
PLAN_FILE = "install-plan.json"


class StepError(Exception):
    def __init__(self, message: str, exit_code: int = EXIT_FAILED) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code


# ---------------------------------------------------------------------- output
def say(text: str = "") -> None:
    """Progress and the human-readable plan go to stderr, so ``--json`` keeps stdout to one JSON document."""
    print(text, file=sys.stderr, flush=True)


def human_plan(plan: Mapping[str, Any]) -> str:
    m = plan["machine"]
    lines = [
        "Phasyn Studio install plan",
        f"  machine   {m['distro'] or m['os']} {m['arch']}, {m['cpu_count']} CPUs, {m['ram_total_gib']} GiB RAM, "
        f"driver {m['driver_version'] or '-'} (CUDA {m['cuda_version'] or '-'})",
        f"  profile   {plan['profile']}",
    ]
    for gpu in plan["gpus"]:
        why = f" ({gpu['reason']})" if gpu["reason"] else ""
        memory = "unified memory" if gpu["unified_memory"] else f"{gpu['vram_gib']} GB"
        lines.append(
            f"  GPU {gpu['index']}     {gpu['name']}, {memory}, sm {gpu['compute_capability'] or '?'}: "
            f"{gpu['role']}{why}"
        )
    lines.append("  routes")
    for name, group in plan["groups"].items():
        detail = ", ".join(group["pipelines"]) if group["status"] == "enabled" else "; ".join(group["reasons"])
        lines.append(f"    {name:<8} {group['status']}{': ' + detail if detail else ''}")
    lines.append(
        "  rules     placement thresholds are planning heuristics, not measurements (each with its basis in the "
        "plan JSON `rules`)"
    )
    lines.append("  components")
    for comp in plan["components"]:
        lines.append(f"    {comp['component_id']:<28} GPU {comp['gpu_index']}  {comp['why']}")
    lines.append(f"  made ready by `up`: {', '.join(plan['ready_routes']) or '(none)'}")
    if plan["standby_routes"]:
        lines.append(f"  standby (load on demand): {', '.join(plan['standby_routes'])}")
    w = plan["weights"]
    lines.append(
        f"  weights   {w['missing_gib']} GiB missing in {plan['models_dir']} ({w['models_free_gib']} GiB free)"
        + ("" if w["fits"] else "  ** does not fit **")
    )
    for item in w["sets"]:
        lic = item["license"]
        lines.append(
            f"    {item['label']:<34} {item['bytes_total'] / 1024**3:7.1f} GiB  {lic['name']}"
            + (f" — {lic['note']}" if lic["note"] else "")
        )
    missing_sidecars = [s["cache_ref"] for s in plan["sidecars"] if not s["present"]]
    if missing_sidecars:
        lines.append(f"  sidecars  to build on the primary GPU after the weights: {', '.join(missing_sidecars)}")
    svc = plan["services"]
    lines.append(
        f"  services  {svc['mode']}: controller {svc['controller']['url']}, node {svc['node']['url']} "
        f"(instance {svc['instance']})"
    )
    lines.append(f"  config    {plan['config_dir']}")
    for note in plan["notes"]:
        lines.append(f"  note      {note}")
    for warning in plan["warnings"]:
        lines.append(f"  WARNING   {warning}")
    for problem in plan["problems"]:
        lines.append(f"  PROBLEM   [{problem['id']}] {problem['message']}")
        lines.append(
            f"            fix: {problem['fix']}" + ("  (needs root: run it yourself)" if problem["needs_root"] else "")
        )
    lines.append(f"  web UI    {plan['web_ui']}")
    return "\n".join(lines)


def human_report(report: Mapping[str, Any]) -> str:
    lines = [f"status: {report['status']}"]
    for pid, route in report["routes"].items():
        mark = "ready" if route["ready"] else "not ready"
        role = "" if route["target"] else " (standby)"
        lines.append(
            f"  route {pid:<24} {mark}{role}" + ("" if route["ready"] else f": {'; '.join(route['problems'][:3])}")
        )
    for cid, comp in report["components"].items():
        err = comp.get("error")
        lines.append(
            f"  component {cid:<28} {comp.get('state')}"
            + (f"  {err.get('code')}: {err.get('message', '')}" if err else "")
        )
    weights = report.get("weights") or {}
    if weights.get("bytes_missing"):
        lines.append(f"  weights missing: {weights['bytes_missing'] / 1024**3:.1f} GiB")
        for item in weights.get("sets") or ():
            if item.get("bytes_missing"):
                lic = item.get("license") or {}
                lines.append(f"    {item['set_id']}: {lic.get('name')} {lic.get('url')}")
    for error in report["errors"]:
        lines.append(f"  ERROR {error}")
    for step in report["next_steps"]:
        lines.append(f"  next: {step}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- helpers
def repo_root(explicit: str | None) -> Path:
    candidates = (
        [Path(explicit).expanduser().resolve()] if explicit else [Path(__file__).resolve().parents[4], Path.cwd()]
    )
    for root in candidates:
        if (root / "deploy" / "config" / "node-a.example.json").is_file() and (
            root / "examples" / "components"
        ).is_dir():
            return root
    raise StepError("this command runs from a Phasyn Studio checkout; pass --repo-dir <checkout>", EXIT_USAGE)


def run_step(title: str, argv: Sequence[str], *, cwd: Path, env: Mapping[str, str] | None = None) -> None:
    say(f"==> {title}: {' '.join(argv)}")
    try:
        result = subprocess.run(
            list(argv), cwd=cwd, env={**os.environ, **(env or {})}, stdout=sys.stderr, stderr=sys.stderr, check=False
        )
    except FileNotFoundError as exc:
        raise StepError(f"{title}: {argv[0]} not found") from exc
    if result.returncode != 0:
        raise StepError(
            f"{title} failed (exit {result.returncode}); the output above says why. Fix it and run the "
            "same command again: finished steps are skipped or repeated safely"
        )


def tree_stamp(repo: Path, paths: Sequence[str] = ()) -> str | None:
    """A hash of the checkout's content under ``paths`` (all when empty): HEAD, uncommitted changes and untracked
    files. None without git: callers then treat the tree as changed."""
    parts: list[bytes] = []
    for argv in (
        ["git", "rev-parse", "HEAD"],
        ["git", "diff", "--no-ext-diff", "HEAD", "--", *paths],
        ["git", "ls-files", "--others", "--exclude-standard", "--", *paths],
    ):
        try:
            parts.append(subprocess.run(argv, cwd=repo, capture_output=True, timeout=60, check=True).stdout)
        except (OSError, subprocess.SubprocessError):
            return None
    untracked = parts[2].decode("utf-8", "replace").splitlines()
    digest = hashlib.sha256(b"\0".join(parts))
    for name in sorted(untracked):  # untracked files count with their content
        try:
            digest.update((repo / name).read_bytes())
        except OSError:
            digest.update(b"unreadable")
    return digest.hexdigest()


def ui_is_current(repo: Path) -> bool:
    """The built web UI matches the current sources (a stamp written after the last build through this command)."""
    if not (repo / "apps" / "frontend" / "dist" / "index.html").is_file():
        return False
    stamp = tree_stamp(repo, UI_INPUTS)
    try:
        return stamp is not None and (repo / UI_STAMP).read_text(encoding="utf-8").strip() == stamp
    except OSError:
        return False


def write_ui_stamp(repo: Path) -> None:
    stamp = tree_stamp(repo, UI_INPUTS)
    if stamp is not None:
        (repo / UI_STAMP).write_text(stamp + "\n", encoding="utf-8")


def parse_groups(value: str | None) -> frozenset[str] | None:
    if not value or value == "auto":
        return None
    groups = frozenset(item.strip() for item in value.split(",") if item.strip())
    unknown = groups - set(planner.GROUPS)
    if unknown:
        raise StepError(
            f"unknown route group(s) {', '.join(sorted(unknown))}; choose from {', '.join(planner.GROUPS)}", EXIT_USAGE
        )
    return groups


def build(args: argparse.Namespace) -> tuple[Path, planner.Options, planner.Templates, dict[str, Any], dict[str, Any]]:
    """Detect, plan and render (nothing is written)."""
    repo = repo_root(args.repo_dir)
    data_dir = Path(args.data_dir).expanduser().absolute() if args.data_dir else planner.default_data_dir()
    models_dir = Path(args.models_dir).expanduser().absolute() if args.models_dir else data_dir / "models"
    controller_id, node_id = configgen.existing_ids(data_dir / "config")
    options = planner.Options(
        repo_dir=repo,
        data_dir=data_dir,
        models_dir=models_dir,
        controller_port=args.controller_port,
        node_port=args.node_port,
        routes=parse_groups(args.routes),
        primary_gpu=args.primary_gpu,
        instance=args.instance,
        service_mode=args.services,
        controller_id=controller_id,
        node_id=node_id,
    )
    ports = [*range(args.controller_port, args.controller_port + PORT_PROBE_SPAN + 1)]
    ports += range(args.node_port, args.node_port + PORT_PROBE_SPAN + 1)
    found = machine.detect(disk_paths={"data": data_dir, "models": models_dir}, ports=ports)
    templates = planner.Templates(repo)
    plan = planner.make_plan(found, options, templates)
    ids = configgen.make_ids(controller_id, node_id)
    rendered = configgen.render_all(plan, templates, ids)
    invalid = configgen.validate(rendered, options.config_dir)
    if invalid:
        plan["problems"].append(
            {
                "id": "CONFIG_INVALID",
                "message": "; ".join(invalid),
                "fix": "report this as a bug",
                "needs_root": False,
            }
        )
        plan["ok"] = False
    drift = config_drift(options.config_dir, rendered)
    if drift and not getattr(args, "reconfigure", False):
        plan["problems"].append(
            {
                "id": "CONFIG_DIFFERS",
                "message": "the existing configuration differs from this plan: " + "; ".join(drift),
                "fix": "run again with --reconfigure to replace it (the old files are kept as .bak), or with the "
                "options of the earlier install",
                "needs_root": False,
            }
        )
        plan["ok"] = False
    conflicts = unit_conflicts(plan)
    if conflicts:
        plan["problems"] += conflicts
        plan["ok"] = False
    plan["config_changes"] = drift
    plan["ids"] = {"controller": ids.controller, "node": ids.node, "reused": bool(controller_id or node_id)}
    return repo, options, templates, plan, rendered


def unit_config(path: Path) -> str | None:
    """The ``--config`` path of an installed unit (its ExecStart line); None when it cannot be read."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if not line.startswith("ExecStart="):
            continue
        try:
            words = shlex.split(line.removeprefix("ExecStart="))
        except ValueError:
            return None
        if "--config" in words[:-1]:
            return words[words.index("--config") + 1].replace("$$", "$").replace("%%", "%")
    return None


def unit_conflicts(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Units of the same name that belong to another installation (another configuration file)."""
    if plan["services"]["mode"] != "systemd":
        return []
    problems: list[dict[str, Any]] = []
    for role in ("controller", "node"):
        entry = plan["services"][role]
        path = service.user_unit_dir() / entry["unit"]
        if not path.exists():
            continue
        owner = unit_config(path)
        if owner != entry["config"]:
            problems.append(
                {
                    "id": "UNIT_IN_USE",
                    "message": f"the systemd unit {entry['unit']} already runs "
                    f"{owner or 'a configuration this installer cannot read'}",
                    "fix": f"pass --instance <another name> (and --data-dir <dir>) for a second installation, or remove "
                    f"the other one with `phasyn-studio service uninstall --role {role} "
                    f"--instance {plan['services']['instance']}`",
                    "needs_root": False,
                }
            )
    return problems


def config_drift(config_dir: Path, rendered: Mapping[str, Any]) -> list[str]:
    """What an existing controller.json / node.json would change (empty when absent or identical)."""
    changes: list[str] = []
    for name in ("controller.json", "node.json"):
        try:
            current = json.loads((config_dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        new = rendered[name]
        if current == new:
            continue
        if not isinstance(current, dict):
            changes.append(f"{name} is replaced")
            continue
        keys = sorted(k for k in set(current) | set(new) if k not in ("components",) and current.get(k) != new.get(k))
        if keys:
            changes.append(f"{name}: {', '.join(keys)}")
        if name == "node.json":
            old_ids = {c.get("component_id") for c in current.get("components") or ()}
            new_ids = {c["component_id"] for c in new["components"]}
            if added := sorted(new_ids - old_ids):
                changes.append(f"components added: {', '.join(added)}")
            if removed := sorted(str(c) for c in old_ids - new_ids):
                changes.append(f"components removed: {', '.join(removed)}")
            if not added and not removed and current.get("components") != new["components"]:
                changes.append("component settings change")
    return changes


def confirm(args: argparse.Namespace, plan: Mapping[str, Any]) -> None:
    if args.yes:
        return
    if not sys.stdin.isatty():
        raise StepError("not a terminal: read the plan, then run again with --yes to proceed", EXIT_USAGE)
    runtimes = ", ".join(r["runtime_id"] for r in plan["runtimes"]) or "none"
    say(
        "\nThis will: sync the Python environment, install and build the web UI, build the GPU environments "
        f"({runtimes}; several GB each), write the configuration to {plan['config_dir']}, "
        f"start the services ({plan['services']['mode']}) and load the components of the routes above."
    )
    answer = input("Proceed? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        raise StepError("cancelled; nothing was changed", EXIT_USAGE)


def write_outputs(plan: dict[str, Any], rendered: Mapping[str, Any], *, reconfigure: bool) -> dict[str, str]:
    config_dir = Path(plan["config_dir"])
    status = {
        "controller.json": configgen.write_json(
            config_dir / "controller.json", rendered["controller.json"], reconfigure=reconfigure
        ),
        "node.json": configgen.write_json(config_dir / "node.json", rendered["node.json"], reconfigure=reconfigure),
    }
    for pid, doc in rendered["pipelines"].items():
        status[f"pipelines/{pid}.json"] = configgen.write_json(
            config_dir / "pipelines" / f"{pid}.json", doc, reconfigure=True
        )
    configgen.write_json(Path(plan["data_dir"]) / PLAN_FILE, plan, reconfigure=True, backup=False)
    Path(plan["models_dir"]).mkdir(parents=True, exist_ok=True)
    for name, state in status.items():
        say(f"    {name}: {state}")
    if "kept" in status.values():
        say(
            "    a configuration file differs from the new plan and was kept; run with --reconfigure to replace it "
            "(the old file is saved as .bak)"
        )
    if status["node.json"] == "updated" and (Path(plan["data_dir"]) / "node" / "config" / "components").is_dir():
        say(
            "    note: the Node keeps the component definitions it saved earlier; new seeds apply only to components "
            "it does not have yet (edit the others on the Components page)"
        )
    return status


def run_doctor(plan: Mapping[str, Any]) -> list[str]:
    """The existing read-only doctor on the generated Node configuration."""
    config = Path(plan["services"]["node"]["config"])
    problems = doctor.placeholder_problems(config)
    for runtime in doctor.runtime_providers(config):
        if "error" in runtime:
            problems.append(f"runtime {runtime['runtime_id']} cannot list its providers: {runtime['error']}")
        else:
            missing = [p[0] for p in runtime["providers"] if not p[1]]
            say(f"    runtime {runtime['runtime_id']}: {len(runtime['providers']) - len(missing)} providers available")
    for problem in problems:
        say(f"    doctor: {problem}")
    return problems


def busy_components(plan: Mapping[str, Any], node_id: str) -> list[str]:
    """Components of this installation's Node that are loading or running a call (read-only; [] when unreachable)."""
    api = bringup.Api(plan["services"]["controller"]["url"])
    try:
        comps = bringup.components_of(bringup.catalog(api), node_id)
    except bringup.ApiError:
        return []
    finally:
        api.close()
    return sorted(cid for cid, c in comps.items() if c.get("state") in ("busy", "loading"))


def start_services(plan: Mapping[str, Any], *, enable: bool, changed: bool, node_id: str) -> list[str]:
    """Install (or refresh) and start this installation's units; restart running ones when the configuration or the
    checkout changed, unless a component is busy. Returns next steps for what was not restarted."""
    instance = plan["services"]["instance"]
    active = {}
    for role in ("controller", "node"):
        entry = plan["services"][role]
        path = service.user_unit_dir() / entry["unit"]
        if path.exists():
            if unit_config(path) != entry["config"]:  # checked in the plan too; never touch another installation
                raise StepError(f"{entry['unit']} belongs to another installation; use --instance <name>", EXIT_BLOCKED)
            text = service.unit_text(role, instance, Path(entry["config"]))
            if path.read_text(encoding="utf-8") != text:
                shutil.copy2(path, path.with_name(path.name + ".bak"))
                say(f"    {entry['unit']}: previous unit kept as {path.name}.bak")
        state = service.systemctl("is-active", entry["unit"], check=False).stdout.strip()
        active[role] = state == "active"
    busy = busy_components(plan, node_id) if changed and any(active.values()) else []
    steps: list[str] = []
    for role in ("controller", "node"):
        entry = plan["services"][role]
        report = service.install(role, instance, Path(entry["config"]), start=True, enable=enable)
        if changed and active[role]:
            if busy:
                command = f"systemctl --user restart {entry['unit']}"
                steps.append(f"the configuration or code changed but {', '.join(busy)} is busy: run `{command}` later")
            else:
                service.systemctl("restart", entry["unit"])
                say(f"    {entry['unit']}: restarted (configuration or code changed)")
        say(f"    {report.unit}: {'active' if report.verified else report.state.get('ActiveState')}")
        if not report.verified:
            raise StepError(f"{report.unit} did not start: journalctl --user -u {report.unit} -n 50")
    return steps


def saved_state(data_dir: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(plan, {"controller.json", "node.json"}, pipelines) of an installation."""
    try:
        plan = json.loads((data_dir / PLAN_FILE).read_text(encoding="utf-8"))
        config_dir = Path(plan["config_dir"])
        configs = {
            name: json.loads((config_dir / name).read_text(encoding="utf-8"))
            for name in ("controller.json", "node.json")
        }
        pipelines = {
            p["pipeline_id"]: json.loads(
                (config_dir / "pipelines" / f"{p['pipeline_id']}.json").read_text(encoding="utf-8")
            )
            for p in plan["pipelines"]
        }
    except (OSError, ValueError, KeyError) as exc:
        raise StepError(
            f"no installation in {data_dir} ({exc}); run `phasyn-studio install` first", EXIT_USAGE
        ) from exc
    return plan, configs, pipelines


def resolve_routes(value: str | None, plan: Mapping[str, Any]) -> list[str]:
    if not value:
        return list(plan["ready_routes"])
    known = {p["pipeline_id"]: p["group"] for p in plan["pipelines"]}
    out: list[str] = []
    for item in (v.strip() for v in value.split(",") if v.strip()):
        if item in planner.GROUPS:  # a group means its routes of one DiT (READY_ROUTES), never both video DiTs
            out += [pid for pid in planner.READY_ROUTES[item] if pid in known]
        elif item in known:
            out.append(item)
        else:
            raise StepError(f"unknown route {item}: choose a pipeline id of the plan or a group", EXIT_USAGE)
    out = list(dict.fromkeys(out))
    dits = {pid: dit for pid in out if (dit := route_dit(plan, pid)) is not None}
    if len(set(dits.values())) > 1:
        listed = ", ".join(f"{pid} ({dit})" for pid, dit in dits.items())
        raise StepError(
            f"these routes need different DiTs and a Node keeps one loaded: {listed}; choose routes of one DiT",
            EXIT_USAGE,
        )
    return out


def route_dit(plan: Mapping[str, Any], pipeline_id: str) -> str | None:
    """The DiT (exclusive group 'dit') a planned route uses, from the plan's pipeline template and renames."""
    path = Path(plan["config_dir"]) / "pipelines" / f"{pipeline_id}.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    dits = {c["component_id"] for c in plan["components"] if c["template"].startswith(("dit-", "qimg-dit-"))}
    return next((s["component_id"] for s in doc.get("steps") or () if s.get("component_id") in dits), None)


def emit(args: argparse.Namespace, plan: Mapping[str, Any], report: dict[str, Any]) -> int:
    """Print the report (human on stderr, JSON on stdout with --json) and map its status to the exit code."""
    report["web_ui"] = plan["web_ui"]
    say(human_report(report))
    if args.json:
        doc = {"plan_file": str(Path(plan["data_dir"]) / PLAN_FILE), "report": report}
        print(json.dumps(doc, ensure_ascii=False, indent=2))
    if report["status"] == "ready":
        say(f"\nReady. Open {plan['web_ui']}")
        return EXIT_OK
    return EXIT_FAILED if report["status"] == "failed" else EXIT_NOT_READY


def bring_up(
    args: argparse.Namespace,
    plan: Mapping[str, Any],
    configs: Mapping[str, Any],
    pipelines: Mapping[str, Any],
    extra_steps: Sequence[str] = (),
) -> int:
    routes = resolve_routes(getattr(args, "ready", None), plan)
    api = bringup.Api(plan["services"]["controller"]["url"])
    try:
        report = bringup.bring_up(
            api,
            plan,
            pipelines,
            controller_id=configs["controller.json"]["instance_id"],
            node_id=configs["node.json"]["node_id"],
            routes=routes,
            load=not args.no_load,
            download=args.download_weights,
            sidecars=args.build_sidecars,
            replace_dit=args.replace_dit,
            log=lambda msg: say(f"    {msg}"),
        ).to_dict()
    finally:
        api.close()
    report["next_steps"] = [*extra_steps, *report["next_steps"]]
    return emit(args, plan, report)


def foreground(
    args: argparse.Namespace, plan: Mapping[str, Any], configs: Mapping[str, Any], pipelines: Mapping[str, Any]
) -> int:
    """Run the controller and the Node as children of this process; Ctrl+C stops both."""
    procs: list[subprocess.Popen[bytes]] = []
    code = EXIT_NOT_READY
    try:
        for role in ("controller", "node"):
            argv = [sys.executable, "-m", "phasyn_cli.main", role, "--config", plan["services"][role]["config"]]
            say(f"==> starting {role}: {' '.join(argv)}")
            procs.append(subprocess.Popen(argv, stdout=sys.stderr, stderr=sys.stderr))
        code = bring_up(args, plan, configs, pipelines)
        if code == EXIT_FAILED:
            say("the services did not come up; stopping them")
            return code
        say(f"services run in the foreground; Ctrl+C stops them (exit 130 if they were ready, {EXIT_NOT_READY} if not)")
        while all(p.poll() is None for p in procs):
            try:
                procs[0].wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                continue
        exited = next(p for p in procs if p.poll() is not None)
        say(f"a service exited with code {exited.returncode}; stopping the other")
        return EXIT_FAILED
    except KeyboardInterrupt:
        say("stopping …")
        return EXIT_INTERRUPTED if code == EXIT_OK else EXIT_NOT_READY
    finally:
        for proc in reversed(procs):
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        for proc in procs:
            try:
                proc.wait(timeout=service.STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                proc.kill()


# ---------------------------------------------------------------------- commands
def cmd_install(args: argparse.Namespace) -> int:
    if args.download_weights and not args.accept_licenses:
        raise StepError("--download-weights needs --accept-licenses: read the licenses in the plan first", EXIT_USAGE)
    repo, options, _templates, plan, rendered = build(args)
    say(human_plan(plan))
    if args.plan_out:
        Path(args.plan_out).expanduser().write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    if args.dry_run:
        if args.json:
            print(json.dumps(plan, ensure_ascii=False, indent=2))
        say("\ndry run: nothing was installed, written or started")
        return EXIT_OK if plan["ok"] else EXIT_BLOCKED
    if not plan["ok"]:
        if args.json:
            print(json.dumps(plan, ensure_ascii=False, indent=2))
        say("\nthe plan has problems (above); fix them and run the install again")
        return EXIT_BLOCKED
    confirm(args, plan)

    gpu = bool(plan["gpus"])
    run_step(
        "Python environment",
        ["uv", "sync", "--all-packages", "--frozen", *(["--extra", "gpu"] if gpu else [])],
        cwd=repo,
    )
    run_step("web UI dependencies", ["pnpm", "install", "--frozen-lockfile"], cwd=repo)
    if args.rebuild_ui or not ui_is_current(repo):
        run_step("web UI build", ["pnpm", "build"], cwd=repo)
        write_ui_stamp(repo)
    else:
        say("==> web UI build: built from the current sources already; skipped (--rebuild-ui forces it)")
    if args.skip_runtimes:
        say("==> GPU environments: skipped (--skip-runtimes)")
    for runtime in [] if args.skip_runtimes else plan["runtimes"]:
        run_step(
            f"GPU environment {runtime['runtime_id']}",
            runtime["sync"],
            cwd=Path(runtime["dir"]),
            env=runtime["sync_env"],
        )
        run_step(
            f"GPU environment {runtime['runtime_id']} check",
            runtime["check"],
            cwd=Path(runtime["dir"]),
            env=runtime["check_env"],
        )
    say(f"==> configuration in {plan['config_dir']}")
    previous = previous_revision(options.data_dir)
    plan["source_revision"] = tree_stamp(repo)
    written = write_outputs(plan, rendered, reconfigure=args.reconfigure)
    changed = (
        any(written[name] == "updated" for name in ("controller.json", "node.json"))
        or previous is None
        or previous != plan["source_revision"]
    )
    say("==> doctor")
    doctor_problems = run_doctor(plan)
    if doctor_problems and not args.skip_runtimes:
        raise StepError("doctor found problems (above)")
    if args.no_start:
        say(f"\ninstalled; start it with: uv run phasyn-studio up --data-dir {plan['data_dir']}")
        return EXIT_OK
    _, configs, pipelines = saved_state(options.data_dir)
    if plan["services"]["mode"] == "foreground":
        # never block: without systemd the services run under `up --foreground`, in a terminal or in the background
        data = plan["data_dir"]
        report = {
            "status": "not_started",
            "routes": {},
            "components": {},
            "weights": {},
            "errors": [],
            "next_steps": [
                f"start the services: uv run phasyn-studio up --foreground --data-dir {data}  (Ctrl+C stops them)",
                f"or in the background: nohup uv run phasyn-studio up --foreground --data-dir {data} "
                f"> {data}/services.log 2>&1 &  then poll: uv run phasyn-studio status --json --data-dir {data}",
            ],
        }
        return emit(args, plan, report)
    say("==> services")
    steps = start_services(plan, enable=args.enable, changed=changed, node_id=configs["node.json"]["node_id"])
    say("==> bring-up")
    return bring_up(args, plan, configs, pipelines, steps)


def previous_revision(data_dir: Path) -> str | None:
    try:
        value = json.loads((data_dir / PLAN_FILE).read_text(encoding="utf-8")).get("source_revision")
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) else None


def is_running(plan: Mapping[str, Any], controller_id: str) -> bool:
    """This installation's controller answers (read-only)."""
    api = bringup.Api(plan["services"]["controller"]["url"])
    try:
        info = api.request("GET", "/api/controller")
    except bringup.ApiError:
        return False
    finally:
        api.close()
    return isinstance(info, dict) and info.get("controller_id") == controller_id


def cmd_status(args: argparse.Namespace) -> int:
    """Read-only: GET requests to this installation's controller; nothing is started, created or changed."""
    data_dir = Path(args.data_dir).expanduser().absolute() if args.data_dir else planner.default_data_dir()
    plan, configs, pipelines = saved_state(data_dir)
    routes = resolve_routes(args.ready, plan)
    api = bringup.Api(plan["services"]["controller"]["url"])
    try:
        report = bringup.check(
            api,
            plan,
            pipelines,
            controller_id=configs["controller.json"]["instance_id"],
            node_id=configs["node.json"]["node_id"],
            routes=routes,
        ).to_dict()
    finally:
        api.close()
    return emit(args, plan, report)


def cmd_up(args: argparse.Namespace) -> int:
    if args.download_weights and not args.accept_licenses:
        raise StepError("--download-weights needs --accept-licenses: read the licenses in the plan first", EXIT_USAGE)
    data_dir = Path(args.data_dir).expanduser().absolute() if args.data_dir else planner.default_data_dir()
    plan, configs, pipelines = saved_state(data_dir)
    if args.foreground or plan["services"]["mode"] == "foreground":
        if is_running(plan, configs["controller.json"]["instance_id"]):
            if args.foreground:
                raise StepError("this installation's services are already running; `phasyn-studio status` reads them")
            return bring_up(args, plan, configs, pipelines)  # talk to the running services, never start a second pair
        if args.no_start:
            raise StepError("the services are not running: start them with `phasyn-studio up --foreground`")
        return foreground(args, plan, configs, pipelines)
    if not args.no_start:
        for role in ("controller", "node"):
            unit = plan["services"][role]["unit"]
            if not (service.user_unit_dir() / unit).is_file():
                raise StepError(
                    f"{unit} is not installed; run `phasyn-studio install` (or `up --foreground`)", EXIT_USAGE
                )
            service.systemctl("start", unit)
    return bring_up(args, plan, configs, pipelines)


def guarded(command: Callable[[argparse.Namespace], int]) -> Callable[[argparse.Namespace], int]:
    """Turn the expected failures into an error line and their exit code."""

    def run(args: argparse.Namespace) -> int:
        try:
            return command(args)
        except StepError as exc:
            say(f"error: {exc.message}")
            return exc.exit_code
        except service.ServiceError as exc:
            say(f"error: {exc.message}")
            return exc.exit_code

    return run


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--data-dir", help="where configuration, plan, runs and models live (default: $XDG_DATA_HOME/phasyn-studio)"
    )
    p.add_argument("--json", action="store_true", help="print the plan (dry run) or the result as JSON on stdout")
    p.add_argument("--no-load", action="store_true", help="start the services but do not load any model")
    p.add_argument("--ready", help="routes to make ready: pipeline ids or groups (default: the plan's ready_routes)")
    p.add_argument(
        "--download-weights", action="store_true", help="download the missing pinned weights through the Node"
    )
    p.add_argument("--accept-licenses", action="store_true", help="you have read and accept the licenses in the plan")
    p.add_argument("--build-sidecars", action="store_true", help="build missing AdaLN sidecars on the primary GPU")
    p.add_argument("--replace-dit", action="store_true", help="replace another idle DiT loaded on the Node")


def add_parsers(sub: Any) -> None:
    p = sub.add_parser("install", help="detect this machine, plan, install and start (see --dry-run)")
    p.add_argument("--dry-run", action="store_true", help="show the plan only; nothing is installed or written")
    p.add_argument("--yes", action="store_true", help="do not ask before installing (for scripts and agents)")
    p.add_argument("--repo-dir", help="the checkout (default: the one this command runs from)")
    p.add_argument("--models-dir", help="model weights directory (default: <data-dir>/models)")
    p.add_argument("--controller-port", type=int, default=8080)
    p.add_argument("--node-port", type=int, default=8090)
    p.add_argument(
        "--routes", help=f"route groups to set up, comma-separated: {','.join(planner.GROUPS)} (default: all that fit)"
    )
    p.add_argument("--primary-gpu", help="index or UUID of the GPU for the DiT (default: the largest)")
    p.add_argument("--services", choices=("auto", "systemd", "foreground"), default="auto")
    p.add_argument("--instance", default="main", help="service instance name (default: main)")
    p.add_argument("--enable", action="store_true", help="also start the services at login/boot (systemd enable)")
    p.add_argument("--reconfigure", action="store_true", help="replace configuration files that differ (old copy .bak)")
    p.add_argument("--rebuild-ui", action="store_true", help="build the web UI even if it looks current")
    p.add_argument("--skip-runtimes", action="store_true", help="do not build the GPU environments")
    p.add_argument("--no-start", action="store_true", help="install and configure, but do not start anything")
    p.add_argument("--plan-out", help="also write the plan JSON to this file (works with --dry-run)")
    _common(p)
    p.set_defaults(func=guarded(cmd_install))

    st = sub.add_parser("status", help="read-only check of an installation (GET requests only)")
    st.add_argument("--data-dir", help="the installation's data directory (default: $XDG_DATA_HOME/phasyn-studio)")
    st.add_argument("--json", action="store_true", help="print the result as JSON on stdout")
    st.add_argument("--ready", help="routes to judge: pipeline ids or groups (default: the plan's ready_routes)")
    st.set_defaults(func=guarded(cmd_status))

    u = sub.add_parser("up", help="start an installed deployment and bring its routes to ready")
    u.add_argument("--foreground", action="store_true", help="run the services in this terminal instead of systemd")
    u.add_argument("--no-start", action="store_true", help="do not start services; only check and load")
    _common(u)
    u.set_defaults(func=guarded(cmd_up))


__all__ = ["EXIT_BLOCKED", "EXIT_NOT_READY", "add_parsers", "build", "guarded", "human_plan"]
