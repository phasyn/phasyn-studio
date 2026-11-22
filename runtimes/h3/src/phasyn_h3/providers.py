"""MiniMax H3 元件 provider（ … #v4-components-4、#v4-workflows-1 … #v4-workflows-3）.

| provider            | kind               | 內部 stage                                              |
|---------------------|--------------------|---------------------------------------------------------|
| h3.conditioning     | conditioning.encode| prepare_media → encode_conditioning（TE；前處理需可見 GPU；phase 可拆兩步）|
| h3.reference        | reference.encode   | encode_references（video／audio VAE encode，合併版）      |
| h3.video_encode     | reference.encode   | encode_references（reference_scope=visual；Video VAE）    |
| h3.audio_encode     | reference.encode   | encode_references（reference_scope=audio；Audio VAE）     |
| h3.dit              | dit.denoise        | [合併 partial] → [prepare_adaln] → load_dit → assemble_inputs → denoise_av |
| h3.video_decode     | decode.final       | decode_video（串流 encode 到 MP4）                        |
| h3.audio_decode     | audio.decode       | decode_audio（float32 stereo WAV）                        |

describe() 不 import torch／SGLang；只看設定、檔案是否存在與套件是否安裝。數值 recipe 完全沿用
``phasyn_h3.recipe.runtime``；這裡只負責 plan、輸入輸出與紀錄。訊息與紀錄裡的模型路徑一律相對於
``load.model_path``（``phasyn_components.model_identity``）。
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import shutil
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, override

from phasyn_components import upstream
from phasyn_components.canonical import canonical_json
from phasyn_components.errors import ComponentError
from phasyn_components.ids import new_id
from phasyn_components.model_identity import display_path, location, model_identity
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Port,
    RunContext,
    UnloadContext,
)
from phasyn_components.weights import WeightPlan

from . import budget, bundles, references, refimage, refshape, te_share
from .config import (
    ROLE_COMPONENTS,
    SGLANG_REVISION,
    TASK_VARIANT,
    VARIANT_DIR,
    build_profile,
    build_settings_schema,
    check_supported,
    configured_loras,
    default_settings,
    frame_streaming_settings,
    merged_options,
    parameters_schema,
    role_parts,
    weight_streaming_settings,
)
from .lora_facts import (
    FACTS_BUDGET_BYTES,
    lora_catalog,
    pai_compatibility,
    pai_stack_compatibility,
)
from .phases import (
    MEDIA_PORTS,
    SPLIT_PORTS,
    check_prepared_for_job,
    material_mismatches,
    resolve_phase,
)
from .plan import (
    apply_runtime_env,
    build_plan,
    geometry_digest,
    lora_binding,
    lora_manifest_candidates,
    make_job,
    material_descriptor,
    model_manifest,
)
from .recipe.adapter import ref_kv_rules
from .recipe.adapter.cost_model import dit_cost_model, text_encoder_cost_model
from .recipe.adapter.loras import stack_accepted_steps, stack_problems
from .recipe.runtime.denoise_cache_rules import (
    approximation,
    step_budget,
    validate as validate_cache,
)
from .recipe.runtime.errors import UnsupportedCombination
from .recipe.runtime.regional_compile_rules import (
    settings as compile_settings,
    validate as validate_compile,
)


_QUANTIZATION_VARIANTS = 2


PROMPT = "text.prompt.v1"
JOB = "h3.job.v1"
CONDITIONING = "h3.conditioning.tap50.v1"
PREPARED = "h3.prepared-media.v1"
REFERENCES = "h3.references.v1"
VIDEO_REFERENCES = references.VIDEO_REFERENCES
AUDIO_REFERENCES = references.AUDIO_REFERENCES
MATERIALS = "h3.materials.v1"
VIDEO_LATENT = "video.final-latent.v1"
AUDIO_LATENT = "audio.final-latent.v1"
ASSET = "media.asset.v1"
AUDIO = "media.audio.v1"
IMAGE = "media.image.v1"
# DiT 的 ref2va load plan 用：合成的參考圖描述（不對應任何檔案；load_dit 不讀素材）
LOAD_PLAN_PLACEHOLDER: dict[str, Any] = {
    "role": "reference_image",
    "file": {},
    "sha256": "0" * 64,
    "size_bytes": 1,
    "media_type": "image/png",
    "probe": {
        "width": 768,
        "height": 448,
        "display_width": 768,
        "display_height": 448,
        "synthetic": True,
    },
}
KIND_DIRS = {
    "text_encoder": ["text_encoder", "tokenizer", "processor"],
    "transformer": ["transformer"],
    "video_vae": ["video_vae"],
    "audio_vae": ["audio_vae"],
}


def _runtime_installed() -> str | None:
    """Why this environment cannot run H3, or None. Reads package metadata only (nothing is imported).

    The recipe's pins cover only the SGLang functions it patches, so the installed SGLang must also be the pinned
    commit: a different build could change the DiT's results without failing any pin.
    """
    missing = [
        name for name in ("torch", "sglang") if importlib.util.find_spec(name) is None
    ]
    if missing:
        return (
            f"此 runtime 沒有安裝 {', '.join(missing)}（H3 元件需要 GPU runtime 環境）"
        )
    problem = upstream.distribution_problem("sglang", vcs_commit=SGLANG_REVISION)
    if problem is not None:
        return f"此 runtime 的 SGLang 不是 H3 釘版的 {SGLANG_REVISION[:12]}（{problem}）；請使用 deploy/runtimes 的 GPU runtime 環境"
    return None


def _component_dir(
    model_root: Path, variant: str, shared_from: str | None, sub: str
) -> Path:
    owner = variant if sub == "transformer" or not shared_from else shared_from
    return model_root / "MiniMax-H3" / VARIANT_DIR[owner] / sub


def _variant_dirs_sglang_checks(
    role: str,
    model_root: Path,
    variant: str,
    shared_from: str | None,
    options: Mapping[str, Any],
) -> list[Path]:
    """The variant directories SGLang takes as ``model_path`` for this role and therefore verifies.

    A component load verifies the directory its component files come from. The text encoder's ``prepare_media`` builds
    its pipeline config from the component's own variant, which with ``shared_from`` is another directory. An NF4
    single-file DiT is loaded through a generated overlay, so no variant directory is involved.
    """
    if role == "dit" and options.get("transformer_file"):
        return []
    dirs = {
        _component_dir(model_root, variant, shared_from, sub).parent
        for kind in ROLE_COMPONENTS[role]
        for sub in KIND_DIRS[kind]
    }
    if role == "conditioning" and variant in VARIANT_DIR:
        dirs.add(model_root / "MiniMax-H3" / VARIANT_DIR[variant])
    return sorted(dirs)


def _incomplete_variant_dir(variant_dir: Path, model_root: Path) -> str | None:
    """Mirror of SGLang's ``verify_model_config_and_directory``: every component the variant's ``model_index.json`` declares must exist as a path, whether or not this component reads it.

    Left unchecked, the failure comes out of a load or a job as a ValueError from deep inside SGLang. Without a ``model_index.json`` nothing is judged (the recipe then uses its own copy of the pinned index).
    """
    index = _read_json(variant_dir / "model_index.json")
    if index is None:
        return None
    missing = [
        key
        for key, value in index.items()
        if not key.startswith("_")
        and isinstance(value, (list, tuple))
        and len(value) == _QUANTIZATION_VARIANTS
        and all(isinstance(item, str) for item in value)
        and not (variant_dir / key).exists()
    ]
    if not missing:
        return None
    return (
        f"{display_path(variant_dir, model_root)} 缺少 model_index.json 宣告的元件目錄：{'、'.join(missing)}"
        "（SGLang 載入前會逐一檢查，缺任何一個，載入或呼叫就會失敗；只放文字編碼器的 Node 也要有完整的 variant 目錄，"
        "內容相同的目錄可以用 hard link 共用，）"
    )


def _missing_files(role: str, settings: Mapping[str, Any]) -> str | None:
    load = settings.get("load") or {}
    root = load.get("model_path")
    if not root:
        return "未設定 load.model_path（模型根目錄）"
    model_root = Path(str(root))
    if not model_root.is_dir():
        return "模型根目錄（load.model_path）不存在或不是目錄"
    _precision, _offload, options = merged_options(role, load)
    variant = str(options.get("variant") or "fl2va")
    shared = options.get("shared_from")
    problem = _missing_component_file(role, model_root, variant, shared, options)
    if problem is not None:
        return problem
    for variant_dir in _variant_dirs_sglang_checks(
        role, model_root, variant, shared, options
    ):
        problem = _incomplete_variant_dir(variant_dir, model_root)
        if problem is not None:
            return problem
    if role == "dit":
        adaln = options.get("adaln") or {}
        if adaln.get("mode") == "fixed":
            cache_root = Path(
                str(options.get("adaln_cache_root") or model_root / "adaln-cache")
            )
            sidecar = cache_root / f"{adaln.get('cache_ref')}.safetensors"
            if not sidecar.is_file():
                return f"AdaLN fixed 需要 sidecar：{display_path(sidecar, model_root)}"
    return None


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _configured_lora(
    role: str, settings: Mapping[str, Any] | None
) -> tuple[str, dict[str, Any]] | None:
    """Resolve the manifest with the same precedence as the native load."""
    if role != "dit" or settings is None:
        return None
    load = settings.get("load") or {}
    if not load.get("model_path"):
        return None
    _p, _o, options = merged_options(role, load)
    lora = options.get("lora")
    if not isinstance(lora, Mapping) or not lora.get("manifest_path"):
        return None

    key = str(lora["manifest_path"])
    candidates = lora_manifest_candidates(key, model_root=Path(str(load["model_path"])))
    path = next((c for c in candidates if c.is_file()), None)
    manifest = None if path is None else _read_json(path)
    return (key, manifest) if manifest is not None else None


def _configured_stack(
    role: str, settings: Mapping[str, Any] | None
) -> list[tuple[str, dict[str, Any]]] | None:
    """The ``provider_options.loras`` manifests in order; None without a stack or when one cannot be read."""
    if role != "dit" or settings is None:
        return None
    load = settings.get("load") or {}
    if not load.get("model_path"):
        return None
    _p, _o, options = merged_options(role, load)
    stack = options.get("loras")
    if not isinstance(stack, list) or not stack:
        return None
    root = Path(str(load["model_path"]))
    out: list[tuple[str, dict[str, Any]]] = []
    for entry in stack:
        if not isinstance(entry, Mapping) or not entry.get("manifest_path"):
            return None
        key = str(entry["manifest_path"])
        path = next(
            (c for c in lora_manifest_candidates(key, model_root=root) if c.is_file()),
            None,
        )
        manifest = None if path is None else _read_json(path)
        if manifest is None:
            return None
        out.append((key, manifest))
    return out


def _lora_stack_identity(bindings: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """A stack's order and every strength are part of the result; one LoRA keeps today's identity ({})."""
    if len(bindings) <= 1:
        return {}
    return {
        "lora_stack": [
            {"lora_id": b.get("lora_id"), "scale": b.get("scale")} for b in bindings
        ]
    }


def _lora_catalog_facts(
    role: str, settings: Mapping[str, Any] | None, facts: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """``facts.lora_catalog`` for the component editor's LoRA picker (DiT with a model path only)."""
    load = (settings or {}).get("load") or {}
    if role != "dit" or not load.get("model_path"):
        return []
    budget = FACTS_BUDGET_BYTES - len(canonical_json(dict(facts)))
    return lora_catalog(Path(str(load["model_path"])), budget_bytes=budget)


