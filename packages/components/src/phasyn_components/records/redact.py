"""Optional redaction for recording exports (diagnostic bundles people share).

A recording can carry the machine's hostname, GPU UUIDs, prompt text (``capture_prompt`` defaults
to true) and absolute model or data paths. :func:`parse_redact` turns user input into a set of
categories and :class:`Redactor` rewrites context, summary and event documents accordingly:

``hostname``
    values of ``hostname``, ``controller_label`` and ``node_label`` (labels default to the hostname), and the
    same names wherever they occur in later text; the host of Controller and Node addresses (``endpoint``,
    ``controller_endpoint``, ``advertise_url``, ``controller_url`` and API URLs under ``url``); and, in any
    text, the host of a URL when it is an IP address, a single-label name or a local domain. Public host
    names such as a weights source stay. Hardware details (GPU model, driver, memory) are not redacted.
``device_ids``
    ``device_id``-style keys, ``device.id``, ``CUDA_VISIBLE_DEVICES`` and any NVML ``GPU-…``/``MIG-…``
    UUID embedded in a string (for example a transfer's ``dst``).
``prompts``
    captured input values (``input_summary.*.value``) and prompt-named keys (``prompt``,
    ``negative_prompt``, ``prompt_text``, ``caption`` …). Free text inside log messages is not
    parsed for prompts.
``paths``
    absolute POSIX, home-relative and Windows paths anywhere in a string; only the file name stays
    (``/srv/models/x/model.safetensors`` -> ``<redacted>/model.safetensors``).

A recording's context is redacted before its events and summary, so names learned there are masked in them.

Redacted values become ``"<redacted>"``. The input documents are never modified.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable, Mapping
from typing import Any

from ..pathscrub import REDACTED, redact_paths

REDACT_FIELDS: frozenset[str] = frozenset({"hostname", "device_ids", "prompts", "paths"})
REDACT_ALL = "all"

_HOSTNAME_KEYS = frozenset({"hostname", "controller_label", "node_label"})
_ENDPOINT_KEYS = frozenset({"endpoint", "controller_endpoint", "advertise_url", "controller_url"})
_URL = re.compile(r"(?i)\b(https?://)(?:[^\s/@]*@)?(\[[0-9A-Fa-f:.%]+\]|[^\s/:?#\[\]\"'<>]+)")
_LOCAL_SUFFIXES = (".local", ".lan", ".internal", ".localdomain", ".home.arpa", ".localhost")
_NAME_MIN = 2  # a one-letter label would be masked inside unrelated words
_DEVICE_KEYS = frozenset({"device_id", "gpu_device_id", "gpu_uuid", "cuda_visible_devices", "pci_bus_id"})
_PROMPT_KEY = re.compile(r"^(?:[a-z0-9]+_)*prompts?$|^prompt_text$|^captions?$")
_GPU_UUID = re.compile(r"\b(?:GPU|MIG)-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b")


def parse_redact(values: Iterable[str]) -> frozenset[str]:
    """Normalise user input (repeatable and/or comma-separated) into redaction categories.

    ``all`` selects every category; an unknown name raises ``ValueError``.
    """
    selected: set[str] = set()
    for value in values:
        for raw in str(value).split(","):
            name = raw.strip()
            if not name:
                continue
            if name == REDACT_ALL:
                selected |= REDACT_FIELDS
            elif name in REDACT_FIELDS:
                selected.add(name)
            else:
                allowed = ", ".join(sorted({*REDACT_FIELDS, REDACT_ALL}))
                raise ValueError(f"unknown redact category {name!r}; expected one of: {allowed}")
    return frozenset(selected)


class Redactor:
    """Applies a fixed set of redaction categories to JSON-like documents."""

    def __init__(self, fields: Iterable[str] = ()) -> None:
        self.fields = parse_redact(fields)
        self._names: set[str] = set()  # host names and labels seen so far (lower case)
        self._names_re: re.Pattern[str] | None = None

    def __bool__(self) -> bool:
        return bool(self.fields)

    def _learn(self, name: str) -> None:
        name = name.strip().lower()
        if len(name) >= _NAME_MIN and name != REDACTED and name not in self._names:
            self._names.add(name)
            longest_first = sorted(self._names, key=len, reverse=True)
            self._names_re = re.compile(r"(?i)(?<![\w.-])(?:" + "|".join(map(re.escape, longest_first)) + r")(?![\w-])")

    def _private_host(self, host: str) -> bool:
        bare = host.strip("[]").partition("%")[0].lower().rstrip(".")
        if bare in self._names or "." not in bare or bare.endswith(_LOCAL_SUFFIXES):
            return True
        try:
            ipaddress.ip_address(bare)
        except ValueError:
            return False
        return True

    def _hosts(self, value: str, *, every: bool = False) -> str:
        """Mask URL hosts: all of them (an address field) or only installation-local ones (free text)."""

        def mask(match: re.Match[str]) -> str:
            if not (every or self._private_host(match.group(2))):
                return match.group(0)
            if every:
                self._learn(match.group(2).strip("[]"))
            return f"{match.group(1)}{REDACTED}"

        value = _URL.sub(mask, value)
        return self._names_re.sub(REDACTED, value) if self._names_re is not None else value

    def text(self, value: str) -> str:
        if "hostname" in self.fields:
            value = self._hosts(value)
        if "device_ids" in self.fields:
            value = _GPU_UUID.sub(REDACTED, value)
        if "paths" in self.fields:
            value = redact_paths(value)
        return value

    def document(self, doc: Any) -> Any:
        """Redacted deep copy of a context, summary or event (unchanged when no category is set)."""
        if not self.fields:
            return doc
        return self._walk(doc, key=None, parent_key=None)

    def _key_redacted(self, key: str | None, parent_key: str | None, value: Any) -> bool:
        if key is None or value is None:
            return False
        lowered = key.lower()
        if "hostname" in self.fields and lowered in _HOSTNAME_KEYS:
            return True
        if "device_ids" in self.fields and (lowered in _DEVICE_KEYS or (lowered == "id" and parent_key == "device")):
            return True
        # Under input_summary the keys are port names: the entry keeps its type_id, only "value" goes.
        return (
            "prompts" in self.fields
            and parent_key != "input_summary"
            and isinstance(value, (str, list, Mapping))
            and bool(_PROMPT_KEY.match(lowered))
        )

    def _walk(self, node: Any, *, key: str | None, parent_key: str | None) -> Any:
        if "hostname" in self.fields and key is not None and isinstance(node, str):
            lowered = key.lower()
            if lowered in _HOSTNAME_KEYS:
                self._learn(node)
            elif lowered in _ENDPOINT_KEYS or (lowered == "url" and "/api/" in node):
                return self.text(self._hosts(node, every=True))
        if self._key_redacted(key, parent_key, node):
            return REDACTED
        if isinstance(node, Mapping):
            out = {k: self._walk(v, key=str(k), parent_key=key) for k, v in node.items()}
            if "prompts" in self.fields and key is not None and parent_key == "input_summary" and "value" in out:
                out["value"] = REDACTED
            return out
        if isinstance(node, list):
            return [self._walk(item, key=None, parent_key=key) for item in node]
        if isinstance(node, str):
            return self.text(node)
        return node


__all__ = ["REDACTED", "REDACT_ALL", "REDACT_FIELDS", "Redactor", "parse_redact", "redact_paths"]
