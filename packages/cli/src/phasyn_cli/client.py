"""Synchronous HTTP client for ``phasyn-studio records list|export``.

It only reads recordings that a controller (or a Node, which serves the same shared routes) already
stored; there is no login or token. Errors are raised as ``ComponentError`` (code, message, HTTP status);
a server that cannot be reached becomes ``CONTROLLER_UNREACHABLE``.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import httpx
from phasyn_components import contracts
from phasyn_components.errors import ComponentError
from phasyn_components.fs import atomic_writer
from phasyn_components.records import EXPORT_FORMATS

DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)
_FILENAME_RE = re.compile(r'filename="?([^";]+)"?')
# A server's file name is used only when it is an ordinary export name: it starts with a letter or digit (never a
# dotfile) and ends in one of the export extensions. Anything else gets the client's own name.
_SAFE_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.(?:jsonl|csv|zip|json|gz)")


def base_url(url: str) -> str:
    text = url.strip().rstrip("/")
    return text if text.startswith(("http://", "https://")) else f"http://{text}"


def _unreachable(url: str, exc: httpx.HTTPError) -> ComponentError:
    return ComponentError("CONTROLLER_UNREACHABLE", f"無法連線到 {url}：{type(exc).__name__}", details={"url": url})


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        doc = resp.json()
    except ValueError:
        doc = None
    if isinstance(doc, dict) and contracts.is_valid("Error", doc):
        raise ComponentError.from_dict(doc, status=resp.status_code)
    raise ComponentError("RUNTIME_ERROR", f"HTTP {resp.status_code}：{resp.text[:300]}", status=resp.status_code)


def _client(url: str, timeout: httpx.Timeout | float, transport: httpx.BaseTransport | None) -> httpx.Client:
    return httpx.Client(
        base_url=base_url(url), timeout=timeout, transport=transport, trust_env=False, follow_redirects=False
    )


def list_recordings(
    url: str,
    *,
    timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
    transport: httpx.BaseTransport | None = None,
    **filters: Any,
) -> dict[str, Any]:
    """One RecordingPage; ``None`` and empty filters are left out of the query."""
    params = {k: str(v) for k, v in filters.items() if v is not None and v != ""}
    with _client(url, timeout, transport) as client:
        try:
            resp = client.get("/api/recordings", params=params)
        except httpx.HTTPError as exc:
            raise _unreachable(url, exc) from exc
        _raise_for(resp)
        page: dict[str, Any] = resp.json()
        return page


def get_recording(
    url: str,
    recording_id: str,
    *,
    timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    with _client(url, timeout, transport) as client:
        try:
            resp = client.get(f"/api/recordings/{recording_id}")
        except httpx.HTTPError as exc:
            raise _unreachable(url, exc) from exc
        _raise_for(resp)
        doc: dict[str, Any] = resp.json()
        return doc


def _target(output: Path, resp: httpx.Response, recording_id: str, fmt: str) -> Path:
    """``output`` itself, or a file inside it when ``output`` is an existing directory.

    The server's file name is taken only when it is an ordinary export name (:data:`_SAFE_NAME_RE`); the reply of
    another or a misbehaving server cannot name a dotfile or any other file of that directory.
    """
    if not output.is_dir():
        return output
    match = _FILENAME_RE.search(resp.headers.get("content-disposition", ""))
    name = match.group(1).strip() if match else ""
    if not _SAFE_NAME_RE.fullmatch(name):
        name = f"recording-{recording_id}.{'zip' if fmt == 'trace' else fmt}"
    return output / name


def export_recording(
    url: str,
    recording_id: str,
    fmt: str,
    output_path: str | os.PathLike[str],
    *,
    redact: Iterable[str] = (),
    timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
    transport: httpx.BaseTransport | None = None,
) -> Path:
    """Stream an export to ``output_path`` (atomic: a partial download never replaces the target).

    ``redact`` values are passed through as repeated ``redact=`` query parameters; the server validates them.
    """
    if fmt not in EXPORT_FORMATS:
        raise ComponentError("INVALID_ARGUMENT", f"format 必須是 {'、'.join(EXPORT_FORMATS)}", details={"format": fmt})
    params: list[tuple[str, str | int | float | bool | None]] = [("format", fmt)]
    params += [("redact", value) for value in redact]
    output = Path(output_path).expanduser()
    with _client(url, timeout, transport) as client:
        try:
            with client.stream("GET", f"/api/recordings/{recording_id}/export", params=params) as resp:
                if resp.status_code >= 400:
                    resp.read()
                    _raise_for(resp)
                target = _target(output, resp, recording_id, fmt)
                with atomic_writer(target) as fh:
                    for chunk in resp.iter_bytes():
                        fh.write(chunk)
        except httpx.HTTPError as exc:
            raise _unreachable(url, exc) from exc
    return target


__all__ = ["EXPORT_FORMATS", "base_url", "export_recording", "get_recording", "list_recordings"]
