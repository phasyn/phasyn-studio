"""``qimg.vision``: Qwen3-VL image reverse prompting (caption/analyze/revise/compare/pairwise).

One instance = one resident Qwen3-VL in an isolated process (4B by default; ``model_path`` may point at 8B/32B).
There is no bearer token, worker HTTP server, idempotent replay, operation queue or result cache — Phasyn's component
processes, runs and cancellation provide isolation and cancel — and no automatic choice of model or format.
Settings, describe() and the model checks live in ``vision.describe``; per-op input rules in ``vision.op_inputs``.

Each invoke is one op:
- The inputs are fixed per op (anything extra or missing is a 422, never silently ignored); images are always
  EXIF-oriented, converted to sRGB and flattened on white (the original files are untouched).
- Output is strict JSON (no fence stripping, no truncation repair); an invalid output gets at most one repair inside
  the same invoke (captions and outputs cut by the token limit are not repaired); still invalid →
  MODEL_OUTPUT_INVALID (422; each attempt's SHA-256, token counts and validation errors in Error.details, the raw
  output in the recording log).
- Input tokens + reserved output above max_context_tokens → 422 CONTEXT_BUDGET_EXCEEDED (images, task data and locked
  descriptions are never truncated; a repair may only drop the previous invalid output).
- The capacity check (capacity.py) runs before loading and before every generation and is always reported;
  ``capacity_check`` decides explicitly whether to refuse or only report. Available memory comes from the shared
  ``phasyn_qimg.memory`` helper: ``memory_model`` (auto/discrete/unified) picks mem_get_info or MemAvailable -
  ``unified_reserve_bytes`` (integrated/unified-memory GPUs); all raw readings are reported.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, override

from phasyn_components import contracts, upstream
from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    RunContext,
    UnloadContext,
)
from phasyn_components.weights import WeightPlan

from .. import memory
from ..instrument import CallMemory
from ..weights import vision_plan
from . import capacity
from .describe import (
    PARAMS,
    PROVIDER_ID,
    describe_vision,
    model_identity,
    model_problem,
    resolve_options,
)
from .engine import Engine, Generation, Prepared
from .formats import (
    REPAIR_INPUT_POLICY,
    OpFormat,
    OutputInvalid,
    Parsed,
    op_format,
    parse_output,
)
from .images import NORMALIZATION, ViewImage, crop_view, load_view_image
from .messages import Repair, ViewLabel, build_messages, task_payload
from .op_inputs import build_request
from .templates import TEMPLATE_SOURCE, schema_fingerprint, template_fingerprint


_REPAIR_ATTEMPT = 2

RAW_LOG_CHARS = 64000
LIBRARIES = (
    "torch",
    "transformers",
    "tokenizers",
    "accelerate",
    "safetensors",
    "pillow",
)
EXTRA_VIEWS: dict[str, tuple[tuple[str, str], ...]] = {
    "compare": (("v-generated", "generated"),),
    "pairwise": (("v-A", "candidate_a"), ("v-B", "candidate_b")),
}


@dataclass
class _AttemptInput:
    fmt: OpFormat
    language: str
    request: Mapping[str, Any]
    views: list[tuple[str, str, ViewImage, dict[str, Any] | None]]


@dataclass
class _AttemptHistory:
    attempts: list[dict[str, Any]]
    raws: list[str]
    first_token: list[float | None]


@dataclass
class _VisionPrompt:
    fmt: OpFormat
    labels: list[ViewLabel]
    images: list[Any]
    payload: Mapping[str, Any]


class QwenVisionProvider(BaseProvider):
    """Describe, load and run the Qwen vision model."""

    provider_id = PROVIDER_ID
    # allocator reading at the start of the current call's GPU work (None: no GPU work yet in this call)
    _call_memory: CallMemory | None = None

    def __init__(self, host: Any) -> None:
        """Initialize the state for this operation."""
        super().__init__(host)
        self.engine: Engine | None = None
        self.options: dict[str, Any] = {}
        self.config: dict[str, Any] = {}
        self.weights_bytes = 0
        self.identity: dict[str, Any] = {}
        self.libraries: dict[str, str | None] = {}

    # ------------------------------------------------------------------ describe
    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Describe the ports, settings and current runtime availability."""
        return describe_vision(settings)

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Qwen3-VL-4B-Instruct at load.model_path."""
        return vision_plan(settings)

    # ------------------------------------------------------------------ hooks（測試以假物件替換）
    def _create_engine(self, model_path: str, options: Mapping[str, Any]) -> Engine:
        from .engine import QwenEngine  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.

        return QwenEngine(
            model_path,
            device="cuda:0",
            attn_implementation=str(options["attn_implementation"]),
            min_pixels=int(options["min_pixels"]),
            max_pixels=int(options["max_pixels"]),
        )

    def _require_cuda(self) -> None:
        import torch

        if not torch.cuda.is_available():
            raise ComponentError(
                "RUNTIME_UNAVAILABLE", "CUDA 不可用；qimg.vision 需要支援 BF16 的 GPU"
            )
        if not torch.cuda.is_bf16_supported():
            raise ComponentError(
                "UNSUPPORTED_SETTING", "此 GPU 不支援 BF16（不自動換精度）"
            )

    def _device_memory(self, options: Mapping[str, Any]) -> memory.DeviceMemory:
        """共用 helper：先釋放本程序 allocator 的閒置區塊（常駐權重不動），再量 mem_get_info、is_integrated 與 /proc/meminfo，依 memory_model 決定可用量；量測失敗的欄位是 null+原因."""
        return memory.device_memory(
            0,
            memory_model=str(options["memory_model"]),
            unified_reserve_bytes=int(options["unified_reserve_bytes"]),
        )

    def _load_image(self, path: Path, port: str) -> ViewImage:
        return load_view_image(path, port)

    def _crop_image(self, view: ViewImage, crop: Mapping[str, Any]) -> ViewImage:
        return crop_view(view, crop)

    def _allocator(self) -> Any:
        from phasyn_components.recorder.gpu import AllocatorWindow

        return AllocatorWindow(0)

    def _runtime_identity(self) -> dict[str, Any]:
        from phasyn_components.recorder.gpu import runtime_identity

        return runtime_identity()

    def _backend_flags(self) -> dict[str, Any]:
        from phasyn_components.recorder.gpu import torch_backend_flags

        return torch_backend_flags()

    # ------------------------------------------------------------------ load
    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load the component and report its actual configuration."""
        load = ctx.load
        problem = model_problem(load.get("model_path"))
        if problem:
            raise ComponentError("COMPONENT_NOT_CONFIGURED", problem)
        options = resolve_options(load)
        model_path = str(load["model_path"])
        self._require_cuda()
        self.config = json.loads(
            (Path(model_path) / "config.json").read_text(encoding="utf-8")
        )
        self.weights_bytes = capacity.weight_bytes(Path(model_path))
        report = capacity.capacity_report(
            stage="load",
            mode=str(options["capacity_check"]),
            memory=self._device_memory(options),
            weights_bytes=self.weights_bytes,
            resident_weights_bytes=0,
            kv_bytes=capacity.kv_upper_bound(
                self.config, int(options["max_context_tokens"])
            ),
            kv_tokens=int(options["max_context_tokens"]),
            activation_reserve_bytes=int(options["activation_reserve_bytes"]),
            reserve_bytes=int(options["reserve_bytes"]),
        )
        ctx.recorder.log("info", "qimg.vision 載入前容量預檢", **report)
        capacity.enforce(report)
        allocator = self._allocator()
        allocator.start()
        with ctx.recorder.phase("load"):
            self.engine = self._create_engine(model_path, options)
        allocator.finish(ctx.recorder, scope="load")
        self.options = options
        self.identity = model_identity(model_path)
        self.libraries = upstream.library_versions(LIBRARIES, vcs=())
        dtypes = getattr(self.engine, "parameter_dtypes", None)
        observed = {
            "parameter_dtypes": dtypes() if callable(dtypes) else None,
            "quantization": "none",
            "backend_flags": self._backend_flags(),
            "accumulation_dtype": None,
            "accumulation_dtype_reason": "kernel 累加精度無法觀測",
            "library_versions": self.libraries,
            "capacity_load": report,
            "templates": TEMPLATE_SOURCE,
        }
        effective = dict(load)
        effective["precision"] = {
            "compute_dtype": "bf16",
            "quantization": {"scheme": "none"},
        }
        effective["offload"] = {"mode": "none"}
        effective["provider_options"] = dict(options)
        return LoadResult(
            effective_load=effective,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=self.identity,
            runtime_identity=self._runtime_identity(),
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the loaded component state."""
        engine, self.engine = self.engine, None
        if engine is not None:
            engine.close()
        with contextlib.suppress(Exception):
            import torch

            torch.cuda.empty_cache()

    def after_failure(self, code: str) -> dict[str, Any] | None:
        """Runs after the host has cleared the failed call's frames (the KV cache and activations live only there): release the cache and report whether the process is back at its allocation before the call."""
        call_memory, self._call_memory = self._call_memory, None
        if call_memory is not None:
            return call_memory.settle(code)
        if code == "GPU_OOM":
            with contextlib.suppress(Exception):
                import torch

                torch.cuda.synchronize()
                torch.cuda.empty_cache()
        return None

    # ------------------------------------------------------------------ invoke
    def invoke(self, ctx: RunContext) -> None:
        """Run this provider with the validated call context."""
        self._call_memory = None
        if self.engine is None:
            raise ComponentError("COMPONENT_NOT_READY", "qimg.vision 尚未載入模型")
        rec = ctx.recorder
        params = {key: spec.get("default") for key, spec in PARAMS.items()} | dict(
            ctx.parameters
        )
        op = str(params["op"])
        language = str(params["language"])
        fmt = op_format(op, str(self.options["output_format"]))
        request = build_request(ctx, op, language, params)
        attempts: list[dict[str, Any]] = []
        raws: list[str] = []
        first_token: list[float | None] = []
        allocator = self._allocator()
        allocator.start()
        self._call_memory = CallMemory.start(0, allocator)
        try:
            with rec.span("vision.images", part="vision.preprocess"):
                views = self._views(ctx, op, request["crops"])
            parsed, prepared, report = self._run_attempts(
                ctx,
                _AttemptInput(fmt, language, request, views),
                _AttemptHistory(attempts, raws, first_token),
            )
        finally:
            if attempts:
                self._metrics(ctx, attempts, first_token[0] if first_token else None)
            allocator.finish(rec, scope="invoke")
        result = {
            "op": op,
            "language": language,
            "output_format": fmt.output_format,
            "views": [
                {
                    "view_id": view_id,
                    "port": port,
                    "sha256": str((ctx.input(port).file or {}).get("sha256") or ""),
                    "crop": None if crop is None else dict(crop),
                    "width": image.width,
                    "height": image.height,
                    "effective_width": dims[0] if dims else None,
                    "effective_height": dims[1] if dims else None,
                    "source_format": image.source_format,
                    "had_alpha": image.had_alpha,
                    "had_icc_profile": image.had_icc_profile,
                }
                for (view_id, port, image, crop), dims in zip(
                    views, self._dims(prepared, len(views)), strict=True
                )
            ],
            "caption": parsed.caption,
            "scene": parsed.scene,
            "comparison": parsed.comparison,
            "pairwise": parsed.pairwise,
            "attempts": attempts,
            "provenance": self._provenance(
                fmt, repaired=len(attempts) > 1, parsed=parsed
            ),
            "capacity": report,
        }
        contracts.validate(
            "PromptVisionResult", result, code="RUNTIME_ERROR", what="vision 結果"
        )
        ctx.set_output("result", result)
        for port, value in (
            ("caption", parsed.caption),
            ("scene", parsed.scene),
            ("comparison", parsed.comparison),
            ("pairwise", parsed.pairwise),
        ):
            if value is not None:
                ctx.set_output(port, value)

    def _run_attempts(
        self,
        ctx: RunContext,
        inputs: _AttemptInput,
        history: _AttemptHistory,
    ) -> tuple[Parsed, Prepared, dict[str, Any]]:
        """第一次生成，不合格時在同一個 invoke 內最多修復一次."""
        fmt, language, request, views = (
            inputs.fmt,
            inputs.language,
            inputs.request,
            inputs.views,
        )
        attempts, raws, first_token = (
            history.attempts,
            history.raws,
            history.first_token,
        )
        if self.engine is None:
            raise AssertionError
        rec = ctx.recorder
        labels = [ViewLabel(view_id, crop) for view_id, _port, _image, crop in views]
        images = [image.image for _view, _port, image, _crop in views]
        payload = task_payload(
            language=language,
            caption=request["caption"],
            scene=request["scene"],
            instruction=request["instruction"],
            comparison=request["comparison"],
            intentional_changes=request["intentional_changes"],
        )
        output_limit = int(
            self.options[
                "caption_max_new_tokens" if fmt.op == "caption" else "max_new_tokens"
            ]
        )
        scene_views = [
            view_id for view_id, port, _image, _crop in views if port == "image"
        ]
        prompt = _VisionPrompt(fmt, labels, images, payload)
        repair: Repair | None = None
        for index in (1, 2):
            ctx.check_cancelled()
            prepared, mode = self._prepare(ctx, prompt, repair, output_limit, attempts)
            report = self._invoke_capacity(prepared.input_tokens + output_limit)
            rec.log("info", f"qimg.vision 生成前容量預檢（第 {index} 次）", **report)
            capacity.enforce(report)
            with rec.span(f"vision.generate.{index}", part="language_model"):
                generation = self.engine.generate(
                    prepared, max_new_tokens=output_limit, should_stop=ctx.cancelled
                )
            ctx.check_cancelled()
            first_token.append(generation.first_token_ms)
            attempt = self._attempt(index, prepared, generation, mode)
            attempts.append(attempt)
            raws.append(generation.raw)
            rec.log(
                "info",
                f"qimg.vision 原始輸出（第 {index} 次）",
                text=generation.raw[:RAW_LOG_CHARS],
                truncated=len(generation.raw) > RAW_LOG_CHARS,
                sha256=attempt["raw_sha256"],
                finish_reason=generation.finish_reason,
            )
            try:
                with rec.span(f"vision.parse.{index}", part="vision.parse"):
                    parsed = parse_output(
                        fmt,
                        generation.raw,
                        generation.finish_reason,
                        language=language,
                        view_ids=scene_views,
                        previous_scene=request["scene"] if fmt.op == "revise" else None,
                    )
            except OutputInvalid as exc:
                attempt["errors"] = list(exc.errors)
                rec.log(
                    "warning",
                    f"qimg.vision 輸出不符合契約（第 {index} 次）",
                    errors=list(exc.errors),
                )
                if (
                    not fmt.repairable
                    or index == _REPAIR_ATTEMPT
                    or generation.finish_reason == "length"
                ):
                    reason = (
                        "已用掉唯一一次修復"
                        if index == _REPAIR_ATTEMPT
                        else "caption 不做 JSON 修復"
                        if not fmt.repairable
                        else "輸出因 token 上限截斷，不做修復"
                    )
                    raise ComponentError(
                        "MODEL_OUTPUT_INVALID",
                        f"模型輸出不符合契約（{len(attempts)} 次嘗試；{reason}）：{exc.errors[0]}",
                        details={
                            "op": fmt.op,
                            "output_format": fmt.output_format,
                            "attempts": [
                                {**item, "raw_excerpt": raw[:2000]}
                                for item, raw in zip(attempts, raws, strict=True)
                            ],
                        },
                        status=422,
                    ) from exc
                repair = Repair(generation.raw, exc.errors)
                continue
            attempt["valid"] = True
            if parsed.ignored_locked_observations:
                rec.log(
                    "warning",
                    f"qimg.vision 未採用模型寫在鎖定區段的觀察（第 {index} 次）；鎖定區段沿用原場景的文字與證據",
                    sections=dict(parsed.ignored_locked_observations),
                )
            return parsed, prepared, report
        raise AssertionError("unreachable")  # pragma: no cover

    # ------------------------------------------------------------------ invoke helpers
    def _views(
        self, ctx: RunContext, op: str, crops: list[dict[str, Any]]
    ) -> list[tuple[str, str, ViewImage, dict[str, Any] | None]]:
        full = self._load_image(ctx.input("image").require_path("image"), "image")
        views: list[tuple[str, str, ViewImage, dict[str, Any] | None]] = [
            ("v-full", "image", full, None)
        ]
        views.extend(
            (str(crop["view_id"]), "image", self._crop_image(full, crop), crop)
            for crop in crops
        )
        for view_id, port in EXTRA_VIEWS.get(op, ()):
            views.append(
                (
                    view_id,
                    port,
                    self._load_image(ctx.input(port).require_path(port), port),
                    None,
                )
            )
        return views

    def _prepare(
        self,
        ctx: RunContext,
        prompt: _VisionPrompt,
        repair: Repair | None,
        output_limit: int,
        attempts: list[dict[str, Any]],
    ) -> tuple[Prepared, str | None]:
        fmt, labels, images, payload = (
            prompt.fmt,
            prompt.labels,
            prompt.images,
            prompt.payload,
        )
        if self.engine is None:
            raise AssertionError
        limit = int(self.options["max_context_tokens"])
        mode = "full" if repair is not None else None
        with ctx.recorder.span("vision.prepare", part="vision_encoder"):
            prepared = self.engine.prepare(
                build_messages(fmt, labels, payload, repair), images
            )
            if prepared.input_tokens + output_limit > limit and repair is not None:
                ctx.check_cancelled()
                # 只有前次無效輸出可以省略；原圖、任務資料、鎖定內容與驗證錯誤都完整保留
                mode = "omitted_previous_output"
                prepared = self.engine.prepare(
                    build_messages(
                        fmt, labels, payload, repair, omit_previous_output=True
                    ),
                    images,
                )
        if prepared.input_tokens + output_limit > limit:
            raise ComponentError(
                "CONTEXT_BUDGET_EXCEEDED",
                f"Qwen 輸入 {prepared.input_tokens} tokens\N{FULLWIDTH PLUS SIGN}輸出預留 {output_limit} 超過 max_context_tokens {limit}；"
                "未截斷圖片、任務資料或鎖定描述"
                + (
                    "；已省略修復輸入中的前次無效輸出仍不夠"
                    if mode == "omitted_previous_output"
                    else ""
                ),
                details={
                    "input_tokens": prepared.input_tokens,
                    "output_limit": output_limit,
                    "max_context_tokens": limit,
                    "repair_input_mode": mode,
                    "attempts": attempts,
                },
                status=422,
            )
        return prepared, mode

    def _invoke_capacity(self, context_tokens: int) -> dict[str, Any]:
        return capacity.capacity_report(
            stage="invoke",
            mode=str(self.options["capacity_check"]),
            memory=self._device_memory(self.options),
            weights_bytes=self.weights_bytes,
            resident_weights_bytes=self.weights_bytes,
            kv_bytes=capacity.kv_upper_bound(self.config, context_tokens),
            kv_tokens=context_tokens,
            activation_reserve_bytes=int(self.options["activation_reserve_bytes"]),
            reserve_bytes=int(self.options["reserve_bytes"]),
        )

    @staticmethod
    def _attempt(
        index: int, prepared: Prepared, generation: Generation, mode: str | None
    ) -> dict[str, Any]:
        return {
            "attempt": index,
            "raw_sha256": hashlib.sha256(generation.raw.encode("utf-8")).hexdigest(),
            "raw_chars": len(generation.raw),
            "input_tokens": prepared.input_tokens,
            "output_tokens": generation.output_tokens,
            "finish_reason": generation.finish_reason,
            "valid": False,
            "errors": [],
            "repair_input_mode": mode,
            "elapsed_ms": generation.elapsed_ms,
        }

    @staticmethod
    def _dims(prepared: Prepared, count: int) -> list[tuple[int, int] | None]:
        dims: list[tuple[int, int] | None] = []
        dims.extend(prepared.effective_pixels[:count])
        return dims + [None] * (count - len(dims))

    def _metrics(
        self,
        ctx: RunContext,
        attempts: list[dict[str, Any]],
        first_token_ms: float | None,
    ) -> None:
        rec = ctx.recorder
        rec.set_metric(
            "input_tokens",
            sum(int(item["input_tokens"]) for item in attempts),
            unit="count",
            scope="component_call",
            method="runtime_hook",
            count=len(attempts),
        )
        rec.set_metric(
            "output_tokens",
            sum(int(item["output_tokens"]) for item in attempts),
            unit="count",
            scope="component_call",
            method="runtime_hook",
            count=len(attempts),
        )
        rec.set_metric(
            "caption_ttft_ms",
            first_token_ms,
            scope="vision_generate_start_to_first_token",
            method="host_monotonic_stopping_criteria",
            reason=None if first_token_ms is not None else "沒有產生任何 token",
        )
        rec.set_metric(
            "qimg.vision.attempts",
            len(attempts),
            unit="count",
            scope="component_call",
            method="runtime_hook",
        )

    def _provenance(
        self, fmt: OpFormat, *, repaired: bool, parsed: Parsed
    ) -> dict[str, Any]:
        templates = {fmt.template_name: template_fingerprint(fmt.template_name)}
        if repaired and fmt.repair_template_name is not None:
            templates[fmt.repair_template_name] = template_fingerprint(
                fmt.repair_template_name
            )
        schemas = (
            {fmt.schema_name: schema_fingerprint(fmt.schema_name)}
            if fmt.schema_name
            else {}
        )
        if fmt.op in ("analyze", "revise") and fmt.compact:
            schemas["SceneDraft"] = schema_fingerprint("SceneDraft")
        extra: dict[str, Any] = {}
        if fmt.op == "revise" and fmt.compact:
            # observations the model wrote inside locked sections, per section: not used (the locked evidence is kept)
            extra["ignored_locked_observations"] = dict(
                parsed.ignored_locked_observations
            )
        return {
            "provider_id": self.provider_id,
            "component_id": self.host.component_id,
            "model": {
                "name": (self.identity.get("components") or {})
                .get("model", {})
                .get("name"),
                **{
                    key: self.identity.get(key)
                    for key in ("architectures", "config_json_sha256", "weight_bytes")
                },
            },
            "templates": templates,
            "template_source": TEMPLATE_SOURCE,
            "schemas": schemas,
            "converter": fmt.converter,
            "output_format_setting": "compact" if fmt.compact else "full",
            "repair_input_policy": REPAIR_INPUT_POLICY if fmt.repairable else None,
            "normalization": NORMALIZATION,
            "processor": {
                "min_pixels": self.options["min_pixels"],
                "max_pixels": self.options["max_pixels"],
            },
            "dtype": "bf16",
            "quantization": "none",
            "attn_implementation": self.options["attn_implementation"],
            "max_new_tokens": self.options[
                "caption_max_new_tokens" if fmt.op == "caption" else "max_new_tokens"
            ],
            "max_context_tokens": self.options["max_context_tokens"],
            "do_sample": False,
            "library_versions": dict(self.libraries),
            **extra,
        }


__all__ = ["QwenVisionProvider"]