def _check_lora_stack(manifests: Sequence[Mapping[str, Any]]) -> None:
    """Refuse a LoRA stack the recipe cannot run before any weight is read (the plan rules re-check it)."""
    problems = stack_problems(manifests)
    if problems:
        raise ComponentError(
            "UNSUPPORTED_SETTING",
            "LoRA 串接不能執行：" + "；".join(p.message for p in problems),
            details={
                "reason": problems[0].reason,
                "problems": [{"reason": p.reason, "index": p.index} for p in problems],
            },
        )


def _accepted_steps(selected: tuple[str, dict[str, Any]] | None) -> list[int] | None:
    contract = selected[1].get("sampling_contract") if selected is not None else None
    steps = contract.get("steps") if isinstance(contract, Mapping) else None
    if not isinstance(steps, list) or not steps:
        return None
    if not all(
        isinstance(s, int) and not isinstance(s, bool) and s >= 1 for s in steps
    ):
        return None
    return sorted(set(steps))


def _stack_steps(stack: list[tuple[str, dict[str, Any]]] | None) -> list[int] | None:
    return None if not stack else stack_accepted_steps([m for _k, m in stack])


def lora_contract_steps(
    role: str, settings: Mapping[str, Any] | None
) -> list[int] | None:
    """Return the selected manifest's native step constraints, including custom LoRAs (a stack: its accelerator's)."""
    stack = _configured_stack(role, settings)
    if stack is not None:
        return _stack_steps(stack)
    return _accepted_steps(_configured_lora(role, settings))


def cost_model_facts(
    role: str, settings: Mapping[str, Any] | None
) -> dict[str, Any] | None:
    """``facts.cost_model`` for the ETA estimator (DiT and text encoder only; SPEC: estimator data).

    FLOP coefficients and processor limits come from the model's own config files under
    ``load.model_path``; what cannot be read is left out (the client then uses its defaults).
    """
    if role not in ("dit", "conditioning"):
        return None
    load = (settings or {}).get("load") or {}
    root = load.get("model_path")
    files: dict[str, dict[str, Any] | None] = {}
    if root:
        model_root = Path(str(root))
        _p, _o, options = merged_options(role, load)
        variant, shared = (
            str(options.get("variant") or "fl2va"),
            options.get("shared_from"),
        )
        if role == "dit":
            names = {"transformer": ("transformer", "config.json")}
        else:
            names = {
                "text_encoder": ("text_encoder", "config.json"),
                "image": ("processor", "preprocessor_config.json"),
                "video": ("processor", "video_preprocessor_config.json"),
            }
        for key, (sub, name) in names.items():
            files[key] = _read_json(
                _component_dir(model_root, variant, shared, sub) / name
            )
    if role == "dit":
        return dit_cost_model(files.get("transformer"))
    return text_encoder_cost_model(
        files.get("text_encoder"), files.get("image"), files.get("video")
    )


def _model_identity(role: str, settings: Mapping[str, Any]) -> dict[str, Any]:
    """Model identity v2: component paths relative to ``load.model_path``, never the user's absolute layout."""
    load = settings.get("load") or {}
    model_root = Path(str(load.get("model_path")))
    _p, _o, options = merged_options(role, load)
    variant = str(options.get("variant") or "fl2va")
    components: dict[str, Path] = {}
    for kind in ROLE_COMPONENTS[role]:
        for sub in KIND_DIRS[kind]:
            components[sub] = (
                (model_root / str(options["transformer_file"]))
                if (kind == "transformer" and options.get("transformer_file"))
                else _component_dir(
                    model_root, variant, options.get("shared_from"), sub
                )
            )
    return model_identity(
        model_root,
        components,
        hash_configs=False,
        variant=variant,
        shared_from=options.get("shared_from"),
    )


def note_short_edge(
    ctx: RunContext,
    job: Mapping[str, Any],
    prepared: Mapping[str, Any] | None,
    *,
    what: str,
) -> None:
    """下游元件：prepared 必須以 job 宣告的參考影片短邊前處理（不一致 → 422，不猜）；實驗時在紀錄上標示."""
    if prepared is not None:
        refimage.check(job, prepared)
        refshape.check(job, prepared, what=what)
    value = refshape.of_job(job)
    if value is not None:
        ctx.recorder.note(refshape.note(value))


def record_encode_items(
    ctx: RunContext,
    marks: Sequence[Mapping[str, Any]],
    sources: Sequence[Mapping[str, Any]],
) -> None:
    """ENCODE_ITEMS：VAE encode 每個素材完成的時間點（只記錄；沒有進度回報時不寫）."""
    items = budget.encode_item_timings(marks, sources)
    if items:
        ctx.recorder.log(
            "info",
            "ENCODE_ITEMS",
            code="ENCODE_ITEMS",
            items=items,
            timing="host monotonic，自 stage 呼叫起算；每項結束時 latent 已複製回 CPU（同步點），"
            "since_previous_ms 含該項 GPU 時間；第一項另含 payload SHA-256 驗證、tensor 載入與 VAE 取得",
        )


class H3Provider(BaseProvider):
    """Share the lifecycle and reporting of the native H3 providers."""

    role: ClassVar[str] = ""
    kind: ClassVar[str] = ""
    label: ClassVar[str] = ""
    inputs: ClassVar[list[Port]] = []
    outputs: ClassVar[list[Port]] = []

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe the provider, its ports and its configuration."""
        reason = _runtime_installed()
        code = "PROVIDER_NOT_INSTALLED" if reason else None
        if reason is None and settings is not None:
            reason = _missing_files(cls.role, settings)
            code = "COMPONENT_NOT_CONFIGURED" if reason else None
        adaln_mode = "fixed"
        if settings is not None:
            _p, _o, opts = merged_options(cls.role, settings.get("load") or {})
            adaln_mode = (
                str((opts.get("adaln") or {}).get("mode") or "off")
                if cls.role == "dit"
                else "fixed"
            )
        cost_model = cost_model_facts(cls.role, settings)
        facts: dict[str, Any] = {} if cost_model is None else {"cost_model": cost_model}
        if cls.role == "dit":
            facts["draft_refinement"] = {
                "version": 1,
                "latent_input": "init_latent",
                "latent_space_id": bundles.VIDEO_LATENT_SPACE,
                "manifest_version": "4.0",
            }
        selected = _configured_lora(cls.role, settings)
        stack = _configured_stack(cls.role, settings)
        compatibility = (
            pai_stack_compatibility(stack)
            if stack is not None
            else (None if selected is None else pai_compatibility(*selected))
        )
        if compatibility is not None:
            facts["lora_compatibility"] = compatibility
        catalog = _lora_catalog_facts(cls.role, settings, facts)
        if catalog:
            facts["lora_catalog"] = catalog
        accepted = (
            _stack_steps(stack) if stack is not None else _accepted_steps(selected)
        )
        return Description(
            provider_id=cls.provider_id,
            kind=cls.kind,
            label=cls.label,
            inputs=list(cls.inputs),
            outputs=list(cls.outputs),
            parts=role_parts(cls.role, adaln_mode=adaln_mode),
            settings_schema=build_settings_schema(cls.role),
            parameters_schema=parameters_schema(cls.role, accepted_steps=accepted),
            default_settings=default_settings(cls.role),
            available=reason is None
            or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
            unavailable_code=code,
            unavailable_reason=reason,
            facts=facts,
        )

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """The pinned MiniMax-H3 variant directories and LoRA files this role needs."""
        from .weights import plan  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        return plan(cls.role, settings)

    # ------------------------------------------------------------------ lifecycle
    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        from phasyn_components.recorder.gpu import (  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
            AllocatorWindow,
            runtime_identity,
            torch_backend_flags,
        )

        from .host import H3Host  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        settings = ctx.settings
        notes = check_supported(self.role, settings, ctx.expanded_parts)
        for note in notes:
            ctx.recorder.note(note)
        load = settings.get("load") or {}
        precision, offload, options = merged_options(self.role, load)
        self.model_root = Path(str(load["model_path"]))
        self.options = options
        self.precision = precision
        self.offload = offload
        apply_runtime_env(model_root=self.model_root, options=options, role=self.role)
        self.lora_bindings: list[dict[str, Any]] = []
        lora_manifests: list[dict[str, Any]] = []
        if self.role == "dit":
            for entry in configured_loras(options):
                binding, manifest = lora_binding(
                    str(entry["manifest_path"]),
                    scale=float(entry.get("scale", 1.0)),
                    model_root=self.model_root,
                )
                self.lora_bindings.append(binding)
                lora_manifests.append(manifest)
            _check_lora_stack(lora_manifests)
        self.profile = build_profile(
            self.role,
            settings,
            profile_id=f"phasyn-{self.host.component_id}",
            revision=1,
            expanded_parts=ctx.expanded_parts,
            lora_manifests=lora_manifests,
        )
        self.variant = str(options.get("variant") or "fl2va")
        self.model = model_manifest(
            variant=self.variant,
            shared_from=options.get("shared_from"),
            transformer_file=options.get("transformer_file"),
            model_root=self.model_root,
            cache_dir=self.host.data_dir / "cache" / "model-digests",
        )
        self.h3 = H3Host(
            device=self.host.device,
            work_dir=self.host.work_dir,
            process_instance_id=self.host.process_instance_id,
            **self.host_options(),
        )
        allocator = AllocatorWindow(0)
        allocator.start()
        with ctx.recorder.phase("load"):
            self.warm(ctx)
        allocator.finish(ctx.recorder, scope="load")
        observed: dict[str, Any] = {
            "backend_flags": torch_backend_flags(),
            "accumulation_dtype": None,
            "accumulation_dtype_reason": "kernel 累加精度無法由此 backend 觀測；未知不等於 FP32",
            "profile_mode": self.profile["mode"],
            "components": {
                k: self.profile["components"][k] for k in ROLE_COMPONENTS[self.role]
            },
            "notes": notes,
        }
        observed.update(self.observe_loaded())
        effective = dict(load)
        effective["precision"] = precision
        effective["offload"] = offload
        effective["provider_options"] = options
        self.calls = 0
        return LoadResult(
            effective_load=effective,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=_model_identity(self.role, settings),
            runtime_identity=runtime_identity(),
        )

    def warm(self, ctx: LoadContext) -> None:
        """預先載入此 role 的權重（after_use 規則照常套用）."""
        job = make_job(
            task="t2va" if self.variant == "fl2va" else "ref2va",
            prompt="warmup",
            width=768,
            height=448,
            frames=124,
            variant=self.variant,
            materials=[],
            shared_from=self.options.get("shared_from"),
        )
        if self.variant == "ref2va":
            return  # ref2va plan 需要真實參考素材；第一次 invoke 才載入
        plan, _ = build_plan(
            job, self.profile, model=self.model, lora_bindings=self.lora_bindings
        )
        for stage_kind, component in self.warm_components():
            self.h3.warm(plan, stage_kind, component, ctx.recorder)

    def warm_components(self) -> list[tuple[str, str]]:
        """List the model components to prepare during warm-up."""
        return []

    def host_options(self) -> dict[str, Any]:
        """H3Host 的編排選項（h3.video_encode／h3.video_decode：video_vae_scope）."""
        return {}

    def observe_loaded(self) -> dict[str, Any]:
        """Report the settings and identities of loaded components."""
        return {}

    @override
    def unload(self, ctx: UnloadContext) -> None:
        h3 = getattr(self, "h3", None)
        if h3 is not None:
            with ctx.recorder.span("h3.shutdown", part="runtime.release"):
                h3.shutdown()

    def after_failure(self, code: str) -> None:
        """Handle runtime state following a failed invocation."""
        h3 = getattr(self, "h3", None)
        if h3 is not None and code == "GPU_OOM":
            with contextlib.suppress(Exception):
                import torch

                torch.cuda.synchronize()
                torch.cuda.empty_cache()

    # ------------------------------------------------------------------ helpers
    def start_call(self, ctx: RunContext) -> Any:
        """Begin recording the current invocation."""
        from phasyn_components.recorder.gpu import AllocatorWindow  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        allocator = AllocatorWindow(0)
        allocator.start()
        ctx.recorder.set_metric(
            "h3.warm_call",
            1 if self.calls > 0 else 0,
            unit="bool",
            scope="process",
            method="runtime_hook",
            reason=None,
        )
        self.calls += 1
        return allocator

    def finish_call(self, ctx: RunContext, allocator: Any) -> None:
        """Finalize recording for the current invocation."""
        self.h3.end_invoke(ctx.recorder)
        allocator.finish(ctx.recorder, scope="invoke")

    def stage(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
        self,
        ctx: RunContext,
        kind: str,
        plan: Mapping[str, Any],
        *,
        inputs: Mapping[str, Path],
        attachments: Mapping[str, Path],
        allocator: Any,
        progress: Any = None,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run a single native stage in this provider."""
        out_dir = Path(ctx.work_dir) / ctx.call_id / kind
        return self.h3.stage(
            kind,
            plan,
            inputs=inputs,
            attachments=attachments,
            out_dir=out_dir,
            rec=ctx.recorder,
            cancelled=ctx.cancelled,
            check_cancelled=ctx.check_cancelled,
            allocator=allocator,
            progress=progress,
            options=options,
        )

    def _vae_model(self, variant: str) -> dict[str, Any]:
        """VAE 元件（encode／decode）處理另一個 variant 的 job 時用的 model manifest：兩個 variant 的 VAE 是同 hash.

        的同一份檔（shared_from 目錄），plan 沿用此元件自己的 model_id，常駐的 VAE 不會因 job 的 variant 不同而重載。
        """
        return self._shared_model(variant)

    def _shared_model(self, variant: str) -> dict[str, Any]:
        """``variant`` 的 job 沿用此元件自己的 model 身分（model_id、shared_from 目錄）的 manifest：stage 解析出的非 DiT.

        元件身分（registry key）與已載入的相同，不會因 job 的 variant 不同而重載。VAE 元件直接用；h3.conditioning 只在
        ``te_share`` 證明 TE／tokenizer／processor 相同時才用。
        """
        cache = self.__dict__.setdefault("_vae_models", {})
        if variant not in cache:
            owner = self.options.get("shared_from") or self.variant
            cache[variant] = model_manifest(
                variant=variant,
                shared_from=owner,
                transformer_file=None,
                model_root=self.model_root,
                cache_dir=self.host.data_dir / "cache" / "model-digests",
                model_id=str(self.model["model_id"]),
            )
        return dict(cache[variant])

    def job_input(self, ctx: RunContext) -> dict[str, Any]:
        """Read the H3 job supplied to the current invocation."""
        job = ctx.input("job").value
        if not isinstance(job, Mapping) or job.get("schema") != JOB:
            raise ComponentError(
                "INVALID_ARGUMENT", "job 必須是 h3.job.v1（由 h3.conditioning 輸出）"
            )
        if job.get("variant") != self.variant:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"job 的 checkpoint 為 {job.get('variant')}，此元件載入的是 {self.variant}",
            )
        return dict(job)


