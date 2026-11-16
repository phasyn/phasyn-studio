"""Guards for runtimes that rely on private upstream code (monkey patches against pinned packages).

A runtime that patches or reads a private symbol of a pinned dependency must notice when that
symbol changes, instead of degrading silently. This module only answers questions; each layer
decides what a failed check means (the recipe raises its own error type, a provider's ``load``
raises ``ComponentError("UPSTREAM_PATCH_SOURCE_MISMATCH")``, ``describe`` reports the provider as
unavailable). Standard library only; it never imports the guarded packages itself.

- :func:`source_sha256`: the pinned fingerprint of a function or class (its source text).
- :func:`mismatches`: check many pins at once; a symbol that no longer exists is a mismatch, not an
  exception. Pins resolve their target lazily, so building the pin list imports nothing.
- :func:`missing_attrs`: attributes (dotted paths allowed) an object no longer has.
- :func:`distribution_problem`: the installed distribution's version and VCS commit, from package
  metadata alone (usable in ``describe`` without importing the package).
- :func:`library_versions` / :func:`vcs_source`: installed versions (and VCS commits) for the
  ``runtime_identity`` of a recording.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import inspect
import json
import urllib.parse
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any


def source_sha256(obj: object) -> str:
    """SHA-256 of ``inspect.getsource(obj)``, or ``"unavailable:<Exception>"`` when it has no source."""
    try:
        source = inspect.getsource(obj)  # type: ignore[arg-type]
    except (OSError, TypeError) as exc:  # builtins, C extensions, wrappers without source
        return f"unavailable:{type(exc).__name__}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Pin:
    """``target`` returns the pinned object when called (lazy: nothing is imported until checked)."""

    label: str
    target: Callable[[], object]
    sha256: str


@dataclass(frozen=True)
class Mismatch:
    label: str
    expected: str
    actual: str  # a SHA-256, "unavailable:<Exception>" (no source) or "missing:<Exception>" (target gone)


def mismatches(pins: Iterable[Pin]) -> list[Mismatch]:
    """Every pin whose target's current source differs from the pinned fingerprint."""
    found: list[Mismatch] = []
    for pin in pins:
        try:
            target = pin.target()
        except (AttributeError, ImportError, KeyError, TypeError) as exc:  # the pinned symbol is gone
            actual = f"missing:{type(exc).__name__}"
        else:
            actual = source_sha256(target)
        if actual != pin.sha256:
            found.append(Mismatch(pin.label, pin.sha256, actual))
    return found


def missing_attrs(obj: object, names: Iterable[str]) -> list[str]:
    """The names (``"a.b.c"`` dotted paths allowed) that ``obj`` no longer provides."""
    missing: list[str] = []
    for name in names:
        current = obj
        for part in name.split("."):
            if not hasattr(current, part):
                missing.append(name)
                break
            current = getattr(current, part)
    return missing


def distribution_problem(name: str, *, version: str | None = None, vcs_commit: str | None = None) -> str | None:
    """Why the installed distribution ``name`` does not match its pin, or ``None`` when it does.

    ``vcs_commit`` may be abbreviated; it is compared with the commit recorded in the
    distribution's ``direct_url.json`` (PEP 610), which only VCS installs have. An empty pin is a
    programming error (every commit would start with it).
    """
    if vcs_commit is not None and not vcs_commit.strip():
        raise ValueError(f"empty vcs_commit pin for {name}")
    try:
        dist = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        return f"{name} is not installed"
    if version is not None and dist.version != version:
        return f"{name} {dist.version} is installed, {version} is pinned"
    if vcs_commit is not None:
        commit = _vcs_commit(dist)
        if commit is None:
            return f"{name} has no recorded VCS commit, {vcs_commit} is pinned"
        if not commit.lower().startswith(vcs_commit.lower()):
            return f"{name} was installed from {commit[:12]}, {vcs_commit} is pinned"
    return None


def _direct_url(dist: importlib.metadata.Distribution) -> dict[str, Any] | None:
    raw = dist.read_text("direct_url.json")
    if not raw:
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        return None
    return doc if isinstance(doc, dict) else None


def _vcs_commit(dist: importlib.metadata.Distribution) -> str | None:
    info = (_direct_url(dist) or {}).get("vcs_info")
    commit = info.get("commit_id") if isinstance(info, dict) else None
    return commit if isinstance(commit, str) and commit else None


_PUBLIC_VCS_SCHEMES = frozenset({"https", "http", "ssh", "git"})


def _public_url(url: object) -> str | None:
    """A VCS URL fit for a recording: no credentials, query or fragment; ``None`` for a local checkout.

    ``direct_url.json`` keeps the URL exactly as installed, which can be ``file:///home/<user>/…`` or
    carry a token (``https://user:token@host/…``); neither may reach a recording or an export.
    """
    if not isinstance(url, str):
        return None
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    host = parts.hostname
    if parts.scheme.lower() not in _PUBLIC_VCS_SCHEMES or not host:
        return None
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    return urllib.parse.urlunsplit((parts.scheme.lower(), netloc, parts.path, "", ""))


def vcs_source(name: str) -> dict[str, Any] | None:
    """``{"url", "commit_id"}`` of a distribution installed from a VCS checkout, else ``None``.

    ``url`` is the remote without credentials, or ``None`` for a local checkout (see :func:`_public_url`).
    """
    try:
        dist = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    commit = _vcs_commit(dist)
    if commit is None:
        return None
    return {"url": _public_url((_direct_url(dist) or {}).get("url")), "commit_id": commit}


def library_versions(names: Iterable[str], *, vcs: Iterable[str] = ("diffusers",)) -> dict[str, str | None]:
    """Installed versions of ``names`` (``None`` when missing, never guessed), for runtime identity.

    Each name in ``vcs`` that was installed from a VCS checkout also gets ``"<name>_commit"``.
    """
    out: dict[str, str | None] = {}
    for name in names:
        try:
            out[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            out[name] = None
    for name in vcs:
        source = vcs_source(name)
        if source is not None:
            out[f"{name}_commit"] = str(source["commit_id"])
    return out


__all__ = [
    "Mismatch",
    "Pin",
    "distribution_problem",
    "library_versions",
    "mismatches",
    "missing_attrs",
    "source_sha256",
    "vcs_source",
]
