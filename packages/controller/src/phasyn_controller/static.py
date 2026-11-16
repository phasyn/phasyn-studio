"""Frontend static files (static_dir) and the SPA fallback; the router's default (after every API route).

- An unknown path under ``/api`` → 404 Error JSON.
- Any other GET/HEAD: the file when it exists, otherwise index.html (a frontend route).
- A precompressed ``<file>.gz`` next to a file is sent instead when the client accepts gzip
  (``Content-Encoding: gzip``, ``Vary: Accept-Encoding``).
- Vite's hashed ``/assets/*`` are immutable (cached for a year); ``index.html`` is ``no-cache``.
- Without a static_dir the API still works; ``/`` answers with a short notice.
- Every response here forbids framing (``frame-ancestors 'none'`` and ``X-Frame-Options: DENY``): another site must
  not embed the UI, since writes made from it are same-origin and pass the browser write guard (clickjacking).
- The page itself (``index.html``) carries a full Content-Security-Policy: scripts only from this origin plus the
  page's own inline scripts (by SHA-256, computed from the file that is served), nothing from other origins, no
  plugins and no ``<base>``. The UI shows text that other clients stored (prompts, labels, file names, logs); if a
  rendering mistake ever let markup through, the policy still keeps a script from running or calling out.
"""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import re
from pathlib import Path

from phasyn_components.errors import ComponentError
from phasyn_server.http import accepts_gzip, error_response
from starlette.datastructures import Headers
from starlette.responses import FileResponse, HTMLResponse
from starlette.types import Receive, Scope, Send

NOTICE = """<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>Phasyn Studio 主控</title></head>
<body><h1>Phasyn Studio 主控 API 運作中</h1>
<p>找不到前端靜態檔（{state}）。請先建置前端（<code>pnpm build</code>），並在 controller.json 的
<code>static_dir</code> 指向建置輸出目錄後重啟主控。API 位於 <code>/api/</code>。</p></body></html>
"""

IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"
# Files other than the page: only the framing rule (a script or style sheet is not a document).
FRAME_HEADERS = {"Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY"}
HASHED_DIR = "assets/"  # Vite puts content-hashed file names here
_INLINE_SCRIPT = re.compile(rb"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)


def page_policy(index_html: bytes) -> str:
    """The Content-Security-Policy of the web UI page, with the hash of each inline script in ``index_html``.

    Inline styles stay allowed: the UI positions and animates elements through ``style`` attributes.
    """
    hashes = [
        "'sha256-" + base64.b64encode(hashlib.sha256(match.group(1)).digest()).decode("ascii") + "'"
        for match in _INLINE_SCRIPT.finditer(index_html)
        if match.group(1).strip()
    ]
    return "; ".join(
        [
            "default-src 'self'",
            " ".join(["script-src 'self'", *hashes]),
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


class SpaFallback:
    def __init__(self, static_dir: Path | None) -> None:
        self.static_dir = static_dir
        self.root: Path | None = None
        self._policy: tuple[tuple[int, int], str] | None = None  # (mtime_ns, size) of index.html → its policy
        if static_dir is not None and (static_dir / "index.html").is_file():
            self.root = static_dir.resolve()

    def _page_headers(self, index: Path) -> dict[str, str]:
        """Headers of the page; the policy is recomputed when index.html changes (a rebuilt UI needs no restart)."""
        try:
            info = index.stat()
            key = (info.st_mtime_ns, info.st_size)
            if self._policy is None or self._policy[0] != key:
                self._policy = (key, page_policy(index.read_bytes()))
            policy = self._policy[1]
        except OSError:
            policy = FRAME_HEADERS["Content-Security-Policy"]
        return {"Content-Security-Policy": policy, "X-Frame-Options": "DENY"}

    def _inside(self, rel: str) -> Path | None:
        """The file ``rel`` names under the root (symlinks resolved), or None."""
        if self.root is None:
            return None
        try:
            candidate = (self.root / rel).resolve()
            return candidate if candidate.is_relative_to(self.root) and candidate.is_file() else None
        except (OSError, ValueError):
            return None

    def _response(self, path: Path, rel: str, scope: Scope, cache_control: str) -> FileResponse:
        headers = {
            "Cache-Control": cache_control,
            **(self._page_headers(path) if rel == "index.html" else FRAME_HEADERS),
        }
        compressed = self._inside(f"{rel}.gz") if not rel.endswith(".gz") else None
        if compressed is None:
            return FileResponse(path, headers=headers)
        headers["Vary"] = "Accept-Encoding"
        if not accepts_gzip(Headers(scope=scope).get("accept-encoding")):
            return FileResponse(path, headers=headers)
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return FileResponse(compressed, headers={**headers, "Content-Encoding": "gzip"}, media_type=media_type)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        path = str(scope.get("path") or "/")
        method = str(scope.get("method") or "GET").upper()
        if path == "/api" or path.startswith("/api/"):
            await error_response(ComponentError("NOT_FOUND", f"找不到 API 路徑 {path}"))(scope, receive, send)
            return
        if method not in ("GET", "HEAD"):
            err = ComponentError("METHOD_NOT_ALLOWED", f"{method} 不適用於 {path}")
            await error_response(err)(scope, receive, send)
            return
        if self.root is None:
            # The configured path stays out of the page: responses carry no absolute paths.
            body = NOTICE.format(
                state="未設定 static_dir" if self.static_dir is None else "static_dir 內沒有 index.html"
            )
            await HTMLResponse(body, status_code=200 if path == "/" else 404, headers=FRAME_HEADERS)(
                scope, receive, send
            )
            return
        rel = path.lstrip("/")
        found = self._inside(rel) if rel else None
        if found is None or rel == "index.html":
            index = self.root / "index.html"
            await self._response(index, "index.html", scope, NO_CACHE)(scope, receive, send)
            return
        cache_control = IMMUTABLE if rel.startswith(HASHED_DIR) else NO_CACHE
        await self._response(found, rel, scope, cache_control)(scope, receive, send)


__all__ = ["FRAME_HEADERS", "IMMUTABLE", "NO_CACHE", "SpaFallback"]