class ConditioningProvider(H3Provider):
    """Encode the H3 job text into a conditioning bundle."""

    provider_id = "h3.conditioning"
    role = "conditioning"
    kind = "conditioning.encode"
    label = "MiniMax H3 文字條件編碼（Qwen3-VL hidden-state tap 50；不是 chat 文字）"
    inputs: ClassVar[list[Port]] = [
        Port(
            "prompt",
            PROMPT,
            required=True,
            transport="inline",
            description="生成 prompt（verbatim）",
        ),
        Port(
            "first_frame",
            IMAGE,
            required=False,
            transport="file",
            description="fl2va 首幀（選用）",
        ),
        Port(
            "last_frame",
            IMAGE,
            required=False,
            transport="file",
            description="fl2va 尾幀（選用）",
        ),
        Port(
            "materials",
            MATERIALS,
            required=False,
            transport="inline",
            description="ref2va 參考素材：[{file: FileRef, role, start_seconds?, end_seconds?}]",
        ),
        Port(
            "prepared",
            PREPARED,
            required=False,
            transport="file",
            description="phase=encode：同一流程中 phase=prepare 步驟輸出的前處理媒體（只跑 Qwen，不重做前處理）",
        ),
        Port(
            "job",
            JOB,
            required=False,
            transport="inline",
            description="phase=encode：同一個 prepare 步驟輸出的 job（依它建 plan）",
        ),
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "conditioning",
            CONDITIONING,
            required=False,
            transport="file",
            description="TE conditioning bundle（hidden_states BF16 [S,5120] 等）；phase=prepare 不產生",
        ),
        Port(
            "prepared",
            PREPARED,
            required=False,
            transport="file",
            description="前處理後的媒體與 presentation（reference／DiT 需要）；phase=encode 不產生（沿用輸入）",
        ),
        Port(
            "job",
            JOB,
            required=True,
            transport="inline",
            description="任務／幾何／素材描述；下游元件以此建立相同 plan（phase=encode 原樣轉出）",
        ),
    ]

    @override
    def warm_components(self) -> list[tuple[str, str]]:
        return [("encode_conditioning", "text_encoder")]

    @override
    def observe_loaded(self) -> dict[str, Any]:
        """Load 紀錄：預載的是哪一份 TE，以及另一個 variant 的 job 會不會共用它（證明與原因，見 te_share）."""
        other = "ref2va" if self.variant == "fl2va" else "fl2va"
        instance = self._text_encoder_instance()
        not_loaded = "load 時沒有預載 TE（ref2va 元件第一次 invoke 才載入）"
        return {
            "text_encoder_sharing": {
                "own_variant": self.variant,
                "loaded": instance,
                "loaded_reason": None if instance is not None else not_loaded,
                "instances_by_variant": self._served_by_variant(self.variant, instance),
                "decisions": {other: self._text_encoder_share(other).fact()},
            }
        }

    def _variant_model(self, variant: str) -> dict[str, Any]:
        """Job 的 variant 用哪份 model manifest：此元件自己的；另一個 variant 只在 te_share 證明 TE／tokenizer／processor.

        相同時沿用此元件的身分（registry 取到同一份已載入的 TE），否則照舊用另一份（各自一份）。
        """
        if variant == self.variant:
            return self.model
        if self._text_encoder_share(variant).applied:
            return self._shared_model(variant)
        return self._model_for(variant)

    def _text_encoder_share(self, variant: str) -> te_share.ShareDecision:
        """每個程序對每個 variant 判斷一次（load 時就判斷，load 紀錄看得到）；判斷本身出錯也只是不共用."""
        cache: dict[str, te_share.ShareDecision] = self.__dict__.setdefault(
            "_te_share", {}
        )
        if variant not in cache:
            try:
                # 一個元件只有一份 profile，兩個 variant 的 plan 都由它建：設定指紋照樣逐項比對並寫進紀錄
                settings = te_share.settings_fingerprint(self.profile)
                cache[variant] = te_share.decide(
                    variant=variant,
                    own_variant=self.variant,
                    loaded=self.model,
                    shared=self._shared_model(variant),
                    separate=self._model_for(variant),
                    model_root=self.model_root,
                    loaded_settings=settings,
                    variant_settings=settings,
                    digest=te_share.DigestCache(
                        self.host.data_dir / "cache" / "model-digests"
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - Optional diagnostics must not interrupt generation.  # 不共用=以前的行為（各自一份），只留原因
                cache[variant] = te_share.ShareDecision(
                    variant=variant,
                    own_variant=self.variant,
                    applied=False,
                    reason=f"共用判斷失敗：{type(exc).__name__}: {exc}"[:500],
                )
        return cache[variant]

    def _text_encoder_instance(self) -> dict[str, Any] | None:
        """最近一次取用的 TE（registry lease）；component_key 相同\N{FULLWIDTH EQUALS SIGN}同一份已載入的 module."""
        with contextlib.suppress(Exception):
            lease = self.h3.provider.last_lease("text_encoder")
            if lease is not None:
                spec = lease.spec
                return {
                    "component_key": lease.component_key,
                    "component_id": spec.component_id,
                    "model_id": spec.model_id,
                    **location(Path(spec.path), self.model_root.resolve()),
                }
        return None

    def _text_encoder_entries(self) -> list[dict[str, Any]] | None:
        """此程序目前持有的 TE（device 或 host）；共用時只有一份."""
        with contextlib.suppress(Exception):
            device, host = self.h3.provider.registry.residency_report()
            return [
                {k: entry.get(k) for k in ("component_key", "component_id", "state")}
                for entry in [*device, *host]
                if entry.get("kind") == "text_encoder"
            ]
        return None

    def _served_by_variant(
        self, variant: str, instance: Mapping[str, Any] | None
    ) -> dict[str, str]:
        served: dict[str, str] = self.__dict__.setdefault("_te_served", {})
        if instance is not None:
            served[variant] = str(instance["component_key"])
        return dict(served)

    def _record_text_encoder(
        self, ctx: RunContext, variant: str, *, encoded: bool
    ) -> None:
        """TEXT_ENCODER_INSTANCE：這次 job 的 variant 由哪一份 TE 服務、是否與此元件的 variant 共用及原因."""
        fields: dict[str, Any] = {
            "code": "TEXT_ENCODER_INSTANCE",
            "variant": variant,
            "own_variant": self.variant,
            "encoded": encoded,
            "sharing": None,  # 此元件自己的 variant：本來就是它自己載入的那一份
        }
        if variant != self.variant:
            decision = self._text_encoder_share(variant)
            fields["sharing"] = decision.summary()
            if not decision.applied:
                ctx.recorder.note(
                    f"{variant} 的文字編碼器沒有與 {self.variant} 共用（各自一份）：{decision.reason}"[
                        :500
                    ]
                )
        if encoded:  # phase=prepare 不跑 TE：只記共用判斷（tokenizer／processor 也跟著同一份 manifest）
            instance = self._text_encoder_instance()
            fields["served_by"] = instance
            fields["instances_by_variant"] = self._served_by_variant(variant, instance)
            fields["text_encoder_instances"] = self._text_encoder_entries()
        ctx.recorder.log("info", "TEXT_ENCODER_INSTANCE", **fields)

    @staticmethod
    def _prompt_text(ctx: RunContext) -> str:
        value = ctx.input("prompt").value
        return (
            str(value.get("text") or "")
            if isinstance(value, Mapping)
            else str(value or "")
        )

    @staticmethod
    def _bound_ports(ctx: RunContext) -> set[str]:
        """實際接上的選用輸入（空的 materials 清單不算）."""
        bound: set[str] = set()
        for port in (*SPLIT_PORTS, *MEDIA_PORTS):
            item = ctx.optional_input(port)
            if item is None:
                continue
            if port == "materials" and not (
                isinstance(item.value, list) and item.value
            ):
                continue
            if port == "job" and item.value is None:
                continue
            if port in ("prepared", "first_frame", "last_frame") and item.file is None:
                continue
            bound.add(port)
        return bound

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        params = dict(ctx.parameters)  # runtime host 已疊好 invoke defaults
        phase = resolve_phase(params, bound=self._bound_ports(ctx))
        if phase == "encode":
            self._invoke_encode(ctx, params)
            return
        short_edge = refshape.requested(
            params
        )  # 不合法 → 422（任何前處理之前）；None=官方 768
        task = str(params.get("task") or "t2va")
        prompt = self._prompt_text(ctx)
        materials, material_paths = _read_materials(ctx)
        job = make_job(
            task=task,
            prompt=prompt,
            width=int(params.get("width") or 768),
            height=int(params.get("height") or 448),
            frames=int(params.get("frames") or 124),
            variant=TASK_VARIANT.get(task, "fl2va"),
            materials=materials,
            shared_from=self.options.get("shared_from"),
        )
        if job["variant"] != self.variant and not self.options.get("shared_from"):
            # TE／tokenizer／processor 在兩個 variant 是同 hash 檔；使用此元件設定的目錄
            job["variant"] = TASK_VARIANT[task]
        stage_options = self._apply_short_edge(ctx, job, short_edge)
        image_edge = refimage.requested(params)
        if image_edge is not None:
            job[refimage.PARAM] = image_edge
            refimage.of_job(
                job
            )  # Reject non-image/non-Ref2VA requests before allocating.
            stage_options = {**(stage_options or {}), refimage.PARAM: image_edge}
            ctx.recorder.note(
                f"reference_image_short_edge={image_edge}: reference images prepared at a {image_edge} px short edge"
            )
        allocator = self.start_call(ctx)
        model = self._variant_model(str(job["variant"]))
        plan, _sig = build_plan(job, self.profile, model=model)
        cond = None
        try:
            prep = self.stage(
                ctx,
                "prepare_media",
                plan,
                inputs=material_paths,
                attachments={},
                allocator=allocator,
                options=stage_options,
            )
            payload_ref = json.loads(prep["prepared"].path.read_bytes())["payload"]
            if phase == "all":
                cond = self.stage(
                    ctx,
                    "encode_conditioning",
                    plan,
                    inputs={"prepared": prep["prepared"].path},
                    attachments={
                        str(payload_ref["artifact_id"]): prep["prepared.payload"].path
                    },
                    allocator=allocator,
                )
        finally:
            self.finish_call(ctx, allocator)
        self._record_text_encoder(ctx, str(job["variant"]), encoded=cond is not None)
        self._record_budget(ctx, prep["prepared"].path, prep["prepared.payload"].path)
        # stage 都完成後才把檔案移入檔案庫（移動後原路徑即不存在）
        bundles.publish_bundle(
            ctx,
            port="prepared",
            type_id=PREPARED,
            manifest_path=prep["prepared"].path,
            payload_path=prep["prepared.payload"].path,
            kind="h3_prepared_media",
        )
        if cond is not None:
            cond_doc = bundles.publish_bundle(
                ctx,
                port="conditioning",
                type_id=CONDITIONING,
                manifest_path=cond["conditioning"].path,
                payload_path=cond["conditioning.payload"].path,
                kind="h3_conditioning",
            )
            self._input_tokens(ctx, cond_doc)

        job["geometry"] = plan["geometry"]
        job["geometry_digest"] = geometry_digest(plan)
        job["model_variant_dir"] = model.get("model_id")
        ctx.set_output("job", job)

    def _invoke_encode(self, ctx: RunContext, params: Mapping[str, Any]) -> None:
        """phase=encode：只跑 encode_conditioning；prepared／job 來自同一流程的 phase=prepare 步驟."""
        job = ctx.input("job").value
        if not isinstance(job, Mapping) or job.get("schema") != JOB:
            raise ComponentError(
                "INVALID_ARGUMENT", "job 必須是 h3.job.v1（phase=prepare 步驟的輸出）"
            )
        job = dict(job)
        task = str(job.get("task"))
        if TASK_VARIANT.get(task) is None or job.get("variant") != TASK_VARIANT[task]:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"job 的 task／variant（{task}／{job.get('variant')}）不一致",
            )
        step_short_edge = refshape.requested(
            params
        )  # 不合法 → 422；encode 不重做前處理，只核對與記錄
        job_short_edge = refshape.of_job(job)
        image_edge = refimage.requested(params)
        if image_edge is not None and image_edge != refimage.of_job(job):
            raise ComponentError(
                "LATENT_SOURCE_MISMATCH",
                "phase=encode image edge differs from prepared job",
            )
        prepared_path, attachments, prepared = bundles.materialize_bundle(
            ctx.input("prepared"), port="prepared"
        )
        model = self._variant_model(str(job["variant"]))
        plan, _sig = build_plan(job, self.profile, model=model)
        check_prepared_for_job(
            prepared,
            job,
            prompt=self._prompt_text(ctx),
            geometry_digest=geometry_digest(plan),
        )
        ignored = {
            key: params.get(key)
            for key in ("task", "width", "height", "frames")
            if params.get(key) is not None and params.get(key) != job.get(key)
        }
        if params.get(refshape.PARAM) is not None and step_short_edge != job_short_edge:
            ignored[refshape.PARAM] = params.get(refshape.PARAM)
        if ignored:
            ctx.recorder.note(
                f"phase=encode 依輸入的 job 建 plan；本步驟的參數 {ignored} 與 job 不同，未使用"
            )
        if job_short_edge is not None:
            ctx.recorder.note(refshape.note(job_short_edge))
        allocator = self.start_call(ctx)
        try:
            cond = self.stage(
                ctx,
                "encode_conditioning",
                plan,
                inputs={"prepared": prepared_path},
                attachments=attachments,
                allocator=allocator,
            )
        finally:
            self.finish_call(ctx, allocator)
        self._record_text_encoder(ctx, str(job["variant"]), encoded=True)
        self._record_budget(
            ctx, prepared_path, next(iter(attachments.values()), None), materials=False
        )
        cond_doc = bundles.publish_bundle(
            ctx,
            port="conditioning",
            type_id=CONDITIONING,
            manifest_path=cond["conditioning"].path,
            payload_path=cond["conditioning.payload"].path,
            kind="h3_conditioning",
        )
        self._input_tokens(ctx, cond_doc)
        ctx.set_output("job", job)

    @staticmethod
    def _apply_short_edge(
        ctx: RunContext, job: dict[str, Any], short_edge: int | None
    ) -> dict[str, Any] | None:
        """實驗短邊：有參考影片才套用（寫進 job、交給 prepare_media 的 stage 選項）；沒有參考影片時只記錄未生效.

        官方路徑（None）回傳 None：stage dict 與 job 都和以前完全相同。
        """
        if short_edge is None:
            return None
        fields = {
            "code": "REFERENCE_VIDEO_SHORT_EDGE",
            "requested": short_edge,
            "official": refshape.OFFICIAL,
        }
        if not refshape.has_reference_video(job.get("materials")):
            ctx.recorder.note(refshape.unused_note(short_edge))
            ctx.recorder.log(
                "info",
                "REFERENCE_VIDEO_SHORT_EDGE",
                **fields,
                applied=False,
                reason="這次沒有參考影片（只影響 reference_video）",
            )
            return None
        job[refshape.PARAM] = short_edge
        ctx.recorder.note(refshape.note(short_edge))
        ctx.recorder.log(
            "warning",
            "REFERENCE_VIDEO_SHORT_EDGE",
            **fields,
            applied=True,
            experimental=True,
        )
        return {refshape.PARAM: short_edge}

    @staticmethod
    def _input_tokens(ctx: RunContext, cond_doc: Mapping[str, Any]) -> None:
        text_len = cond_doc.get("text_len")
        if isinstance(text_len, int):
            ctx.recorder.set_metric(
                "input_tokens",
                text_len,
                unit="count",
                scope="component_call",
                method="runtime_hook",
            )

    @staticmethod
    def _record_budget(
        ctx: RunContext,
        manifest_path: Path,
        payload_path: Path | None,
        *,
        materials: bool = True,
    ) -> None:
        """REFERENCE_BUDGET：素材 原始→前處理 尺寸與 Qwen token 拆分（只讀；失敗只記錄原因，不影響輸出）."""
        try:
            doc = json.loads(Path(manifest_path).read_bytes())
            qwen = (
                budget.qwen_token_split(Path(payload_path))
                if payload_path is not None
                else None
            )
            items = budget.material_budget(doc) if materials else None
        except Exception as exc:  # noqa: BLE001 - Optional diagnostics must not interrupt generation.  # 紀錄是附帶觀測：任何讀取問題都只留原因，不影響輸出
            ctx.recorder.note(f"參考預算紀錄略過：{type(exc).__name__}: {exc}"[:500])
            return
        fields: dict[str, Any] = {
            "code": "REFERENCE_BUDGET",
            "task": doc.get("task"),
            "qwen": qwen,
        }
        if items is not None:
            fields["materials"] = items
        if doc.get(refshape.PARAM) is not None:  # 只有實驗套用時 prepared 才有這個欄位
            fields[refshape.PARAM] = {
                "value": doc[refshape.PARAM],
                "official": refshape.OFFICIAL,
                "experimental": True,
            }
        ctx.recorder.log("info", "REFERENCE_BUDGET", **fields)
        for key in ("text", "vision", "video"):
            if qwen is not None:
                ctx.recorder.set_metric(
                    f"h3.qwen.{key}_tokens",
                    int(qwen[key]),
                    unit="count",
                    quality="derived",
                    scope="component_call",
                    method="presentation_tensors",
                )

    def _model_for(self, variant: str) -> dict[str, Any]:
        """``variant`` 自己的 manifest（另一個 model_id → registry 另載一份）：te_share 證明不成立時的做法（以前一律如此）."""
        return model_manifest(
            variant=variant,
            shared_from=self.variant,
            transformer_file=None,
            model_root=self.model_root,
            cache_dir=self.host.data_dir / "cache" / "model-digests",
        )


class ReferenceProvider(H3Provider):
    """Prepare and encode references for an H3 job."""

    provider_id = "h3.reference"
    role = "reference"
    kind = "reference.encode"
    label = "MiniMax H3 參考素材 VAE encode（fl2va 首尾幀／ref2va 參考）"
    inputs: ClassVar[list[Port]] = [
        Port(
            "prepared",
            PREPARED,
            required=True,
            transport="file",
            description="h3.conditioning 輸出的前處理媒體",
        ),
        Port(
            "job",
            JOB,
            required=True,
            transport="inline",
            description="任務描述（同一份 plan）",
        ),
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "references",
            REFERENCES,
            required=True,
            transport="file",
            description="reference latents bundle",
        )
    ]

    @override
    def warm_components(self) -> list[tuple[str, str]]:
        return [("encode_references", "video_vae")]

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        job = self.job_input(ctx)
        if job["task"] == "t2va" or not job.get("materials"):
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                "t2va／沒有參考素材時不需要 reference.encode（接線請移除此步驟）",
            )
        prepared_path, attachments, prepared = bundles.materialize_bundle(
            ctx.input("prepared"), port="prepared"
        )
        note_short_edge(ctx, job, prepared, what="h3.reference")
        allocator = self.start_call(ctx)
        plan, _ = build_plan(job, self.profile, model=self.model)
        try:
            out = self.stage(
                ctx,
                "encode_references",
                plan,
                inputs={"prepared": prepared_path},
                attachments=attachments,
                allocator=allocator,
            )
            bundles.publish_bundle(
                ctx,
                port="references",
                type_id=REFERENCES,
                manifest_path=out["references"].path,
                payload_path=out["references.payload"].path,
                kind="reference_latents",
            )
        finally:
            self.finish_call(ctx, allocator)


