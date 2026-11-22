"""Publish native PAI contracts for the selected H3 DiT manifest, and the LoRA manifests a DiT can pick."""

from __future__ import annotations

import json
import os
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from phasyn_components.canonical import canonical_json, digest

from .config import ROLE_DEFAULTS
from .plan import BUNDLED_LORA_DIR, DEFAULT_PLAN_SAMPLING, LORA_MANIFEST_DIRS_ENV
from .recipe.adapter.loras import lora_role


# describe facts stay far below the descriptor's 16 KiB (phasyn_node.descriptor.FACTS_MAX_BYTES): the catalog
# takes what is left of this budget and is cut short, never the other facts
FACTS_BUDGET_BYTES = 12 * 1024
_CATALOG_MAX = 32
_MANIFEST_MAX_BYTES = 64 * 1024
_SCAN_MAX = 96
_LABEL_MAX = 60


_PAI_MANIFESTS = {
    "pai-h3-ref2va-acc8": "pai-h3-ref2va-acc8.json",
    "pai-h3-fl2va-acc8": "pai-h3-fl2va-acc8.json",
}


def _packaged(manifest: dict[str, Any]) -> dict[str, Any] | None:
    identifier = manifest.get("lora_id")
    if not isinstance(identifier, str) or identifier not in _PAI_MANIFESTS:
        return None
    resource = BUNDLED_LORA_DIR / _PAI_MANIFESTS[identifier]
    try:
        packaged = json.loads(resource.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if manifest != packaged or digest(manifest) != digest(packaged):
        return None
    return dict(packaged)


def pai_compatibility(key: str, manifest: dict[str, Any]) -> dict[str, Any] | None:
    """Publish weight and sampling identity only for an exact packaged contract."""
    packaged = _packaged(manifest)
    if packaged is None:
        return None
    return {
        "version": 1,
        "revision": str(packaged["lora_id"]) + "-v1",
        "adapters": {
            "layout": "single",
            "path": ["provider_options", "lora"],
            "key": ["manifest_path"],
            "key_encoding": "canonical_sha256",
            "allow_absent": True,
        },
        "unlisted": "allow",
        "rules": [_rule(key, packaged)],
    }


def pai_stack_compatibility(
    stack: list[tuple[str, dict[str, Any]]],
) -> dict[str, Any] | None:
    """The same contract for a ``provider_options.loras`` stack: one rule for its packaged PAI member.

    The other members are unlisted (allowed): their strength is free and the PAI contract is the run's grid.
    """
    rules: dict[str, dict[str, Any]] = {}
    for key, manifest in stack:
        packaged = _packaged(manifest)
        if packaged is not None and digest(key) not in rules:
            rules[digest(key)] = _rule(key, packaged)
    if not rules:
        return None
    return {
        "version": 1,
        "revision": "+".join(r["id"] for r in rules.values()) + "-stack-v1",
        "adapters": {
            "layout": "list",
            "path": ["provider_options", "loras"],
            "key": ["manifest_path"],
            "key_encoding": "canonical_sha256",
            "allow_absent": True,
        },
        "unlisted": "allow",
        "rules": list(rules.values()),
    }


def _rule(key: str, packaged: dict[str, Any]) -> dict[str, Any]:
    identifier = str(packaged["lora_id"])
    sampling = packaged["sampling_contract"]
    conditions = [
        {
            "scope": "load",
            "path": ["provider_options", "variant"],
            "allow": packaged["variants"],
            "default": ROLE_DEFAULTS["dit"]["provider_options"]["variant"],
        },
        {
            "scope": "adapter",
            "path": ["scale"],
            "allow": [packaged["fixed_scale"]],
            "default": 1.0,
        },
        *(
            {
                "scope": "invoke",
                "path": [field],
                "allow": sampling[field] if field == "steps" else [sampling[field]],
                "default": DEFAULT_PLAN_SAMPLING[field],
            }
            for field in ("steps", "video_shift", "audio_shift")
        ),
    ]
    return {
        "id": identifier,
        "match": digest(key),
        "role": "acceleration",
        "weight_revision": packaged["source_revision"],
        "weight_sha256": packaged["file"]["sha256"],
        "requires": conditions,
    }


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MANIFEST_MAX_BYTES:
            return None
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("family") != "minimax_h3":
        return None
    if not isinstance(doc.get("lora_id"), str) or not isinstance(
        doc.get("file"), Mapping
    ):
        return None
    return doc


def _catalog_entry(name: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
    contract = manifest.get("sampling_contract")
    steps = contract.get("steps") if isinstance(contract, Mapping) else None
    variants = manifest.get("variants")
    return {
        "manifest_path": name,
        "lora_id": str(manifest["lora_id"])[:128],
        "label": str(manifest.get("label") or manifest["lora_id"])[:_LABEL_MAX],
        "role": lora_role(manifest),
        "format": str(manifest.get("format")),
        "variants": [str(v) for v in variants][:4]
        if isinstance(variants, list)
        else [],
        "steps": [s for s in steps if isinstance(s, int)][:8]
        if isinstance(steps, list)
        else [],
        "fixed_scale": manifest.get("fixed_scale")
        if isinstance(manifest.get("fixed_scale"), (int, float))
        else None,
    }


def lora_catalog(
    model_root: Path,
    *,
    budget_bytes: int,
    env: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """The H3 LoRA manifests a DiT component can name in ``manifest_path``, in lookup order.

    The same directories as :func:`phasyn_h3.plan.lora_manifest_candidates` (``<model_root>``,
    ``<model_root>/loras``, ``PHASYN_H3_LORA_MANIFEST_DIRS``, the bundled manifests); a file name the earlier
    directory already provides is skipped (that is the one a load would read).  Only top-level ``*.json`` files of
    family ``minimax_h3``; at most ``budget_bytes`` of canonical JSON and :data:`_CATALOG_MAX` entries.
    """
    extra = (os.environ if env is None else env).get(LORA_MANIFEST_DIRS_ENV, "")
    bases = [
        model_root,
        model_root / "loras",
        *(Path(d) for d in extra.split(os.pathsep) if d),
        BUNDLED_LORA_DIR,
    ]
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    used = 2
    scanned = 0
    for base in bases:
        try:
            names = sorted(p.name for p in base.iterdir() if p.suffix == ".json")
        except OSError:
            continue
        for name in names:
            if name in seen or scanned >= _SCAN_MAX or len(out) >= _CATALOG_MAX:
                continue
            scanned += 1
            manifest = _read_manifest(base / name)
            if manifest is None:
                continue
            seen.add(name)
            entry = _catalog_entry(name, manifest)
            size = len(canonical_json(entry)) + 1
            if used + size > budget_bytes:
                return out
            out.append(entry)
            used += size
    return out
