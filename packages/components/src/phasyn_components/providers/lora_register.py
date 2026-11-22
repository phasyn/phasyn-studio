"""``lora.register``: place a trained LoRA file and its manifest in this Node's model directory.

The H3 DiT finds a LoRA by its manifest (``<model_path>/loras/<lora_id>.json``, or a relative manifest path
under ``<model_path>``); the manifest names the weight file relative to ``<model_path>``. This provider writes
both and nothing else:

* the weight goes to ``loras/trained/<lora_id>.peft.safetensors`` (a registered LoRA) or
  ``loras/training/<job>/<lora_id>.peft.safetensors`` (a checkpoint kept only for comparison renders);
* its bytes are verified against the FileRef's size and SHA-256 while they are copied;
* an existing file is never replaced by different bytes (the same bytes again is a no-op), and a manifest is
  written atomically;
* every path is built from validated identifiers and checked to stay inside ``<model_path>/loras`` without
  passing through a symbolic link.

``describe`` lists the manifests of ``<model_path>/loras`` (``facts.lora_library``), so a client can offer the
registered LoRAs of each Node.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..errors import ComponentError
from ..fs import atomic_write_json
from ..lora_training import constants
from ..provider import BaseProvider, Description, Port, RunContext, settings_schema
from ..settings import normalize_recording


LORA_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
JOB_DIR = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
LIBRARY_LIMIT = 200
_COPY_BLOCK = 1 << 20
_MANIFEST_MAX_BYTES = 256 * 1024
PARAMS: dict[str, Any] = {
    "lora_id": {"type": "string", "pattern": LORA_ID.pattern},
    "candidate_of": {
        "type": ["string", "null"],
        "pattern": JOB_DIR.pattern,
        "default": None,
        "description": "訓練工作代號：只放在 loras/training/<代號>/（比較用），不列入 LoRA 清單",
    },
}


def _refuse(message: str) -> ComponentError:
    return ComponentError("INVALID_ARGUMENT", message)


def _no_links(root: Path, path: Path) -> None:
    """Every component from ``root`` to ``path`` must be a real directory or a new leaf, never a link."""
    rel = path.relative_to(root)
    current = root
    for part in rel.parts:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode):
            raise _refuse("LoRA 目錄中有符號連結，拒絕寫入")


def library_root(model_path: str) -> Path:
    """``<model_path>/loras`` of an existing, real model directory."""
    root = Path(model_path)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ComponentError(
            "COMPONENT_NOT_CONFIGURED", "load.model_path 必須是存在的絕對路徑目錄"
        )
    loras = root / "loras"
    if loras.is_symlink():
        raise _refuse("loras 目錄是符號連結，拒絕寫入")
    return loras


def target_paths(
    model_path: str, lora_id: str, candidate_of: str | None
) -> tuple[Path, Path, str]:
    """(weight path, manifest path, weight path relative to model_path) for validated identifiers."""
    if not LORA_ID.fullmatch(lora_id):
        raise _refuse("lora_id 只能用小寫英數、點、底線與連字號")
    if candidate_of is not None and not JOB_DIR.fullmatch(candidate_of):
        raise _refuse("candidate_of 只能用小寫英數與連字號")
    loras = library_root(model_path)
    if candidate_of is None:
        weight = loras / "trained" / f"{lora_id}.peft.safetensors"
        manifest = loras / f"{lora_id}.json"
    else:
        folder = loras / "training" / candidate_of
        weight = folder / f"{lora_id}.peft.safetensors"
        manifest = folder / f"{lora_id}.json"
    for path in (weight, manifest):
        _no_links(loras.parent, path)
        if loras.parent.resolve() not in path.resolve().parents:
            raise _refuse("LoRA 路徑超出模型目錄")
    return weight, manifest, weight.relative_to(loras.parent).as_posix()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(_COPY_BLOCK):
            digest.update(block)
    return digest.hexdigest()


def place_weight(source: Path, target: Path, *, sha256: str, size_bytes: int) -> bool:
    """Copy ``source`` to ``target`` verifying size and SHA-256; True when a new file was written."""
    if target.exists():
        if not target.is_file() or target.is_symlink():
            raise _refuse("LoRA 目標不是一般檔案")
        if target.stat().st_size == size_bytes and _sha256(target) == sha256:
            return False
        raise ComponentError(
            "STATE_CONFLICT", "已有同名但內容不同的 LoRA 檔；不覆寫", status=409
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.part")
    digest = hashlib.sha256()
    written = 0
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(partial, flags, 0o644)
    try:
        with os.fdopen(fd, "wb") as out, source.open("rb") as handle:
            while block := handle.read(_COPY_BLOCK):
                out.write(block)
                digest.update(block)
                written += len(block)
            out.flush()
            os.fsync(out.fileno())
        if written != size_bytes or digest.hexdigest() != sha256:
            raise ComponentError(
                "INTEGRITY_MISMATCH", "LoRA 檔的大小或 SHA-256 與來源不符"
            )
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return True


def _library(model_path: str | None) -> list[dict[str, Any]]:
    if not model_path:
        return []
    try:
        loras = library_root(model_path)
        entries = sorted(
            p for p in loras.glob("*.json") if p.is_file() and not p.is_symlink()
        )
    except (ComponentError, OSError):
        return []
    out: list[dict[str, Any]] = []
    for path in entries[:LIBRARY_LIMIT]:
        try:
            if path.stat().st_size > _MANIFEST_MAX_BYTES:
                continue
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(doc, Mapping) or not doc.get("lora_id"):
            continue
        out.append(
            {
                "manifest_path": f"loras/{path.name}",
                "lora_id": str(doc["lora_id"]),
                "label": str(doc.get("label") or doc["lora_id"])[:200],
                "format": doc.get("format"),
                "variants": list(doc.get("variants") or [])[:4],
                "trained_here": str(doc.get("source_repo") or "").startswith(
                    "local:phasyn-training/"
                ),
            }
        )
    return out


class LoraRegisterProvider(BaseProvider):
    """Write a verified LoRA weight and its manifest under the Node's model directory."""

    provider_id = constants.PROVIDER_REGISTER

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe the ports and list the manifests already in the library."""
        load = (settings or {}).get("load") or {}
        return Description(
            provider_id=cls.provider_id,
            kind="lora.register",
            label="LoRA 登錄（把訓練好的 LoRA 與 manifest 放進此 Node 的模型目錄）",
            inputs=[
                Port(
                    "lora",
                    constants.LORA_FILE_TYPE,
                    required=True,
                    transport="file",
                    description="PEFT LoRA 權重（safetensors）",
                ),
                Port(
                    "manifest",
                    constants.MANIFEST_TYPE,
                    required=True,
                    transport="inline",
                    description="LoRA manifest（file 欄位由此元件填寫）",
                ),
            ],
            outputs=[
                Port(
                    "registered",
                    constants.REGISTERED_TYPE,
                    required=True,
                    transport="inline",
                    description="manifest_path（相對 load.model_path）、lora_id 與檔案 SHA-256",
                )
            ],
            settings_schema=settings_schema(
                invoke_properties=PARAMS,
                device_kinds=("cpu",),
                require_model_path=True,
            ),
            parameters_schema={
                "type": "object",
                "properties": PARAMS,
                "required": ["lora_id"],
                "additionalProperties": False,
            },
            default_settings={
                "load": {
                    "device": {
                        "kind": "cpu",
                        "id": "cpu",
                        "resource_group": "cpu-lora",
                    },
                    "model_path": "<models-dir>",
                },
                "invoke": {},
                "recording": normalize_recording({"mode": "summary"}),
            },
            facts={"lora_library": _library(load.get("model_path"))},
        )

    def invoke(self, ctx: RunContext) -> None:
        """Copy the weight, write the manifest and report where they are."""
        model_path = str((ctx.settings.get("load") or {}).get("model_path") or "")
        lora_id = str(ctx.parameters.get("lora_id") or "")
        candidate = ctx.parameters.get("candidate_of")
        weight_in = ctx.input("lora")
        ref = weight_in.file or {}
        doc = ctx.input("manifest").value
        if not isinstance(doc, Mapping) or doc.get("lora_id") != lora_id:
            raise _refuse("manifest.lora_id 必須等於參數 lora_id")
        weight, manifest_path, relative = target_paths(
            model_path, lora_id, None if candidate is None else str(candidate)
        )
        with ctx.recorder.span("lora.register.copy", part="lora.files"):
            written = place_weight(
                weight_in.require_path("lora"),
                weight,
                sha256=str(ref.get("sha256")),
                size_bytes=int(ref.get("size_bytes") or 0),
            )
        final = {
            **dict(doc),
            "file": {
                "relative_path": relative,
                "sha256": str(ref.get("sha256")),
                "size_bytes": int(ref.get("size_bytes") or 0),
            },
        }
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(manifest_path, final, indent=1)
        rel_manifest = manifest_path.relative_to(Path(model_path)).as_posix()
        ctx.recorder.log(
            "info",
            "LoRA 已登錄",
            lora_id=lora_id,
            new_file=written,
            candidate=bool(candidate),
        )
        ctx.set_output(
            "registered",
            {
                "lora_id": lora_id,
                "manifest_path": rel_manifest,
                "relative_path": relative,
                "sha256": str(ref.get("sha256")),
                "node_id": str(ctx.recorder.node_id),
                "candidate": candidate is not None,
            },
        )


__all__ = ["LoraRegisterProvider", "place_weight", "target_paths"]