class _ScopedReferenceEncoder(H3Provider):
    """h3.video_encode／h3.audio_encode 共用：同一個 recipe encode_references stage 的一個 scope.

    * VAE 檔在 FL2VA 與 Ref2VA 是同一份（同 hash；本機為 hard link），所以兩種 variant 的 job 都收；
      plan 的 model manifest 固定使用此元件的 component 身分（model_id／目錄），常駐的 VAE 不因
      job 的 variant 不同而重載或多載一份。
    * 載入時就把自己的 VAE 放好（load 階段），之後每次 invoke 直接使用（after_use 規則照常套用）。
    """

    scope: ClassVar[str] = ""
    component: ClassVar[str] = ""
    out_port: ClassVar[str] = ""
    out_type: ClassVar[str] = ""
    short: ClassVar[str] = ""

    @override
    def warm(self, ctx: LoadContext) -> None:

        # 任何 variant 都用同一個 VAE 身分：以 t2va／FL2VA 的空 job 建 load plan（不跑 stage、不讀素材）
        job = make_job(
            task="t2va",
            prompt="warmup",
            width=768,
            height=448,
            frames=124,
            variant="fl2va",
            materials=[],
        )
        plan, _ = build_plan(job, self.profile, model=self._vae_model("fl2va"))
        self.h3.warm(plan, "encode_references", self.component, ctx.recorder)

    @override
    def job_input(self, ctx: RunContext) -> dict[str, Any]:
        job = ctx.input("job").value
        if not isinstance(job, Mapping) or job.get("schema") != JOB:
            raise ComponentError(
                "INVALID_ARGUMENT", "job 必須是 h3.job.v1（由 h3.conditioning 輸出）"
            )
        if job.get("variant") not in VARIANT_DIR:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"job 的 variant {job.get('variant')} 不是 fl2va／ref2va",
            )
        job = dict(job)
        if job["task"] == "t2va" or not job.get("materials"):
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                f"t2va／沒有參考素材時不需要 {self.short}（接線請移除此步驟）",
            )
        return job

    def stage_options(self) -> dict[str, Any]:
        """The encode_references stage's orchestration options (``H3Host.stage(options=...)``)."""
        return {"reference_scope": self.scope}

    def _encode(
        self,
        ctx: RunContext,
        job: Mapping[str, Any],
        prepared_path: Path,
        attachments: Mapping[str, Path],
        sources: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        """``sources``：這個 scope 依序編碼的素材項（recipe ``scoped_sources``），用來標示每項耗時."""
        allocator = self.start_call(ctx)
        plan, _ = build_plan(
            job, self.profile, model=self._vae_model(str(job["variant"]))
        )
        marks: list[dict[str, Any]] = []
        started = time.perf_counter_ns()

        def progress(doc: Mapping[str, Any]) -> None:
            if doc.get("phase") == "encode_references" and isinstance(
                doc.get("completed"), int
            ):
                elapsed_ms = round((time.perf_counter_ns() - started) / 1e6, 3)
                marks.append({"completed": int(doc["completed"]), "at_ms": elapsed_ms})

        try:
            out = self.stage(
                ctx,
                "encode_references",
                plan,
                inputs={"prepared": prepared_path},
                attachments=attachments,
                allocator=allocator,
                progress=progress,
                options=self.stage_options(),
            )
            bundles.publish_bundle(
                ctx,
                port=self.out_port,
                type_id=self.out_type,
                manifest_path=out["references"].path,
                payload_path=out["references.payload"].path,
                kind=f"reference_latents.{self.scope}",
            )
        finally:
            self.finish_call(ctx, allocator)
        record_encode_items(ctx, marks, sources)


class VideoEncodeProvider(_ScopedReferenceEncoder):
    """Encode visual reference media with the H3 video VAE."""

    provider_id = "h3.video_encode"
    role = "video_encode"
    kind = "reference.encode"
    label = "Video VAE Encode（MiniMax H3：fl2va 首尾幀／ref2va 參考圖片與影片）"
    scope = "visual"
    short = "Video VAE Encode"
    component = "video_vae"
    out_port = "video_references"
    out_type = VIDEO_REFERENCES
    inputs: ClassVar[list[Port]] = [
        Port(
            "prepared",
            PREPARED,
            required=True,
            transport="file",
            description="h3.conditioning 輸出的前處理媒體",
        ),
        Port(
            "job",
            JOB,
            required=True,
            transport="inline",
            description="任務描述（同一份 plan）",
        ),
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "video_references",
            VIDEO_REFERENCES,
            required=True,
            transport="file",
            description="影像參考 latent（partial bundle；h3.dit 與 audio_references 合併後等同 h3.reference）",
        )
    ]

    @override
    def host_options(self) -> dict[str, Any]:
        return {"video_vae_scope": str(self.options.get("video_vae_scope") or "full")}

    def _frame_streaming(self) -> dict[str, Any] | None:
        """The resolved provider_options.frame_streaming, or None (absent / enabled=false: nothing changes)."""
        return frame_streaming_settings(
            self.role, {"precision": self.precision, "provider_options": self.options}
        )

    @override
    def stage_options(self) -> dict[str, Any]:
        out = super().stage_options()
        streaming = self._frame_streaming()
        if streaming is not None:
            out["frame_streaming"] = streaming
        return out

    @override
    def observe_loaded(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "video_vae_scope": self.options.get("video_vae_scope") or "full"
        }
        streaming = self._frame_streaming()
        if streaming is not None:
            out["frame_streaming"] = streaming
        with contextlib.suppress(Exception):
            lease = self.h3.provider.last_lease("video_vae")
            facts = dict(getattr(getattr(lease, "handle", None), "facts", {}) or {})
            if facts.get("video_vae_scope"):
                out["video_vae_scope_facts"] = facts["video_vae_scope"]
        return out

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        from phasyn_h3.recipe.runtime.stages.encode_references import scoped_sources  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        job = self.job_input(ctx)
        prepared_path, attachments, prepared = bundles.materialize_bundle(
            ctx.input("prepared"), port="prepared"
        )
        note_short_edge(ctx, job, prepared, what="h3.video_encode")
        visual, _audio, _base = scoped_sources(
            list(prepared.get("materials") or []), "visual"
        )
        if not visual:
            raise ComponentError(
                "MODEL_INCOMPATIBLE",
                "素材裡沒有圖片或影片（只有聲音）；ref2va 至少需要一張參考圖或一段參考影片",
            )
        self._encode(ctx, job, prepared_path, attachments, visual)


