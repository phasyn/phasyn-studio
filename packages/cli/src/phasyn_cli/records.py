"""``phasyn-studio records list|export``: the controller's recording index over HTTP (read-only)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from phasyn_components.records import EXPORT_FORMATS, REDACT_FIELDS
from phasyn_components.records.redact import REDACT_ALL

from .common import EXIT_FAILED, EXIT_OK, print_json

RECORD_FILTERS = (
    "node_id",
    "component_id",
    "provider_id",
    "run_id",
    "call_id",
    "part",
    "since",
    "until",
    "error_code",
    "precision",
    "config_digest",
    "operation",
    "cursor",
)
REDACT_CHOICES = (*sorted(REDACT_FIELDS), REDACT_ALL)  # the server's categories, one source


def add_parser(sub: Any) -> None:
    rec = sub.add_parser("records", help="查詢／匯出紀錄（HTTP client）")
    rec_sub = rec.add_subparsers(dest="records_cmd", required=True)
    lst = rec_sub.add_parser("list")
    lst.add_argument("--url", required=True)
    for key in RECORD_FILTERS:
        flag = "component" if key == "component_id" else key.replace("_", "-")
        lst.add_argument(f"--{flag}", dest=key)
    lst.add_argument("--limit", type=int)
    lst.add_argument("--json", action="store_true")
    exp = rec_sub.add_parser("export")
    exp.add_argument("--url", required=True)
    exp.add_argument("--recording", required=True)
    exp.add_argument("--format", choices=EXPORT_FORMATS, default="zip")
    exp.add_argument("--output", required=True)
    exp.add_argument(
        "--redact",
        action="append",
        choices=REDACT_CHOICES,
        help="遮罩診斷資料（可重複）：hostname、device_ids、prompts、paths（只留檔名）或 all",
    )
    rec.set_defaults(func=run)


def print_page(page: dict[str, Any]) -> None:
    for item in page.get("items", []):
        ctx, summary = item["context"], item["summary"]
        wall = (summary.get("metrics") or {}).get("host_wall_ms", {}).get("value")
        print(
            f"{ctx['created_at']}  {ctx['recording_id']}  {ctx['component_id']:<20} {ctx['operation']:<8} "
            f"{summary.get('state'):<10} {'' if wall is None else f'{wall:.0f} ms'}"
        )
    if page.get("next_cursor"):
        print(f"（下一頁：--cursor {page['next_cursor']}）")


def run(args: argparse.Namespace) -> int:
    from phasyn_components.errors import ComponentError

    from . import client

    try:
        if args.records_cmd == "list":
            filters = {key: getattr(args, key) for key in RECORD_FILTERS if getattr(args, key) is not None}
            if args.limit is not None:
                filters["limit"] = args.limit
            page = client.list_recordings(args.url, **filters)
            if args.json:
                print_json(page)
            else:
                print_page(page)
            return EXIT_OK
        output = Path(args.output).expanduser().resolve()
        final = client.export_recording(args.url, args.recording, args.format, output, redact=args.redact or ())
        print(f"已匯出 {final}")
        return EXIT_OK
    except ComponentError as exc:
        print(f"錯誤：[{exc.code}] {exc.message}", file=sys.stderr)
        return EXIT_FAILED


__all__ = ["RECORD_FILTERS", "REDACT_CHOICES", "add_parser", "print_page", "run"]
