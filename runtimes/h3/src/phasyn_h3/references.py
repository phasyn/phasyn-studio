"""拆開的參考編碼：partial bundle（video／audio）的讀取、空 partial 與合併（torch-free）.

``h3.video_encode`` 與 ``h3.audio_encode`` 各跑一次 recipe ``encode_references``（``reference_scope``
= ``visual``／``audio``），輸出 partial bundle；``h3.dit`` 在 ``assemble_inputs`` 之前把兩者合併成
``h3.reference``（``reference_scope=all``）會寫出的同一份 bundle：

* blocks\N{FULLWIDTH EQUALS SIGN}visual blocks（素材順序）\N{FULLWIDTH PLUS SIGN}audio blocks（素材順序），tensor 名稱本來就與合併版相同；
* payload 用同一個 writer（``write_reference_bundle``：依名稱排序、同一份 ``phasyn.metadata``）重寫，
  tensor bytes 直接從 partial payload 複製（不經 torch、不轉 dtype）→ payload SHA-256 與合併版相同；
* manifest 的 identity 中只有 ``plan_digest`` 不會相同（兩個 partial 由不同元件、不同 profile 建 plan），
  這裡記為兩個 partial plan digest 的 canonical digest。

不一致一律拒絕（不同請求、不同模型設定、缺少應有的 audio partial），不猜、不補。
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from phasyn_components.errors import ComponentError

from phasyn_h3.recipe.abi.canonical import canonical_digest
from phasyn_h3.recipe.abi.tensors import read_header_from_file


VIDEO_REFERENCES = "h3.references.video.v1"
AUDIO_REFERENCES = "h3.references.audio.v1"
EMPTY_KIND = "reference_latents_empty"
SCOPE_OF_PORT = {"video_references": "visual", "audio_references": "audio"}
_SHARED_KEYS = (
    "materials",
    "task",
    "normalized",
    "encode_seed",
    "sglang",
    "scope_sources",
    "prepared_payload_sha256",
)
_IDENTITY_KEYS = (
    "model_digest",
    "adapter_digest",
    "normalization_config_digest",
    "stage_id",
)


def _shim(exc: Exception, code: str = "INVALID_ARGUMENT") -> ComponentError:
    message = getattr(exc, "message", None) or str(exc)
    reason = getattr(exc, "reason_code", None)
    return ComponentError(
        code, f"參考 latent bundle 不合法：{message}", details={"reason_code": reason}
    )


@dataclass
class Partial:
    """一個 partial：manifest（空 partial 為 None）、本機 payload 路徑與其 ``phasyn.metadata``."""

    scope: str
    metadata: dict[str, Any]
    manifest: dict[str, Any] | None = None
    payload: Path | None = None

    @property
    def empty(self) -> bool:
        """Create a reference set without inputs."""
        return self.manifest is None

    @property
    def blocks(self) -> list[dict[str, Any]]:
        """Return the ordered reference blocks."""
        return [dict(b) for b in self.metadata.get("blocks") or []]


@dataclass
class MergedReferences:
    """Hold the ordered references consumed by the H3 job."""

    manifest_path: Path
    payload_path: Path
    artifact_id: str
    payload_sha256: str
    blocks: list[dict[str, Any]]
    sources: dict[str, Any] = field(default_factory=dict)


def empty_partial_document(
    prepared: Mapping[str, Any], *, task: str, scope: str = "audio"
) -> dict[str, Any]:
    """沒有這個範圍的素材時（例如 ref2va 只有圖片）audio encode 的輸出：0 個 block，不寫 payload.

    metadata 由 recipe ``reference_metadata`` 產生，與真正的 partial 同一結構（scope_sources、
    prepared_payload_sha256 都有），合併時同樣核對。
    """
    from phasyn_h3.recipe.runtime.stages.encode_references import reference_metadata  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

    metadata = reference_metadata(
        [],
        list(prepared.get("materials") or []),
        task,
        scope=scope,
        prepared_payload_sha256=str(
            (prepared.get("payload") or {}).get("sha256") or ""
        ),
    )
    return {
        "schema_version": "1.0",
        "kind": EMPTY_KIND,
        "reference_scope": scope,
        "metadata": metadata,
    }


def load_partial(
    manifest_path: Path, payload_path: Path | None, *, scope: str
) -> Partial:
    """讀一個 partial（tensor-bundle manifest\N{FULLWIDTH PLUS SIGN}payload，或空 partial 文件）並核對 scope 與完整性."""
    from phasyn_h3.recipe.runtime.bundles import (  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
        load_bundle_manifest,
        read_bundle_metadata,
        resolve_payload,
    )
    from phasyn_h3.recipe.runtime.errors import ShimError  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

    try:
        doc = json.loads(Path(manifest_path).read_bytes())
    except (OSError, ValueError) as exc:
        raise ComponentError(
            "INVALID_ARGUMENT", f"無法讀取 {scope} partial：{exc}"
        ) from exc
    if not isinstance(doc, dict):
        raise ComponentError("INVALID_ARGUMENT", f"{scope} partial 不是 JSON object")
    if doc.get("kind") == EMPTY_KIND:
        return _empty_partial(doc, scope)
    try:
        manifest = load_bundle_manifest(Path(manifest_path))
        if manifest["kind"] != "reference_latents":
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"{scope} partial 的 kind 是 {manifest['kind']}，不是 reference_latents",
            )
        if payload_path is None:
            raise ComponentError(
                "INVALID_ARGUMENT", f"{scope} partial 缺少 payload 附檔"
            )
        payload = resolve_payload(
            manifest, {str(manifest["payload"]["artifact_id"]): Path(payload_path)}
        )
        metadata = read_bundle_metadata(payload, manifest)
    except ShimError as exc:
        raise _shim(
            exc,
            "LATENT_SOURCE_MISMATCH"
            if "MISMATCH" in str(exc.reason_code)
            else "INVALID_ARGUMENT",
        ) from exc
    found = metadata.get("reference_scope")
    if found != scope:
        what = "合併版（h3.reference）" if found is None else f"{found} partial"
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"這個輸入需要 {scope} partial，收到的是 {what}；合併版請接 references，partial 請接對應的連接埠",
        )
    return Partial(
        scope=scope,
        metadata=dict(metadata),
        manifest=dict(manifest),
        payload=Path(payload),
    )


def _tensor_bytes(payload: Path, names: Sequence[str]) -> dict[str, bytes]:

    header = read_header_from_file(payload)
    out: dict[str, bytes] = {}
    with payload.open("rb") as fh:
        for name in names:
            info = header.tensors.get(name)
            if info is None:
                raise ComponentError(
                    "LATENT_SOURCE_MISMATCH", f"{payload.name} 缺少 tensor {name}"
                )
            fh.seek(header.data_offset + info.start)
            data = fh.read(info.byte_length)
            if len(data) != info.byte_length:
                raise ComponentError(
                    "LATENT_SOURCE_MISMATCH", f"{name}：payload 讀取長度不足"
                )
            out[name] = data
    return out


def _check_blocks(
    blocks: Sequence[Mapping[str, Any]],
    expected: Sequence[int],
    *,
    scope: str,
    base: int,
) -> None:
    indices = [int(b.get("material_index", -1)) for b in blocks]
    if indices != [int(i) for i in expected]:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            f"{scope} partial 的 block 素材 {indices} ≠ 此請求應編碼的 {list(expected)}",
            details={"scope": scope, "blocks": indices, "expected": list(expected)},
        )
    for offset, block in enumerate(blocks):
        want = f"{block.get('kind')}_{base + offset:02d}"
        if block.get("tensor") != want:
            raise ComponentError(
                "LATENT_SOURCE_MISMATCH",
                f"{scope} partial 的 tensor 名稱 {block.get('tensor')} ≠ 合併版的 {want}",
            )


def merge_partials(
    video: Partial | None,
    audio: Partial | None,
    *,
    out_dir: Path,
    prepared_payload_sha256: str | None = None,
    task: str | None = None,
) -> MergedReferences:
    """visual\N{FULLWIDTH PLUS SIGN}audio partial → 合併版 bundle（寫到 ``out_dir``；payload 與 h3.reference 逐位元相同）."""
    from phasyn_h3.recipe.runtime.bundles import BundleIdentity, TensorDecl  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
    from phasyn_h3.recipe.runtime.errors import ShimError  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
    from phasyn_h3.recipe.runtime.stages.encode_references import (  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
        reference_metadata,
        write_reference_bundle,
    )

    if video is None or video.empty:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "需要 video_references（Video VAE Encode 的輸出）；ref2va／fl2va 一定有影像素材",
        )
    vm = video.metadata
    sources = vm.get("scope_sources") or {}
    visual_sources = [int(i) for i in sources.get("visual") or []]
    audio_sources = [int(i) for i in sources.get("audio") or []]
    _check_audio_partial(audio, vm, audio_sources)
    _check_partial_identity(vm, prepared_payload_sha256, task)
    visual_blocks = video.blocks
    audio_blocks = audio.blocks if audio is not None else []
    _check_blocks(visual_blocks, visual_sources, scope="visual", base=0)
    _check_blocks(audio_blocks, audio_sources, scope="audio", base=len(visual_sources))
    manifests = [
        p.manifest for p in (video, audio) if p is not None and p.manifest is not None
    ]
    for key in _IDENTITY_KEYS:
        values = {str(m.get(key)) for m in manifests}
        if len(values) != 1:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"video／audio partial 的 {key} 不同（不同模型設定或不同 runtime 版本）；不合併",
                details={"field": key, "values": sorted(values)},
            )
    items: list[tuple[Any, bytes]] = []
    for part in (video, audio):
        if part is None or part.manifest is None or part.payload is None:
            continue
        specs = list(part.manifest.get("tensors") or [])
        data = _tensor_bytes(part.payload, [str(t["name"]) for t in specs])
        for spec in specs:
            decl = TensorDecl(
                str(spec["name"]),
                str(spec["dtype"]),
                tuple(int(d) for d in spec["shape"]),
                str(spec["layout"]),
            )
            items.append((decl, data[decl.name]))
    names = [d.name for d, _ in items]
    if sorted(names) != sorted(
        str(b["tensor"]) for b in [*visual_blocks, *audio_blocks]
    ) or len(set(names)) != len(names):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH", "partial payload 的 tensor 與 blocks 不一致"
        )
    first = video.manifest or {}
    identity = BundleIdentity(
        model_digest=str(first["model_digest"]),
        adapter_digest=str(first["adapter_digest"]),
        plan_digest=str(
            canonical_digest(
                {
                    "merged_reference_partials": {
                        "visual": first.get("plan_digest"),
                        "audio": None
                        if audio is None or audio.manifest is None
                        else audio.manifest.get("plan_digest"),
                    }
                }
            )
        ),
        stage_id=str(first["stage_id"]),
        normalization_config_digest=str(first["normalization_config_digest"]),
    )
    metadata = reference_metadata(
        [*visual_blocks, *audio_blocks],
        list(vm["materials"]),
        str(vm["task"]),
        scope="all",
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        outputs, manifest = write_reference_bundle(
            out_dir, items, metadata, identity, to_bytes=lambda raw: raw
        )
    except ShimError as exc:
        raise _shim(exc, "RUNTIME_ERROR") from exc
    by_name = {o.name: o for o in outputs}
    return MergedReferences(
        manifest_path=Path(by_name["references"].path),
        payload_path=Path(by_name["references.payload"].path),
        artifact_id=str(manifest["payload"]["artifact_id"]),
        payload_sha256=str(manifest["payload"]["sha256"]),
        blocks=[
            {k: b[k] for k in ("kind", "tensor", "material_index")}
            for b in metadata["blocks"]
        ],
        sources={
            "visual_plan_digest": first.get("plan_digest"),
            "audio_plan_digest": None
            if audio is None or audio.manifest is None
            else audio.manifest.get("plan_digest"),
            "audio_partial": "absent"
            if audio is None
            else ("empty" if audio.empty else "blocks"),
        },
    )


__all__ = [
    "AUDIO_REFERENCES",
    "EMPTY_KIND",
    "SCOPE_OF_PORT",
    "VIDEO_REFERENCES",
    "MergedReferences",
    "Partial",
    "empty_partial_document",
    "load_partial",
    "merge_partials",
]


def _empty_partial(doc: dict[str, Any], scope: str) -> Partial:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict) or doc.get("reference_scope") != scope:
        raise ComponentError("INVALID_ARGUMENT", f"空 partial 的範圍不是 {scope}")
    if metadata.get("reference_scope") != scope or metadata.get("blocks"):
        raise ComponentError("INVALID_ARGUMENT", "空 partial 不可帶 block")
    if scope != "audio":
        raise ComponentError(
            "INVALID_ARGUMENT",
            "只有 audio partial 可以是空的（ref2va／fl2va 一定有影像素材）",
        )
    return Partial(scope=scope, metadata=dict(metadata))


def _check_audio_partial(
    audio: Partial | None, vm: Mapping[str, Any], audio_sources: list[int]
) -> None:
    if audio is None:
        if audio_sources:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"素材 {audio_sources} 帶聲音（參考聲音或影片原聲），需要 audio_references（Audio VAE Encode 的輸出）；"
                "少了它 DiT 會把影片當成無聲、條件錯誤，因此拒絕",
                details={"audio_sources": audio_sources},
            )
    else:
        am = audio.metadata
        different = [k for k in _SHARED_KEYS if am.get(k) != vm.get(k)]
        if different:
            raise ComponentError(
                "LATENT_SOURCE_MISMATCH",
                "video_references 與 audio_references 不是同一個請求（同一份 prepared 媒體）的輸出："
                + "、".join(different),
                details={"fields": different},
            )


def _check_partial_identity(
    vm: Mapping[str, Any], prepared_payload_sha256: str | None, task: str | None
) -> None:
    if vm.get("normalized") is not True:
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH", "partial 不是 DiT 的 normalized latent"
        )
    if (
        prepared_payload_sha256 is not None
        and vm.get("prepared_payload_sha256") != prepared_payload_sha256
    ):
        raise ComponentError(
            "LATENT_SOURCE_MISMATCH",
            "參考 latent 不是由這個 DiT 收到的 prepared 媒體編碼的（prepared payload SHA-256 不同）",
            details={
                "references": vm.get("prepared_payload_sha256"),
                "prepared": prepared_payload_sha256,
            },
        )
    if task is not None and vm.get("task") != task:
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            f"參考 latent 的 task 是 {vm.get('task')}，DiT 的 job 是 {task}",
        )
