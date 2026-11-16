"""Find local filesystem paths inside free text (exception messages, tool stderr, log lines).

Two policies share one tokenizer:

- :func:`mask_paths` is for error messages that reach the wire: an absolute POSIX path with at least
  two components becomes its file name (``Error while loading /srv/models/x/y.safetensors`` ->
  ``Error while loading y.safetensors``). URLs, relative paths, ratios and dates are left alone.
- :func:`redact_paths` is for diagnostic exports with ``paths`` redaction: every absolute path
  (POSIX, ``~/...`` or a Windows drive) becomes ``<redacted>/<file name>``.

Local file URLs count as paths: ``file:///srv/x/y.txt`` is rewritten as ``file:/srv/x/y.txt`` and then
masked (``file:y.txt``) or redacted (``file:<redacted>/y.txt``).
"""

from __future__ import annotations

import re
from collections.abc import Callable

REDACTED = "<redacted>"

# An absolute path token: an optional "~" or drive prefix, then a separator that does not start "//"
# (URLs, UNC shares), then path characters. It must not continue a word, a relative path or a number.
# A directory name with a space continues the token when more of the path follows (``/srv/big models/x.bin``):
# the part after the space must reach another separator and never starts a second absolute path.
_PATH_CHARS = r"[^\s'\"`<>|;:,()\[\]{}]"
_PATH = re.compile(
    r"(?<![\w.~/\\-])(?:~|[A-Za-z]:)?[/\\](?![/\\])"
    + _PATH_CHARS
    + r"*(?:[ ][^\s'\"`<>|;:,()\[\]{}/\\]+[/\\]"
    + _PATH_CHARS
    + r"*)*"
)
_SEPARATORS = re.compile(r"[/\\]")
# A local file URL (``file:///srv/x``) is written as ``file:/srv/x`` first, so its path is found like any other.
_FILE_URL = re.compile(r"(?i)\bfile://(?=/)")


def scrub_paths(text: str, replace: Callable[[str, list[str]], str | None]) -> str:
    """Rewrite each path token with ``replace(token, components)``; ``None`` keeps the token as is.

    A trailing ``.`` (end of a sentence) is never part of the token.
    """

    def substitute(match: re.Match[str]) -> str:
        token = match.group(0)
        body = token.rstrip(".")
        trailing = token[len(body) :]
        parts = [part for part in _SEPARATORS.split(body) if part]
        replaced = replace(body, parts) if parts else None
        return token if replaced is None else replaced + trailing

    return _PATH.sub(substitute, _FILE_URL.sub("file:", text))


def mask_paths(text: str) -> str:
    """Absolute POSIX paths with two or more components -> their file name."""

    def basename(token: str, parts: list[str]) -> str | None:
        return parts[-1] if token.startswith("/") and len(parts) >= 2 else None

    return scrub_paths(text, basename)


def redact_paths(text: str) -> str:
    """Every absolute path -> ``<redacted>/<file name>`` (``<redacted>`` when there is no name)."""

    def redacted(token: str, parts: list[str]) -> str:
        name = parts[-1] if parts and parts[-1] not in ("~",) and not parts[-1].endswith(":") else ""
        return f"{REDACTED}/{name}" if name else REDACTED

    return scrub_paths(text, redacted)


__all__ = ["REDACTED", "mask_paths", "redact_paths", "scrub_paths"]
