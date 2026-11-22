"""Bounded static manifest reading and validation for native Python providers."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib.metadata
import json
import os
import stat
import sys
from collections.abc import Iterator
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .contracts import definition


_FIRST_PRINTABLE = 32
MAX_BYTES = 256 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class ManifestIssue(ValueError):  # noqa: N818 - Keep the SDK exception name available to callers.
    """Stable issue identifying an invalid declaration. No vendor-controlled text is exposed."""


@contextlib.contextmanager
def _dir(path: str, parent: int | None = None) -> Iterator[int]:
    fd = os.open(path, DIR_FLAGS, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


@cache
def _record_hashes(root: str) -> dict[str, str]:
    # Installers can hard-link wheel contents to a cache. Accept those aliases only
    # when the exact relative file and its digest appear in the installed wheel RECORD.
    hashes = {}
    for dist in importlib.metadata.distributions(path=[root]):
        for member in dist.files or ():
            rel = str(member)
            if (
                "/native_capabilities/" in rel
                and member.hash
                and member.hash.mode == "sha256"
            ):
                hashes[rel] = member.hash.value
    return hashes


def _read(fd: int, name: str, root: Path, package: str) -> bytes:
    handle = os.open(name, FILE_FLAGS, dir_fd=fd)
    with os.fdopen(handle, "rb") as stream:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_BYTES:
            raise ManifestIssue("invalid_file")
        approved = None
        if before.st_nlink != 1:
            approved = _record_hashes(str(root)).get(
                f"{package}/native_capabilities/{name}"
            )
            if approved is None:
                raise ManifestIssue("unverified_link")
        data = stream.read(MAX_BYTES + 1)
        if (
            approved is not None
            and base64.urlsafe_b64encode(hashlib.sha256(data).digest())
            .decode("ascii")
            .rstrip("=")
            != approved
        ):
            raise ManifestIssue("record_hash_mismatch")
        after = os.fstat(handle)
        if len(data) != before.st_size or (after.st_size, after.st_mtime_ns) != (
            before.st_size,
            before.st_mtime_ns,
        ):
            raise ManifestIssue("changed_during_read")
        return data


def package_data(package: str, name: str) -> bytes | None:
    # Follow the installed import search order, inspecting only ordinary packages. Neither
    # find_spec('package.child') nor importlib.resources.files(package) is cold for arbitrary plugins.
    """Read verified package data without importing the provider."""
    for item in sys.path:
        root = Path(item or os.curdir).absolute()
        if not root.is_dir():
            continue
        with contextlib.ExitStack() as stack:
            try:
                parent = stack.enter_context(_dir(root.anchor))
                for part in root.parts[1:]:
                    parent = stack.enter_context(_dir(part, parent))
                package_fd = stack.enter_context(_dir(package, parent))
            except FileNotFoundError:
                continue
            except NotADirectoryError:
                continue
            if not _has_init(package_fd):
                continue
            try:
                folder = stack.enter_context(_dir("native_capabilities", package_fd))
                return _read(folder, name, root, package)
            except FileNotFoundError:
                return None
    return None


def _has_init(fd: int) -> bool:
    try:
        return stat.S_ISREG(
            os.stat("__init__.py", dir_fd=fd, follow_symlinks=False).st_mode
        )
    except FileNotFoundError:
        return False


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object, rejecting duplicate keys."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ManifestIssue("duplicate_key")
        result[key] = value
    return result


def invalid_constant(_value: str) -> None:
    """Reject a non-finite JSON constant."""
    raise ManifestIssue("non_finite_number")


@cache
def _validator() -> Draft202012Validator:

    return Draft202012Validator(definition("NativeProviderManifest"))


def _local_schema(schema: Any) -> None:
    if not isinstance(schema, (dict, list)):
        return
    if isinstance(schema, dict):
        for key in ("$ref", "$dynamicRef", "$recursiveRef"):
            if key in schema and (
                not isinstance(schema[key], str) or not schema[key].startswith("#")
            ):
                raise ManifestIssue("external_schema_reference")
    for child in schema.values() if isinstance(schema, dict) else schema:
        _local_schema(child)


def read_manifest(raw: bytes, provider_id: str, target: str) -> dict[str, Any]:
    """SDK validation. Both identifier and class target must match the installed registry entry."""
    try:
        return _decode(raw, provider_id, target)
    except ManifestIssue:
        raise
    except (ValueError, RecursionError) as exc:
        raise ManifestIssue("unreadable_json") from exc
    except Exception as exc:
        raise ManifestIssue("invalid_embedded_schema") from exc


def _decode(raw: bytes, provider_id: str, target: str) -> dict[str, Any]:
    if not 0 < len(raw) <= MAX_BYTES:
        raise ManifestIssue("invalid_file")
    doc = json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=invalid_constant,
    )
    if not isinstance(doc, dict) or doc.get("schema_version") != "1.0":
        raise ManifestIssue("unsupported_manifest_version")
    if not _validator().is_valid(doc):
        raise ManifestIssue("schema_mismatch")
    if doc["provider_id"] != provider_id or doc["entry_point"] != target:
        raise ManifestIssue("registry_mismatch")
    for field in ("inputs", "outputs"):
        ports = [port["name"] for port in doc[field]]
        if len(ports) != len(set(ports)):
            raise ManifestIssue("duplicate_port")
    for field in ("settings_schema", "parameters_schema"):
        _local_schema(doc[field])
        Draft202012Validator.check_schema(doc[field])
    _check_model_files(doc["models"])
    return doc


def _check_model_files(models: list[dict[str, Any]]) -> None:
    for model in models:
        seen: set[str] = set()
        for asset in model["files"]:
            path = asset["path"]
            if (
                any(x in ("", ".", "..") for x in path.split("/"))
                or "\\" in path
                or ":" in path
                or any(ord(c) < _FIRST_PRINTABLE for c in path)
            ):
                raise ManifestIssue("invalid_model_file")
            if path in seen:
                raise ManifestIssue("duplicate_model_file")
            seen.add(path)