class AudioEncodeProvider(_ScopedReferenceEncoder):
    """Encode audio references with the H3 audio VAE."""

    provider_id = "h3.audio_encode"
    role = "audio_encode"
    kind = "reference.encode"
    label = "Audio VAE Encode（MiniMax H3：ref2va 參考聲音與參考影片原聲）"
    scope = "audio"
    short = "Audio VAE Encode"
    component = "audio_vae"
    out_port = "audio_references"
    out_type = AUDIO_REFERENCES
    inputs: ClassVar[list[Port]] = [
        Port(
            "prepared",
            PREPARED,
            required=True,
            transport="file",
            description="h3.conditioning 輸出的前處理媒體",
        ),
        Port(
            "job",
            JOB,
            required=True,
            transport="inline",
            description="任務描述（同一份 plan）",
        ),
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "audio_references",
            AUDIO_REFERENCES,
            required=True,
            transport="file",
            description="聲音參考 latent（partial bundle；素材沒有聲音時是 0 個 block 的空 partial，未用 GPU）",
        )
    ]

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        from phasyn_h3.recipe.runtime.stages.encode_references import scoped_sources  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        job = self.job_input(ctx)
        prepared_path, attachments, prepared = bundles.materialize_bundle(
            ctx.input("prepared"), port="prepared"
        )
        _visual, audio, _base = scoped_sources(
            list(prepared.get("materials") or []), "audio"
        )
        if audio:
            self._encode(ctx, job, prepared_path, attachments, audio)
            return
        doc = references.empty_partial_document(prepared, task=str(job["task"]))
        out = ctx.new_file(
            self.out_port,
            bundles.BUNDLE_MEDIA_TYPE,
            {"kind": "reference_latents.audio", "empty": True, "blocks": 0},
            type_id=self.out_type,
        )
        out.write(canonical_json(doc))
        ctx.set_file_output(self.out_port, out)
        ctx.recorder.note(
            "素材沒有聲音（參考聲音或帶音軌的參考影片）：輸出 0 個 block 的 audio partial，未使用 GPU"
        )


def _has_file(ctx: RunContext, port: str) -> bool:
    item = ctx.optional_input(port)
    return item is not None and item.file is not None


