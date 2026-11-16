"""``phasyn-studio`` command line.

    phasyn-studio controller --config /abs/controller.json
    phasyn-studio node --config /abs/node.json
    phasyn-studio records list --url http://<controller-host>:8080 [--component X ...]
    phasyn-studio records export --url http://<controller-host>:8080 --recording UUID --format zip --output ./diag.zip
    phasyn-studio service install|status|uninstall --role controller|node --instance workstation [--config ...]
    phasyn-studio doctor [--config node.json]
    phasyn-studio install [--dry-run] [--yes] [--json] …   (detect, plan, install, start; see install.py)
    phasyn-studio up [--foreground] [--json] …               (start an installation and bring its routes to ready)
    phasyn-studio status [--json]                            (read-only check of an installation)

Exit codes of ``install``, ``up`` and ``status`` are listed in install.py (5: not ready). Exit codes of ``records``,
``service`` and ``doctor``: 0 success, 2 invalid input or configuration, 3 unsupported
environment, 4 a remote or service manager operation failed. ``controller`` and ``node`` return the server's own
code instead: 0 after a normal shutdown, 1 a configuration or start failure, 2 the data_dir is locked by another
process.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from . import doctor, install, records, service
from .common import EXIT_FAILED, EXIT_OK, config_path, print_json


# ---------------------------------------------------------------------- controller / node
def cmd_controller(args: argparse.Namespace) -> int:
    """Exit codes come from the controller itself (1 configuration error, 2 data_dir locked)."""
    from phasyn_controller.main import run

    return int(run(str(Path(args.config).expanduser())))


def cmd_node(args: argparse.Namespace) -> int:
    """Exit codes come from the Node itself (1 configuration or start failure, 2 data_dir locked)."""
    from phasyn_node.main import run

    return int(run(str(Path(args.config).expanduser())))


# ---------------------------------------------------------------------- service
def cmd_service(args: argparse.Namespace) -> int:
    if args.service_cmd == "status":
        code, text = service.status(args.role, args.instance)
        sys.stdout.write(text)
        return EXIT_OK if code == 0 else EXIT_FAILED
    if args.service_cmd == "uninstall":
        path = service.uninstall(args.role, args.instance)
        print(f"已停止並移除 {path.name}")
        return EXIT_OK
    config = config_path(args.config)
    if args.print:
        sys.stdout.write(service.unit_text(args.role, args.instance, config))
        return EXIT_OK
    report = service.install(args.role, args.instance, config, start=args.start, enable=args.enable)
    summary = service.describe(report)
    if args.registry_dir:
        from . import registry

        registry_dir = Path(args.registry_dir).expanduser().resolve()
        try:
            manifest = registry.record(
                registry_dir, role=args.role, instance=args.instance, config=config, report=report
            )
        except OSError as exc:
            raise service.ServiceError(f"unit 已安裝，但部署登錄 {registry_dir} 寫入失敗：{exc}", EXIT_FAILED) from exc
        summary["manifest"] = str(manifest)
    print_json(summary)
    if args.enable and not service.linger_enabled():
        print("提醒：尚未啟用 linger；開機自動啟動需要登入（或執行 `loginctl enable-linger $USER`）")
    return EXIT_OK if report.verified else EXIT_FAILED


# ---------------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="phasyn-studio", description="Phasyn Studio（可配置元件與效能紀錄）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("controller", help="啟動 Controller（前景）")
    p.add_argument("--config", required=True)
    p.set_defaults(func=cmd_controller)
    p = sub.add_parser("node", help="啟動 NodeGateway（前景）")
    p.add_argument("--config", required=True)
    p.set_defaults(func=cmd_node)

    records.add_parser(sub)

    svc = sub.add_parser("service", help="systemd user service（安裝與啟用由使用者明確執行）")
    svc.add_argument("service_cmd", choices=["install", "status", "uninstall"])
    svc.add_argument("--role", choices=list(service.ROLES), required=True)
    svc.add_argument("--instance", required=True, help="主機實例名（例如 workstation、gpu-1）")
    svc.add_argument("--config")
    svc.add_argument("--start", action="store_true", help="安裝後啟動")
    svc.add_argument("--enable", action="store_true", help="開機（lingering 時）自動啟動")
    svc.add_argument("--print", action="store_true", help="只輸出 unit 內容")
    svc.add_argument(
        "--registry-dir",
        help="選用：另外寫入部署登錄（<dir>/services 的 manifest 與 <dir>/receipts 的 receipt）",
    )
    svc.set_defaults(func=cmd_service)

    doctor.add_parser(sub)
    install.add_parsers(sub)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "service" and args.service_cmd == "install" and not args.config:
        parser.error("service install 需要 --config")
    try:
        return int(args.func(args))
    except service.ServiceError as exc:
        print(f"錯誤：{exc.message}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
