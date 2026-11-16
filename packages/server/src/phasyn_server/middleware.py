"""Error policy and request guards installed on both the controller and the NodeGateway app.

- ``ComponentError`` → its status and contract ``Error`` body; request validation → 422; unknown paths → 404.
- Any other exception → 500 ``RUNTIME_ERROR`` carrying only the exception type. The message and stack go to
  the log, never to the client (messages may contain local paths).
- ``RequestGuard`` (checked before the app sees the request; none of this is authentication):
  - ``HostPolicy``: a ``Host`` header the service does not answer → 400 ``HOST_NOT_ALLOWED``. This is the
    defence against DNS rebinding, where the attacker's page and its requests share one origin and carry the
    attacker's host name. Without ``allowed_hosts`` the service answers IP address literals, ``localhost`` and
    its own names (the machine's host name, the host of ``advertise_url``, ``bind_host``); with ``allowed_hosts``
    it answers exactly that list.
  - Node: browsers never talk to a Node (the frontend goes through the controller's same-origin ``/api``).
    A request carrying ``Origin``, or ``Sec-Fetch-Site`` other than a manual address-bar ``GET``/``HEAD``
    (``none``), → 403 ``BROWSER_REQUEST_REJECTED``. httpx/urllib clients (controller, Nodes, CLI) send neither.
  - Controller: a write (POST/PUT/PATCH/DELETE) whose ``Origin`` differs from ``Host``, or that a browser marks
    ``Sec-Fetch-Site: cross-site``, → 400 ``BAD_REQUEST`` (another page writing through the user's browser).
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from collections.abc import Callable, Collection
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Literal, cast
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from phasyn_components.errors import ComponentError
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .http import HttpLimits, error_response

log = logging.getLogger("phasyn_server")

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]
Role = Literal["controller", "node"]

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
MANUAL_METHODS = frozenset({"GET", "HEAD"})
LABELS: dict[Role, str] = {"controller": "主控", "node": "Node "}
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _host_port(netloc: str, scheme: str) -> tuple[str, int | None]:
    """Lower-case host (no brackets, no trailing dot) and port of an authority; ``("", -1)`` when malformed."""
    try:
        parsed = urlsplit(f"{scheme}://{netloc}")
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError:
        return "", -1
    return host, port if port is not None else _DEFAULT_PORTS.get(scheme)


def same_origin(origin: str, host_header: str | None) -> bool:
    """Whether the browser Origin names the host of this request (default ports normalised)."""
    if not host_header or origin.strip().lower() == "null":
        return False
    try:
        parsed = urlsplit(origin.strip())
    except ValueError:
        return False
    scheme = (parsed.scheme or "").lower()
    if scheme not in _DEFAULT_PORTS or not parsed.netloc:
        return False
    return _host_port(parsed.netloc, scheme) == _host_port(host_header.strip(), scheme)


def _host_name(value: str) -> str:
    """One configured host name or IP address (no port), normalised like a parsed ``Host`` header."""
    return value.strip().strip("[]").lower().rstrip(".")


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.partition("%")[0])  # an IPv6 zone id is not part of the address
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class HostPolicy:
    """Which ``Host`` headers a service answers: the DNS-rebinding defence, not authentication.

    A page that reaches the service through a rebound DNS name sends the attacker's host name as ``Host``, and
    that name is in neither form of the policy:

    - ``listed`` (``allowed_hosts`` is set): exactly the listed host names and IP addresses.
    - ``local`` (``allowed_hosts`` is not set): every IP address literal, ``localhost`` (and ``*.localhost``),
      the machine's host name (also its short form and ``<short>.local``), the host of ``advertise_url`` and
      ``bind_host``. A request whose origin is an IP address cannot have been rebound, so literals are safe.
    """

    names: frozenset[str]
    ip_literals: bool

    @classmethod
    def listed(cls, hosts: Collection[str]) -> HostPolicy:
        return cls(frozenset(name for name in map(_host_name, hosts) if name), ip_literals=False)

    @classmethod
    def local(cls, *, advertise_url: str = "", bind_host: str = "") -> HostPolicy:
        names = {"localhost"}
        machine = _host_name(socket.gethostname())
        if machine:
            short = machine.partition(".")[0]
            names.update({machine, short, f"{short}.local"})
        advertised = _host_port(urlsplit(advertise_url).netloc, "http")[0] if advertise_url else ""
        names.update(name for name in (advertised, _host_name(bind_host)) if name)
        return cls(frozenset(names), ip_literals=True)

    @classmethod
    def for_service(
        cls, allowed_hosts: Collection[str] | None, *, advertise_url: str = "", bind_host: str = ""
    ) -> HostPolicy:
        """The policy of a Controller or Node configuration (``allowed_hosts`` wins when it is set)."""
        if allowed_hosts is not None:
            return cls.listed(allowed_hosts)
        return cls.local(advertise_url=advertise_url, bind_host=bind_host)

    def allows(self, host_header: str | None) -> bool:
        host = _host_port(host_header.strip(), "http")[0] if host_header else ""
        if not host:
            return False
        if host in self.names:
            return True
        return self.ip_literals and (_is_ip_literal(host) or host.endswith(".localhost"))

    def refusal(self, host_header: str | None) -> ComponentError:
        host = (host_header or "")[:200]
        if self.ip_literals:
            message = (
                f"Host {host!r} 不是這個服務的位址：請改用 IP 位址、localhost 或 advertise_url 的主機名稱連線，"
                "或在設定檔的 allowed_hosts 列出這個名稱"
            )
        else:
            message = f"Host {host!r} 不在 allowed_hosts 設定的清單內"
        return ComponentError("HOST_NOT_ALLOWED", message, details={"host": host})


def node_rejection(method: str, headers: Headers) -> ComponentError | None:
    """Any browser-originated request (manual address-bar GET/HEAD excepted)."""
    origin = headers.get("origin")
    site = headers.get("sec-fetch-site")
    if origin is None and site is None:
        return None
    if origin is None and site is not None and site.strip().lower() == "none" and method in MANUAL_METHODS:
        return None
    return ComponentError(
        "BROWSER_REQUEST_REJECTED",
        "Node 不接受瀏覽器直接發出的請求；請經由主控操作",
        details={"origin": (origin or "")[:200], "sec_fetch_site": (site or "")[:40]},
    )


def controller_rejection(method: str, headers: Headers) -> ComponentError | None:
    """Cross-site browser writes; reads and same-origin writes pass."""
    if method not in WRITE_METHODS:
        return None
    origin = headers.get("origin")
    site = (headers.get("sec-fetch-site") or "").strip().lower()
    if site != "cross-site" and (origin is None or same_origin(origin, headers.get("host"))):
        return None
    return ComponentError(
        "BAD_REQUEST",
        "跨站寫入請求被拒絕",
        details={"origin": (origin or "")[:200], "host": (headers.get("host") or "")[:200]},
    )


class RequestGuard:
    def __init__(self, app: ASGIApp, *, role: Role, hosts: HostPolicy) -> None:
        self.app = app
        self.role = role
        self.hosts = hosts

    def check(self, method: str, headers: Headers) -> ComponentError | None:
        if not self.hosts.allows(headers.get("host")):
            return self.hosts.refusal(headers.get("host"))
        return node_rejection(method, headers) if self.role == "node" else controller_rejection(method, headers)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            err = self.check(str(scope.get("method", "")).upper(), Headers(scope=scope))
            if err is not None:
                await error_response(err)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class ErrorBoundary:
    """Unexpected exception → 500 RUNTIME_ERROR with the exception type only (stack in the log)."""

    def __init__(self, app: ASGIApp, *, label: str) -> None:
        self.app = app
        self.label = label

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except ClientDisconnect:
            log.debug("用戶端在回應前中斷連線：%s %s", scope.get("method"), scope.get("path"))
        except Exception as exc:
            log.exception("未預期錯誤：%s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            err = ComponentError(
                "RUNTIME_ERROR",
                f"{self.label}內部錯誤：{type(exc).__name__}",
                details={"exception_type": f"{type(exc).__module__}.{type(exc).__qualname__}"},
            )
            await error_response(err)(scope, receive, send)


# Handlers are registered for exactly these exception types, hence the casts.
async def _component_error(_request: Request, exc: Exception) -> Response:
    return error_response(cast(ComponentError, exc))


async def _validation_error(_request: Request, exc: Exception) -> Response:
    errors = cast(RequestValidationError, exc).errors()
    problems = [f"{'/'.join(str(p) for p in item.get('loc', ()))}: {item.get('msg')}"[:500] for item in errors]
    err = ComponentError(
        "INVALID_ARGUMENT", f"請求參數不符合：{problems[0] if problems else ''}", details={"errors": problems[:20]}
    )
    return error_response(err)


async def _http_error(request: Request, raised: Exception) -> Response:
    exc = cast(StarletteHTTPException, raised)
    if exc.status_code == 404:
        err = ComponentError("NOT_FOUND", f"找不到路徑 {request.url.path}")
    elif exc.status_code == 405:
        err = ComponentError("METHOD_NOT_ALLOWED", f"{request.method} 不適用於 {request.url.path}")
    else:
        err = ComponentError("BAD_REQUEST", str(exc.detail), status=exc.status_code)
    return error_response(err, headers=getattr(exc, "headers", None))


def install(app: FastAPI, *, role: Role, limits: HttpLimits, hosts: HostPolicy) -> None:
    """Error handlers, the error boundary and the request guard; ``limits`` become the app's body limits."""
    app.state.http_limits = limits
    app.add_exception_handler(ComponentError, _component_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_middleware(ErrorBoundary, label=LABELS[role])
    app.add_middleware(RequestGuard, role=role, hosts=hosts)  # outermost


def create_api(
    *,
    title: str,
    version: str,
    role: Role,
    limits: HttpLimits,
    lifespan: Lifespan,
    hosts: HostPolicy,
) -> FastAPI:
    """A FastAPI app with the shared policy: no generated docs/OpenAPI, FastAPI's OpenTelemetry off."""
    app = FastAPI(
        title=title,
        version=version,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        telemetry={"tracing": False, "metrics": False, "logs": False, "auto_configure": False},
    )
    install(app, role=role, limits=limits, hosts=hosts)
    return app


__all__ = [
    "WRITE_METHODS",
    "ErrorBoundary",
    "HostPolicy",
    "RequestGuard",
    "Role",
    "controller_rejection",
    "create_api",
    "install",
    "node_rejection",
    "same_origin",
]