def refine_request(
    start_step: Any, *, has_init: bool, planned_updates: int, options: Mapping[str, Any]
) -> dict[str, int] | None:
    """The DiT's opt-in refinement from ``init_latent`` (``recipe/runtime/refine.py``), checked before any GPU work.

    None when neither ``init_latent`` nor ``start_step`` is given (the call is the call of today). Only an online
    AdaLN DiT without a LoRA takes it: a fixed AdaLN sidecar and a LoRA's sampling contract are tied to the full
    sigma grid, so those components refuse it instead of changing their contract.
    """
    if start_step is None and not has_init:
        return None
    if start_step is None or not has_init:
        raise ComponentError(
            "INVALID_ARGUMENT",
            "從既有 latent 精修需要同時給 init_latent 輸入與 start_step 參數",
            details={"init_latent": has_init, "start_step": start_step},
        )
    if (
        isinstance(start_step, bool)
        or not isinstance(start_step, int)
        or not 1 <= start_step < planned_updates
    ):
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"start_step 必須是 1..{planned_updates - 1} 的整數（steps={planned_updates}），收到 {start_step!r}",
            details={"start_step": start_step, "steps": planned_updates},
        )
    adaln_mode = str((options.get("adaln") or {}).get("mode") or "off")
    has_lora = bool(configured_loras(options))
    if adaln_mode != "online" or has_lora:
        raise ComponentError(
            "UNSUPPORTED_COMBINATION",
            "從既有 latent 精修只支援 online AdaLN、未綁 LoRA 的 DiT；此元件"
            + (
                f"是 adaln.mode={adaln_mode}（固定 sidecar 綁定完整 sigma 網格）"
                if adaln_mode != "online"
                else "綁了 LoRA（採樣合約綁定完整 sigma 網格）"
            ),
            details={"adaln_mode": adaln_mode, "lora": has_lora},
        )
    return {"start_step": int(start_step)}


def _denoise_options(
    refine: Mapping[str, Any] | None,
    nag: Mapping[str, Any] | None,
    *,
    observe_attention: bool = False,
) -> dict[str, Any] | None:
    """Return the optional denoise stage settings requested by this run."""
    options = {
        **({} if refine is None else {"refine": refine}),
        **({} if nag is None else {"nag": nag}),
        **({"observe_attention": True} if observe_attention else {}),
    }
    return options or None


def nag_request(
    params: Mapping[str, Any],
    *,
    has_negative: bool,
    planned_updates: int,
    options: Mapping[str, Any],
) -> dict[str, Any] | None:
    """The DiT's opt-in NAG (``recipe/runtime/nag_rules.py``), checked before any GPU work.

    None when ``nag_conditioning`` is not bound and no ``nag_*`` parameter is given (the call is the call of
    today). Parameters without the negative conditioning, values out of range and the combinations the first
    version does not serve are refused (422); nothing falls back to the run without NAG.
    """
    from .recipe.runtime.errors import ShimError  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.
    from .recipe.runtime.nag_rules import PARAMS, check_combination, from_params  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

    attention = str((options.get("attention") or {}).get("provider") or "auto_exact")
    given = {key: params[key] for key in PARAMS if params.get(key) is not None}
    if not has_negative:
        if given:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "nag_* 參數需要同時接 nag_conditioning（負面文字的 conditioning）",
                details={"parameters": sorted(given)},
            )
        return None
    try:
        nag = from_params(given, planned_updates=planned_updates)
        check_combination(
            mode=str(options.get("mode") or "exact"),
            attention=attention
            if attention != "auto_exact"
            else "pytorch_sdpa",  # policy._resolve_attention
            ref_kv_cache=ref_kv_rules.parse_option(options.get(ref_kv_rules.OPTION))
            is not None,
        )
    except ShimError as exc:
        raise ComponentError(
            exc.error_code,
            exc.message,
            details={"reason": exc.reason_code, "field": exc.field_path},
        ) from exc
    return {"phi": nag.phi, "tau": nag.tau, "alpha": nag.alpha, "steps": nag.steps}


