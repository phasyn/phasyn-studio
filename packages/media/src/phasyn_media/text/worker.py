"""The worker process of the text renderer: one request on standard input, one answer on standard output.

``runner.render_texts`` starts it as ``python -I -c <bootstrap>``; it is the only process of this
package that loads native libraries, and it lives for one request. It imports only this package's
worker side, the generated document bounds of ``phasyn_components``, the standard library and NumPy.

The answer is one JSON object: ``{"result": ...}`` with exit status 0, or
``{"error": {"reason", "job_id", "item", "detail"}}`` with exit status 2. The descriptor the parent reads
is set aside first and standard output is pointed at standard error, so nothing a native library
prints can end up in the answer. Before anything is loaded the process limits its own address space
(:data:`MAX_ADDRESS_SPACE_BYTES`): whatever the request, the rasters, caches and libraries of one
run cannot take more memory than that; an allocation beyond it fails the run.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import resource
import sys
from typing import TYPE_CHECKING, Any

from .model import TextFailure, check_request, request_from_wire
from .native import require_supported_platform, unavailable


if TYPE_CHECKING:
    from .engine import Engine


MAX_REQUEST_BYTES = 256 * 1024 * 1024
# Measured: 300 px text covering an 8000x5000 canvas (the media limit) peaked at 813 MiB resident and ran under a
# 1 GiB address-space limit; the cap leaves room for many sizes in the glyph cache and long caption tracks.
MAX_ADDRESS_SPACE_BYTES = 8 * 1024**3
EXIT_ANSWERED = 0
EXIT_REFUSED = 2


def _limit_memory() -> None:
    """Lower the address-space limit of this process; a lower limit it inherited is kept."""
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    limit = (
        MAX_ADDRESS_SPACE_BYTES
        if soft == resource.RLIM_INFINITY
        else min(soft, MAX_ADDRESS_SPACE_BYTES)
    )
    resource.setrlimit(resource.RLIMIT_AS, (limit, hard))


def _render(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_REQUEST_BYTES:
        raise TextFailure("text_too_large", "request too large")
    try:
        request, out_dir = request_from_wire(json.loads(data))
    except (ValueError, KeyError, TypeError) as exc:
        raise TextFailure("text_render_failed", "unreadable request") from exc
    check_request(request)
    require_supported_platform()
    _limit_memory()
    try:
        engine_module = importlib.import_module(".engine", __package__)
    except ImportError as exc:
        raise unavailable(f"cannot import {exc.name}") from exc
    engine: Engine = engine_module.Engine()
    try:
        return engine.render(request, out_dir)
    finally:
        engine.close()


def _error(
    reason: str, job_id: str | None, item: int | None, detail: str | None
) -> dict[str, Any]:
    return {
        "error": {"reason": reason, "job_id": job_id, "item": item, "detail": detail}
    }


def main() -> int:
    """Run the isolated text-render worker."""
    answer_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    status = EXIT_REFUSED
    try:
        answer = {"result": _render(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))}
        status = EXIT_ANSWERED
    except TextFailure as failure:
        answer = _error(failure.reason, failure.job_id, failure.item, failure.detail)
    except Exception as exc:  # the process boundary: the parent gets the kind of failure, the trace stays on stderr
        logging.getLogger(__name__).exception("Text worker failed")
        answer = _error("text_render_failed", None, None, type(exc).__name__)
    with os.fdopen(answer_fd, "wb") as stream:
        stream.write(
            json.dumps(
                answer, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            ).encode("ascii")
        )
    return status


if __name__ == "__main__":
    sys.exit(main())