class DitProvider(H3Provider):
    """Run the joint audio and video transformer for a sampled job."""

    provider_id = "h3.dit"
    role = "dit"
    kind = "dit.denoise"
    label = "MiniMax H3 音畫聯合 DiT（完整去噪迴圈在單次呼叫內）"
    inputs: ClassVar[list[Port]] = [
        Port(
            "conditioning",
            CONDITIONING,
            required=True,
            transport="file",
            description="TE conditioning bundle",
        ),
        Port(
            "job",
            JOB,
            required=True,
            transport="inline",
            description="任務／幾何（與 conditioning 同一份）",
        ),
        Port(
            "prepared",
            PREPARED,
            required=False,
            transport="file",
            description="前處理媒體（fl2va／ref2va 的 AdaLN 條件旗標需要）",
        ),
        Port(
            "references",
            REFERENCES,
            required=False,
            transport="file",
            description="合併版 reference latents（h3.reference 的輸出）",
        ),
        Port(
            "video_references",
            VIDEO_REFERENCES,
            required=False,
            transport="file",
            description="影像參考 latent（h3.video_encode）；與 audio_references 在 DiT 內合併，不可與 references 同時接",
        ),
        Port(
            "audio_references",
            AUDIO_REFERENCES,
            required=False,
            transport="file",
            description="聲音參考 latent（h3.audio_encode）；素材帶聲音（參考聲音或影片原聲）時必填",
        ),
        Port(
            "init_latent",
            VIDEO_LATENT,
            required=False,
            transport="file",
            description="從既有 latent 精修（選用，與 start_step 一起給）：另一個 run 的 DiT video_latent（同一份 blob 含 audio）",
        ),
        Port(
            "nag_conditioning",
            CONDITIONING,
            required=False,
            transport="file",
            description="NAG 負面文字（選用）：另一個 h3.conditioning 步驟（task=t2va、不接素材）編碼的負面 prompt；接上即開 NAG",
        ),
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "video_latent",
            VIDEO_LATENT,
            required=True,
            transport="file",
            description="最後一次 scheduler update 後的 video latent（manifest\N{FULLWIDTH PLUS SIGN}blob）",
        ),
        Port(
            "audio_latent",
            AUDIO_LATENT,
            required=True,
            transport="file",
            description="audio latent（同一 blob）",
        ),
    ]

    @override
    def warm(self, ctx: LoadContext) -> None:

        task = "t2va" if self.variant == "fl2va" else "ref2va"
        # load_dit 只用 profile／LoRA／AdaLN／幾何，不讀素材；ref2va 的 plan 規則要求至少一個影像參考，
        # 所以 load plan 帶一個合成的參考圖描述（不存在的檔案，只用來建 plan，不會被讀取或生成）
        materials = [LOAD_PLAN_PLACEHOLDER] if task == "ref2va" else []
        defaults = dict(ctx.settings.get("invoke") or {})
        job = make_job(
            task=task,
            prompt="load",
            width=768,
            height=448,
            frames=124,
            variant=self.variant,
            materials=materials,
        )
        plan, _ = build_plan(
            job,
            self.profile,
            model=self.model,
            sampling=defaults,
            lora_bindings=self.lora_bindings,
        )
        out_dir = Path(self.host.work_dir) / "load_dit"
        self.h3.stage(
            "load_dit",
            plan,
            inputs={},
            attachments={},
            out_dir=out_dir,
            rec=ctx.recorder,
            cancelled=lambda: False,
        )

    @override
    def observe_loaded(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            lease = self.h3.provider.last_lease("transformer")
            facts = dict(getattr(getattr(lease, "handle", None), "facts", {}) or {})
            out["load_facts"] = {
                k: facts.get(k)
                for k in (
                    "acceleration",
                    "quantization",
                    "offload",
                    "attention",
                    "weight_bytes",
                )
                if k in facts
            }
        return out

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        from .instrument import DitInstrumentation  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        job = self.job_input(ctx)
        params = {**dict(ctx.settings.get("invoke") or {}), **dict(ctx.parameters)}
        sampling = {
            k: params[k]
            for k in ("seed", "steps", "video_shift", "audio_shift")
            if params.get(k) is not None
        }
        runtime = _denoise_settings(self.profile, params)
        plan, sigma_bytes = build_plan(
            job,
            runtime.profile,
            model=self.model,
            sampling=sampling,
            lora_bindings=self.lora_bindings,
        )
        cond_path, cond_att, cond_doc = _conditioning_for_dit(ctx, job, plan)
        attachments = dict(cond_att)
        stage_inputs = _initial_stage_files(ctx, cond_path, sigma_bytes)
        refine, refine_identity = self._stage_refinement(
            ctx, params, plan, stage_inputs, attachments
        )
        nag = _checked_nag(ctx, runtime, plan, self.options, refine)
        nag_identity = _stage_nag(ctx, nag, stage_inputs, attachments)
        prepared_path, prepared_doc, prepared_sha = _prepared_for_dit(
            ctx, job, attachments
        )
        ref_path, ref_att = self._references(ctx, job, prepared_sha)
        if ref_path is not None:
            attachments.update(ref_att)
            stage_inputs["references"] = ref_path
        allocator = self.start_call(ctx)
        adaln_mode = str((self.options.get("adaln") or {}).get("mode") or "off")
        try:
            if adaln_mode != "off":
                adaln_inputs = {
                    "sigmas": stage_inputs["sigmas"],
                    **({"prepared": prepared_path} if prepared_path else {}),
                }
                if prepared_path is None and job["task"] != "t2va":
                    raise ComponentError(
                        "INVALID_ARGUMENT",
                        "fl2va／ref2va 的 AdaLN 需要 prepared 輸入（否則條件旗標會錯）",
                    )
                out = self.stage(
                    ctx,
                    "prepare_adaln",
                    plan,
                    inputs=adaln_inputs,
                    attachments={},
                    allocator=allocator,
                )
                stage_inputs["adaln"] = out["adaln"].path
            out = self.stage(
                ctx, "load_dit", plan, inputs={}, attachments={}, allocator=allocator
            )
            stage_inputs["residency"] = out["residency"].path
            out = self.stage(
                ctx,
                "assemble_inputs",
                plan,
                inputs=stage_inputs,
                attachments=attachments,
                allocator=allocator,
            )
            stage_inputs["packed"] = out["packed"].path
            self._record_sequence(
                ctx,
                out["packed"].path,
                next(iter(cond_att.values()), None),
                cond_doc,
                prepared_doc,
                short_edge=refshape.of_job(job),
            )
            sigma_list = self._sigmas(sigma_bytes)[
                0 if refine is None else int(refine["start_step"]) :
            ]
            self.h3.instrumentation = DitInstrumentation(
                ctx.recorder, sigmas=sigma_list
            )
            try:
                out = self.stage(
                    ctx,
                    "denoise_av",
                    plan,
                    inputs=stage_inputs,
                    attachments=attachments,
                    allocator=allocator,
                    options=_denoise_options(
                        refine, nag, observe_attention=runtime.observe_attention
                    ),
                )
            finally:
                self.h3.instrumentation = None
            identity = {
                "provider_id": self.provider_id,
                "component_id": self.host.component_id,
                "node_id": self.host.node_id,
                "variant": self.variant,
                "profile_mode": self.profile["mode"],
                "quantization": self.profile["components"]["transformer"][
                    "quantization"
                ],
                "attention": self.profile["attention"],
                "adaln": self.profile["adaln"],
                "lora": [b.get("lora_id") for b in self.lora_bindings],
                "seed": sampling.get("seed"),
                **_lora_stack_identity(self.lora_bindings),
            }
            if refine_identity is not None:
                identity["refine"] = refine_identity
            if runtime.cache is not None:
                identity["denoise_cache"] = runtime.cache
            if nag_identity is not None:
                identity["nag"] = nag_identity
            bundles.publish_final_latents(
                ctx,
                manifest_path=out["target_latents"].path,
                payload_path=out["target_latents.payload"].path,
                job=job,
                plan=plan,
                generator_identity=identity,
            )
        finally:
            self.finish_call(ctx, allocator)

    def _references(
        self, ctx: RunContext, job: Mapping[str, Any], prepared_sha: str | None
    ) -> tuple[Path | None, dict[str, Path]]:
        """references（合併版）或 video_references\N{FULLWIDTH PLUS SIGN}audio_references（拆開，這裡合併）→ assemble_inputs 的輸入."""
        combined = ctx.optional_input("references")
        parts = {port: ctx.optional_input(port) for port in references.SCOPE_OF_PORT}
        has_combined = combined is not None and combined.file is not None
        given = {
            port: item
            for port, item in parts.items()
            if item is not None and item.file is not None
        }
        if has_combined and given:
            raise ComponentError(
                "INVALID_ARGUMENT",
                "references（合併版，h3.reference）與 video_references／audio_references（拆開）不能同時接；請只用其中一種",
                details={"ports": ["references", *sorted(given)]},
            )
        if job["task"] == "t2va":
            if has_combined or given:
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "t2va 不接受參考 latent；請移除 references／video_references／audio_references 接線",
                )
            return None, {}
        if has_combined:
            if not (combined is not None):
                raise AssertionError
            path, att, _doc = bundles.materialize_bundle(combined, port="references")
            return path, att
        if not given:
            raise ComponentError(
                "INVALID_ARGUMENT",
                f"{job['task']} 需要參考 latent：接 references（h3.reference），或 video_references"
                "（h3.video_encode）\N{FULLWIDTH PLUS SIGN}素材帶聲音時的 audio_references（h3.audio_encode）",
            )
        loaded: dict[str, references.Partial] = {}
        for port, item in given.items():
            link = item.links.get("payload")
            loaded[port] = references.load_partial(
                item.require_path(port),
                None if link is None else link[1],
                scope=references.SCOPE_OF_PORT[port],
            )
        merged = references.merge_partials(
            loaded.get("video_references"),
            loaded.get("audio_references"),
            out_dir=Path(ctx.work_dir) / ctx.call_id / "merged_references",
            prepared_payload_sha256=prepared_sha,
            task=str(job["task"]),
        )
        ctx.recorder.log(
            "info",
            "已合併 video／audio 參考 latent（與 h3.reference 同一 payload 格式）",
            payload_sha256=merged.payload_sha256,
            blocks=merged.blocks,
            sources=merged.sources,
        )
        return merged.manifest_path, {merged.artifact_id: merged.payload_path}

    @staticmethod
    def _record_sequence(  # noqa: PLR0913 - Preserve the existing provider or recipe ABI.
        ctx: RunContext,
        packed_path: Path,
        cond_payload: Path | None,
        cond_doc: Mapping[str, Any],
        prepared_doc: Mapping[str, Any] | None,
        *,
        short_edge: int | None = None,
    ) -> None:
        """DIT_SEQUENCE：全序列由哪些列組成（Qwen／參考 latent／目標）；只讀，失敗只記錄原因.

        ``short_edge``：job 的實驗參考影片短邊（None\N{FULLWIDTH EQUALS SIGN}官方 768，不加欄位）。
        """
        try:
            packed = json.loads(Path(packed_path).read_bytes())
            qwen = (
                budget.qwen_token_split(Path(cond_payload))
                if cond_payload is not None
                else None
            )
            breakdown = budget.sequence_breakdown(packed, qwen)
        except Exception as exc:  # noqa: BLE001 - Optional diagnostics must not interrupt generation.  # 紀錄是附帶觀測：任何讀取問題都只留原因，不影響輸出
            ctx.recorder.note(
                f"DiT 序列組成紀錄略過：{type(exc).__name__}: {exc}"[:500]
            )
            return
        if short_edge is not None:
            breakdown[refshape.PARAM] = {
                "value": short_edge,
                "official": refshape.OFFICIAL,
                "experimental": True,
            }
        if prepared_doc is not None:
            # 換 prompt 沿用參考 latent 時，conditioning 與 prepared 的 presentation 會不同（照實記錄，不視為錯誤）
            breakdown["same_presentation"] = cond_doc.get("presentation_digest") == (
                prepared_doc.get("presentation") or {}
            ).get("digest")
        level = "info" if breakdown["consistent"] else "warning"
        ctx.recorder.log(level, "DIT_SEQUENCE", code="DIT_SEQUENCE", **breakdown)
        for name, value in (
            ("h3.dit.used_rows", breakdown["used_len"]),
            ("h3.dit.qwen_rows", breakdown["qwen_rows"]),
            ("h3.dit.reference_rows", breakdown["reference_rows"]),
            (
                "h3.dit.target_rows",
                breakdown["target_video_rows"] + breakdown["target_audio_rows"],
            ),
        ):
            ctx.recorder.set_metric(
                name,
                int(value),
                unit="count",
                quality="derived",
                scope="component_call",
                method="packed_layout",
            )

    @staticmethod
    def _sigmas(payload: bytes | None) -> list[float]:
        if not payload:
            return []
        with contextlib.suppress(Exception):
            from safetensors.numpy import load

            return [float(x) for x in load(payload)["video_sigmas"].tolist()]
        return []

    def _stage_refinement(
        self,
        ctx: RunContext,
        params: Mapping[str, Any],
        plan: Mapping[str, Any],
        stage_inputs: dict[str, Path],
        attachments: dict[str, Path],
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        refine = refine_request(
            params.get("start_step"),
            has_init=_has_file(ctx, "init_latent"),
            planned_updates=int(plan["schedule"]["planned_updates"]),
            options=self.options,
        )
        refine_identity: dict[str, Any] | None = None
        if refine is not None:
            manifest, latent_ref, init_bundle, init_att = bundles.read_final_latent(
                ctx, port="init_latent", expect_space=bundles.VIDEO_LATENT_SPACE
            )
            if manifest["binding"].get("geometry") != plan["geometry"]:
                raise ComponentError(
                    "LATENT_MISMATCH",
                    "init_latent 的幾何與此 DiT plan 不同（task／畫面／影格需一致；不 reshape、不縮放）",
                    details={"expected": geometry_digest(plan)},
                )
            stage_inputs["init_latents"] = init_bundle
            attachments.update(init_att)
            refine_identity = {
                **refine,
                "init_latent_id": latent_ref["latent_id"],
                "init_blob_sha256": latent_ref["blob_sha256"],
            }
        return refine, refine_identity


def _initial_stage_files(
    ctx: RunContext, cond_path: Path, sigma_bytes: bytes | None
) -> dict[str, Path]:
    work = Path(ctx.work_dir) / ctx.call_id
    work.mkdir(parents=True, exist_ok=True)
    sigmas = work / "sigmas.safetensors"
    sigmas.write_bytes(sigma_bytes or b"")
    stage_inputs: dict[str, Path] = {"conditioning": cond_path, "sigmas": sigmas}
    return stage_inputs


class VideoDecodeProvider(H3Provider):
    """Decode the sampled video latents into visual media."""

    provider_id = "h3.video_decode"
    role = "video_decode"
    kind = "decode.final"
    label = "MiniMax H3 video VAE 正式解碼（同一份 final latent；串流編碼 MP4）"
    inputs: ClassVar[list[Port]] = [
        Port(
            "latent",
            VIDEO_LATENT,
            required=True,
            transport="file",
            description="final video latent（manifest\N{FULLWIDTH PLUS SIGN}blob）",
        )
    ]
    outputs: ClassVar[list[Port]] = [
        Port(
            "asset",
            ASSET,
            required=True,
            transport="inline",
            description="完整 MP4 Asset（ffprobe 核對 frame 數後才 complete）",
        )
    ]

    @override
    def warm_components(self) -> list[tuple[str, str]]:
        return [("decode_video", "video_vae")]

    def _weight_streaming(self) -> dict[str, Any] | None:
        """The resolved provider_options.weight_streaming, or None (absent / enabled=false: nothing changes)."""
        return weight_streaming_settings(
            self.role, {"precision": self.precision, "provider_options": self.options}
        )

    @override
    def host_options(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "video_vae_scope": str(self.options.get("video_vae_scope") or "full")
        }
        streaming = self._weight_streaming()
        if streaming is not None:
            out["weight_streaming"] = streaming
        return out

    @override
    def observe_loaded(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "video_vae_scope": self.options.get("video_vae_scope") or "full"
        }
        streaming = self._weight_streaming()
        if streaming is not None:
            out["weight_streaming"] = streaming
        with contextlib.suppress(Exception):
            lease = self.h3.provider.last_lease("video_vae")
            facts = dict(getattr(getattr(lease, "handle", None), "facts", {}) or {})
            if facts.get("video_vae_scope"):
                out["video_vae_scope_facts"] = facts["video_vae_scope"]
        return out

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        manifest, latent_ref, bundle_path, attachments = bundles.read_final_latent(
            ctx, port="latent", expect_space=bundles.VIDEO_LATENT_SPACE
        )
        job = dict(manifest["binding"].get("job") or {})
        if (
            job.get("variant")
            and job["variant"] != self.variant
            and not self.options.get("shared_from")
        ):
            ctx.recorder.note(
                f"latent 來自 {job['variant']}；video VAE 在兩個 variant 是同 hash 檔"
            )
        output = {
            k: self.options[k]
            for k in ("encode_provider", "video_codec", "pixel_format", "quality")
            if self.options.get(k)
        }
        output["frame_delivery"] = "local_encode"
        allocator = self.start_call(ctx)
        plan, _ = build_plan(
            job,
            self.profile,
            model=self._vae_model(str(job.get("variant") or self.variant)),
            output=output,
        )
        if plan["geometry"] != manifest["binding"].get("geometry"):
            raise ComponentError(
                "LATENT_MISMATCH",
                "以 job 重建的幾何與 latent manifest 記錄的不同（不 reshape）",
            )
        try:
            out = self.stage(
                ctx,
                "decode_video",
                plan,
                inputs={"target_latents": bundle_path},
                attachments=attachments,
                allocator=allocator,
            )
        finally:
            self.finish_call(ctx, allocator)
        track = out["video_track"]
        video = ctx.new_file(
            None, "video/mp4", {"kind": "final"}, type_id="media.video.v1"
        )

        shutil.move(str(track.path), str(video.path))
        video.adopt_written()
        from phasyn_media.probe import probe  # noqa: PLC0415 - Keep runtime initialization on the operation that needs it.

        info = probe(video.path).as_dict()
        frames = int(info.get("frame_count") or 0)
        expected = int(manifest["target"]["frames"])
        if frames != expected:
            raise ComponentError(
                "MEDIA_INCOMPLETE",
                f"成片 frame 數 {frames} ≠ latent 目標 {expected}；不標完整",
            )
        ctx.recorder.set_metric(
            "output_frame_count",
            frames,
            unit="count",
            scope="component_call",
            method="ffprobe_count",
        )
        ref = ctx.file_ref(video)
        ctx.set_output(
            "asset",
            {
                "asset_id": new_id(),
                "kind": "final",
                "file": ref,
                "source_latent": latent_ref,
                "frame_count": frames,
                "fps": manifest["target"]["fps"],
                "width": int(info.get("width") or manifest["target"]["width"]),
                "height": int(info.get("height") or manifest["target"]["height"]),
                "complete": True,
                "actual_settings": {
                    "compute_dtype": self.precision.get("compute_dtype"),
                    "profile_mode": self.profile["mode"],
                    "video_codec": info.get("video_codec"),
                    "pixel_format": info.get("pixel_format"),
                    "encode": output,
                    "color": {
                        k: info.get(k)
                        for k in (
                            "color_primaries",
                            "color_transfer",
                            "color_space",
                            "color_range",
                        )
                    },
                    **(
                        {"weight_streaming": streaming}
                        if (streaming := self._weight_streaming())
                        else {}
                    ),
                },
            },
        )


class AudioDecodeProvider(H3Provider):
    """Decode the sampled audio latents into a waveform."""

    provider_id = "h3.audio_decode"
    role = "audio_decode"
    kind = "audio.decode"
    label = "MiniMax H3 audio VAE 解碼（float32 stereo 32 kHz WAV）"
    inputs: ClassVar[list[Port]] = [
        Port(
            "latent",
            AUDIO_LATENT,
            required=True,
            transport="file",
            description="final audio latent（manifest\N{FULLWIDTH PLUS SIGN}blob）",
        )
    ]
    outputs: ClassVar[list[Port]] = [
        Port("audio", AUDIO, required=True, transport="file", description="PCM WAV")
    ]

    @override
    def warm_components(self) -> list[tuple[str, str]]:
        return [("decode_audio", "audio_vae")]

    def invoke(self, ctx: RunContext) -> None:
        """Execute the stage using the supplied inputs and publish its outputs."""
        manifest, _latent_ref, bundle_path, attachments = bundles.read_final_latent(
            ctx, port="latent", expect_space=bundles.AUDIO_LATENT_SPACE
        )
        job = dict(manifest["binding"].get("job") or {})
        allocator = self.start_call(ctx)
        plan, _ = build_plan(
            job,
            self.profile,
            model=self._vae_model(str(job.get("variant") or self.variant)),
        )
        try:
            out = self.stage(
                ctx,
                "decode_audio",
                plan,
                inputs={"target_latents": bundle_path},
                attachments=attachments,
                allocator=allocator,
            )
        finally:
            self.finish_call(ctx, allocator)
        wav = ctx.new_file(
            "audio", "audio/wav", {"sample_format": "f32le", "channels": 2}
        )

        shutil.move(str(out["pcm"].path), str(wav.path))
        wav.adopt_written()
        ctx.set_file_output("audio", wav)


__all__ = [
    "AudioDecodeProvider",
    "AudioEncodeProvider",
    "ConditioningProvider",
    "DitProvider",
    "H3Provider",
    "ReferenceProvider",
    "VideoDecodeProvider",
    "VideoEncodeProvider",
]


def _missing_component_file(
    role: str, model_root: Path, variant: str, shared: Any, options: Mapping[str, Any]
) -> str | None:
    for kind in ROLE_COMPONENTS[role]:
        for sub in KIND_DIRS[kind]:
            if kind == "transformer" and options.get("transformer_file"):
                path = model_root / str(options["transformer_file"])
                if not path.is_file():
                    return f"缺少 NF4 DiT 檔：{display_path(path, model_root)}"
                continue
            path = _component_dir(model_root, variant, shared, sub)
            if (
                not (path / "config.json").is_file()
                and not (path / "tokenizer_config.json").is_file()
                and not (path / "preprocessor_config.json").is_file()
            ):
                return f"缺少 {kind} 檔案：{display_path(path, model_root)}（權重未下載或路徑錯誤；不自動下載）"
    return None


def _read_materials(ctx: RunContext) -> tuple[list[dict[str, Any]], dict[str, Path]]:
    from phasyn_media.probe import probe  # noqa: PLC0415 - Media probing is only required for preparation.

    materials: list[dict[str, Any]] = []
    material_paths: dict[str, Path] = {}

    def add(
        ref: Mapping[str, Any], path: Path, role: str, extra: Mapping[str, Any]
    ) -> None:
        info = probe(path).as_dict()
        materials.append(
            material_descriptor(
                ref,
                role=role,
                probe_info=info,
                start_seconds=extra.get("start_seconds"),
                end_seconds=extra.get("end_seconds"),
                use_embedded_audio=extra.get("use_embedded_audio"),
                hold_last_frame=extra.get("hold_last_frame"),
            )
        )
        material_paths[f"material_{len(materials) - 1:02d}"] = path

    with ctx.recorder.span("h3.materials", part="tokenizer"):
        for port, role in (
            ("first_frame", "first_frame"),
            ("last_frame", "last_frame"),
        ):
            item = ctx.optional_input(port)
            if item is not None and item.file is not None:
                add(item.file, item.require_path(port), role, {})
        extra = ctx.optional_input("materials")
        for entry in (
            extra.value if extra is not None and isinstance(extra.value, list) else []
        ):
            ref = entry.get("file") if isinstance(entry, Mapping) else None
            if not isinstance(ref, Mapping):
                raise ComponentError(
                    "INVALID_ARGUMENT",
                    "materials 每一項需要 file（FileRef）與 role",
                )
            add(ref, ctx.resolve_file(ref), str(entry.get("role")), entry)
    return materials, material_paths


def _prepared_for_dit(
    ctx: RunContext, job: Mapping[str, Any], attachments: dict[str, Path]
) -> tuple[Path | None, dict[str, Any] | None, str | None]:
    prepared = ctx.optional_input("prepared")
    prepared_path = None
    prepared_doc: dict[str, Any] | None = None
    if prepared is not None and prepared.file is not None:
        prepared_path, prep_att, prepared_doc = bundles.materialize_bundle(
            prepared, port="prepared"
        )
        attachments.update(prep_att)
    prepared_sha = None
    if prepared_doc is not None:
        prepared_sha = (prepared_doc.get("payload") or {}).get("sha256")
        # prepared 決定 AdaLN 條件旗標與參考 latent 的身分：必須與 job 是同一批素材（換 prompt 沿用參考時也成立）
        problems = material_mismatches(
            list(job.get("materials") or []),
            list(prepared_doc.get("materials") or []),
        )
        if problems:
            raise ComponentError(
                "LATENT_SOURCE_MISMATCH",
                "prepared 與 job 不是同一批素材：" + "；".join(problems),
                details={"problems": problems},
            )
    note_short_edge(ctx, job, prepared_doc, what="h3.dit")
    return prepared_path, prepared_doc, prepared_sha


def _conditioning_for_dit(
    ctx: RunContext, job: Mapping[str, Any], plan: Mapping[str, Any]
) -> tuple[Path, dict[str, Path], dict[str, Any]]:
    cond_path, cond_att, cond_doc = bundles.materialize_bundle(
        ctx.input("conditioning"), port="conditioning"
    )
    digest = geometry_digest(plan)
    if cond_doc.get("geometry_digest") not in (None, digest) or job.get(
        "geometry_digest"
    ) not in (None, digest):
        raise ComponentError(
            "MODEL_INCOMPATIBLE",
            "conditioning 的幾何與此 DiT plan 不同（task／畫面／影格需一致）",
            details={
                "expected": digest,
                "conditioning": cond_doc.get("geometry_digest"),
            },
        )
    return cond_path, cond_att, cond_doc


@dataclass(frozen=True)
class _DenoiseSettings:
    params: Mapping[str, Any]
    profile: Mapping[str, Any]
    cache: dict[str, Any] | None
    observe_attention: bool


def _denoise_settings(
    base: Mapping[str, Any], params: Mapping[str, Any]
) -> _DenoiseSettings:

    observe_attention = params.get("observe_attention", False)
    if not isinstance(observe_attention, bool):
        raise ComponentError("INVALID_ARGUMENT", "observe_attention must be a boolean.")
    profile = base
    try:
        request_cache = approximation(params.get("denoise_cache"))
        if request_cache is not None:
            profile = {**profile, "approximation": request_cache}
            validate_cache(profile)
        compile_option = compile_settings(params.get("compile"))
        if compile_option is not None:
            profile = {**profile, "compile": compile_option}
            validate_compile(profile)
    except UnsupportedCombination as exc:
        raise ComponentError(
            "UNSUPPORTED_SETTING", exc.message, details={"reason_code": exc.reason_code}
        ) from exc
    return _DenoiseSettings(params, profile, request_cache, observe_attention)


def _checked_nag(
    ctx: RunContext,
    runtime: _DenoiseSettings,
    plan: Mapping[str, Any],
    options: Mapping[str, Any],
    refine: Mapping[str, Any] | None,
) -> dict[str, Any] | None:

    planned_updates = int(plan["schedule"]["planned_updates"])
    nag = nag_request(
        runtime.params,
        has_negative=_has_file(ctx, "nag_conditioning"),
        planned_updates=planned_updates,
        options=options,
    )
    try:
        step_budget(
            runtime.cache,
            steps=planned_updates - int((refine or {}).get("start_step", 0)),
            nag=nag is not None,
        )
    except UnsupportedCombination as exc:
        raise ComponentError(
            "UNSUPPORTED_SETTING", exc.message, details={"reason_code": exc.reason_code}
        ) from exc
    return nag


def _stage_nag(
    ctx: RunContext,
    nag: Mapping[str, Any] | None,
    stage_inputs: dict[str, Path],
    attachments: dict[str, Path],
) -> dict[str, Any] | None:
    nag_identity: dict[str, Any] | None = None
    if nag is not None:
        nag_path, nag_att, nag_doc = bundles.materialize_bundle(
            ctx.input("nag_conditioning"), port="nag_conditioning"
        )
        stage_inputs["nag_conditioning"] = nag_path
        attachments.update(nag_att)
        nag_identity = {
            **nag,
            "negative_payload_sha256": (nag_doc.get("payload") or {}).get("sha256"),
        }
    return nag_identity
