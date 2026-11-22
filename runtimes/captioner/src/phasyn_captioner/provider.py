"""``qwen_vl.describe``（kind video.describe）：原片 FileRef → 依真實 PTS 抽樣 → 一次完整時序理解 → SceneDocument。

這是 Qwen-VL 的文字生成路徑，與 H3 TE 的 hidden-state tap 是不同 provider／instance／model handle
（即使使用者指向同一份權重檔，也不共用 VRAM 或程序）。模型描述不能捏造未看見的動作：輸出
經過結構檢查（事件時間不得超出片長、證據影格必須存在），不合格的內容標 uncertain 並在 unknowns
說明；解析失敗直接報錯，不產生假 Scene。
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components import model_identity as identity
from phasyn_components.errors import ComponentError
from phasyn_components.provider import (
    BaseProvider,
    Description,
    LoadContext,
    LoadResult,
    Part,
    Port,
    RunContext,
    UnloadContext,
    settings_schema,
)
from phasyn_components.settings import normalize_recording

SUPPORTED_ARCHS = (
    "Qwen3VLForConditionalGeneration",
    "Qwen2_5_VLForConditionalGeneration",
    "Qwen2VLForConditionalGeneration",
)
# generate() stops at the next token boundary once the call is cancelled; this only bounds a stuck kernel.
JOIN_TIMEOUT_S = 30.0
PARAMS: dict[str, dict[str, Any]] = {
    "sampling_fps": {"type": "number", "exclusiveMinimum": 0, "maximum": 60, "default": 4},
    "fast_motion": {"type": "boolean", "default": False, "description": "快動作片段改用 fast_motion_fps"},
    "fast_motion_fps": {"type": "number", "exclusiveMinimum": 0, "maximum": 60, "default": 12},
    "preserve_endpoints": {"type": "boolean", "default": True},
    "max_frames": {"type": "integer", "minimum": 2, "maximum": 512, "default": 64},
    "max_side": {"type": "integer", "minimum": 64, "maximum": 2048, "default": 640},
    "max_new_tokens": {"type": "integer", "minimum": 64, "maximum": 8192, "default": 1536},
    "language": {"enum": ["zh-Hant", "en"], "default": "zh-Hant"},
    "hint": {"type": ["string", "null"], "default": None, "description": "給模型的補充說明（不是事實來源）"},
}
SYSTEM = (
    "You describe a video strictly from the sampled frames you are shown. Output ONLY one JSON object with keys: "
    "entities (list of {entity_id, kind, description}), initial_state (string), final_state (string), "
    "events (list of {event_id, entity_ids, start_seconds, end_seconds, description, evidence_frame_ids, certainty}), "
    "camera (string), unknowns (list of strings). Use only frame ids that were provided. certainty is 'observed' "
    "only when the frames clearly show it, otherwise 'uncertain'. Never invent actions that are not visible; "
    "if something is unclear, put it in unknowns. Times are seconds from the start of the video."
)


def _schema() -> dict[str, Any]:
    return settings_schema(
        precision_properties={
            "weight_format": {"enum": ["native"]},
            "compute_dtype": {"enum": ["bf16", "fp16"]},
            "quantization": {
                "type": "object",
                "properties": {"scheme": {"enum": ["none", "nf4", "int8"]}},
                "additionalProperties": False,
            },
            "autocast_dtype": {"type": "null"},
            "accumulation_dtype": {"type": "null"},
            "matmul_tf32": {"type": "null"},
            "cudnn_tf32": {"type": "null"},
            "reduced_precision_reduction": {"type": "null"},
            "output_dtype": {"enum": ["native"]},
            "weight_dtype": {"enum": ["native"]},
        },
        offload_schema={"type": "object", "properties": {"mode": {"enum": ["none"]}}, "additionalProperties": False},
        provider_options={"attn_implementation": {"enum": ["sdpa", "eager", "flash_attention_2"]}},
        invoke_properties=PARAMS,
        require_model_path=True,
        device_kinds=("cuda",),
    )


def _tied_embeddings(config: Mapping[str, Any]) -> bool:
    """A model whose output head reuses the input embeddings generates text without an lm_head tensor."""
    text = config.get("text_config")
    return config.get("tie_word_embeddings") is True or (
        isinstance(text, Mapping) and text.get("tie_word_embeddings") is True
    )


def _model_problem(model_path: str | None) -> str | None:
    if not model_path:
        return "未設定 load.model_path（Qwen-VL 權重目錄）"
    root = Path(model_path)
    cfg = root / "config.json"
    if not cfg.is_file():
        return f"找不到 {identity.display_path(cfg, root)}"
    try:
        doc = json.loads(cfg.read_text(encoding="utf-8"))
        archs = doc.get("architectures") or []
    except ValueError:
        return f"{identity.display_path(cfg, root)} 無法解析"
    if not any(a in SUPPORTED_ARCHS for a in archs):
        return f"不支援的架構 {archs}（需要 {', '.join(SUPPORTED_ARCHS)}）"
    index = root / "model.safetensors.index.json"
    if index.is_file():
        try:
            weights = json.loads(index.read_text(encoding="utf-8")).get("weight_map") or {}
        except ValueError:
            return f"{identity.display_path(index, root)} 無法解析"
        if not _tied_embeddings(doc) and not any(k.endswith("lm_head.weight") for k in weights):
            return "權重沒有 lm_head，無法做文字生成（只能當 feature encoder）"
    if not ((root / "preprocessor_config.json").is_file() or (root / "processor_config.json").is_file()):
        return "缺少 processor 設定（preprocessor_config.json）"
    return None


def extract_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"```(?:json)?", "", text)
    start = cleaned.find("{")
    if start < 0:
        raise ValueError("輸出沒有 JSON object")
    depth = 0
    for i, ch in enumerate(cleaned[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start : i + 1])
    raise ValueError("JSON object 不完整（可能被 max_new_tokens 截斷）")


def cancel_criteria(should_stop: Callable[[], bool]) -> Any:
    """A StoppingCriteriaList that ends ``generate()`` at the next token boundary once ``should_stop()`` is true."""
    from transformers import StoppingCriteria, StoppingCriteriaList

    class _StopWhenCancelled(StoppingCriteria):
        def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
            return bool(should_stop())

    return StoppingCriteriaList([_StopWhenCancelled()])


def stream_generate(
    generate: Callable[[], Any],
    streamer: Any,
    *,
    should_stop: Callable[[], bool],
    join_timeout_s: float = JOIN_TIMEOUT_S,
) -> tuple[str, Any, float | None]:
    """Run ``generate`` in a worker thread and collect the streamed text → (text, generated ids, first-token seconds).

    ``generate`` must stop by itself at the next token boundary once ``should_stop()`` is true (``cancel_criteria``);
    the reader stops collecting at the same time. A worker that has not finished ``join_timeout_s`` after the stream
    ended is reported as an error instead of blocking the call forever.
    """
    result: dict[str, Any] = {}

    def run() -> None:
        try:
            result["ids"] = generate()
        except BaseException as exc:  # re-raised in the caller's thread below
            result["error"] = exc
            streamer.end()  # generate() never reached its own end(): unblock the reader

    worker = threading.Thread(target=run, name="captioner-generate", daemon=True)
    started = time.perf_counter()
    first: float | None = None
    chunks: list[str] = []
    worker.start()
    pieces: Iterable[str] = streamer
    for piece in pieces:
        if first is None:
            first = time.perf_counter() - started
        chunks.append(piece)
        if should_stop():
            break
    worker.join(join_timeout_s)
    if worker.is_alive():
        raise ComponentError("RUNTIME_ERROR", f"generate 在停止後 {join_timeout_s:g} 秒內沒有結束（GPU 可能卡住）")
    if "error" in result:
        raise result["error"]
    return "".join(chunks), result.get("ids"), first


def build_scene(
    raw: Mapping[str, Any],
    *,
    source: Mapping[str, Any],
    duration: float,
    evidence: list[dict[str, Any]],
    caption_model: Mapping[str, Any],
) -> dict[str, Any]:
    """把模型輸出整理成 SceneDocument；不合法的內容降為 uncertain 並寫入 unknowns，不偷改成確定事實。"""
    ids = {e["frame_id"] for e in evidence}
    unknowns = [str(u) for u in raw.get("unknowns") or [] if str(u).strip()]
    entities = []
    seen_entities: set[str] = set()
    for i, ent in enumerate(raw.get("entities") or []):
        if not isinstance(ent, Mapping):
            continue
        eid = re.sub(r"[^A-Za-z0-9_.:-]", "_", str(ent.get("entity_id") or f"e{i}"))[:160] or f"e{i}"
        if not eid[0].isalnum():
            eid = f"e{eid}"
        if eid in seen_entities:
            continue
        seen_entities.add(eid)
        entities.append(
            {
                "entity_id": eid,
                "kind": str(ent.get("kind") or "unknown"),
                "description": str(ent.get("description") or ""),
            }
        )
    events = []
    for i, ev in enumerate(raw.get("events") or []):
        if not isinstance(ev, Mapping):
            continue
        try:
            start = float(ev.get("start_seconds", 0))
            end = float(ev.get("end_seconds", start))
        except (TypeError, ValueError):
            unknowns.append(f"事件 {i} 的時間無法解析，已略過")
            continue
        certainty = "observed" if ev.get("certainty") == "observed" else "uncertain"
        if start < 0 or end > duration + 1e-6 or end < start:
            unknowns.append(
                f"事件 {i} 的時間 {start}–{end} 超出影片長度 {duration:.3f}s 或起訖顛倒；已截至合法範圍並標 uncertain"
            )
            start, end = max(0.0, min(start, duration)), max(0.0, min(max(end, start), duration))
            certainty = "uncertain"
        cited = [str(f) for f in ev.get("evidence_frame_ids") or []]
        valid = [f for f in cited if f in ids]
        if len(valid) != len(cited):
            unknowns.append(f"事件 {i} 引用了不存在的證據影格 {sorted(set(cited) - set(valid))}；已移除")
        if not valid:
            certainty = "uncertain"
        ent_ids = [e for e in (str(x) for x in ev.get("entity_ids") or []) if e in seen_entities]
        events.append(
            {
                "event_id": f"ev{i:03d}",
                "entity_ids": ent_ids,
                "start_seconds": start,
                "end_seconds": end,
                "description": str(ev.get("description") or ""),
                "evidence_frame_ids": valid,
                "certainty": certainty,
            }
        )
    scene = {
        "schema_version": "4.0",
        "source": dict(source),
        "duration_seconds": duration,
        "entities": entities,
        "initial_state": str(raw.get("initial_state") or ""),
        "final_state": str(raw.get("final_state") or ""),
        "events": events,
        "camera": str(raw.get("camera") or ""),
        "evidence": evidence,
        "unknowns": unknowns,
        "generation_edits": [],
        "caption_model": dict(caption_model),
    }
    contracts.validate("SceneDocument", scene, code="RUNTIME_ERROR", what="SceneDocument")
    return scene


class QwenVLDescribeProvider(BaseProvider):
    provider_id = "qwen_vl.describe"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        reason = None
        code = None
        missing = [m for m in ("torch", "transformers") if importlib.util.find_spec(m) is None]
        if missing:
            reason, code = f"此 runtime 沒有安裝 {', '.join(missing)}", "PROVIDER_NOT_INSTALLED"
        elif settings is not None:
            reason = _model_problem((settings.get("load") or {}).get("model_path"))
            code = "COMPONENT_NOT_CONFIGURED" if reason else None
        empty = {"type": "object", "properties": {}}
        return Description(
            provider_id=cls.provider_id,
            kind="video.describe",
            label="影片反推語意（Qwen-VL 文字生成；依真實 PTS 抽樣，輸出 SceneDocument）",
            inputs=[Port("video", "media.video.v1", True, "file", "原始影片")],
            outputs=[Port("scene", "video.scene.v1", True, "file", "SceneDocument JSON（含證據影格 FileRef）")],
            parts=[
                Part("video.sampling", "preprocess", empty, ["host_ms", "input_frame_count"], "full", None),
                Part("vision_encoder", "vision", empty, ["host_ms"], "partial", "視覺塔時間計入 prefill"),
                Part(
                    "language_model",
                    "llm",
                    empty,
                    ["host_ms", "input_tokens", "output_tokens", "caption_ttft_ms"],
                    "full",
                    None,
                ),
            ],
            settings_schema=_schema(),
            parameters_schema={"type": "object", "properties": PARAMS, "additionalProperties": False},
            default_settings={
                "load": {
                    "model_path": "",
                    "device": {"kind": "cuda", "id": "GPU-REPLACE", "resource_group": "gpu"},
                    "precision": {"compute_dtype": "bf16", "quantization": {"scheme": "none"}},
                    "offload": {"mode": "none"},
                    "part_overrides": [],
                    "provider_options": {"attn_implementation": "sdpa"},
                },
                "invoke": {"sampling_fps": 4, "max_frames": 64, "language": "zh-Hant"},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            available=reason is None or (settings is None and code != "PROVIDER_NOT_INSTALLED"),
            unavailable_code=code,
            unavailable_reason=reason,
        )

    def load(self, ctx: LoadContext) -> LoadResult:
        import torch
        from phasyn_components.recorder.gpu import AllocatorWindow, runtime_identity, torch_backend_flags
        from transformers import AutoModelForImageTextToText, AutoProcessor

        load = ctx.load
        problem = _model_problem(load.get("model_path"))
        if problem:
            raise ComponentError("COMPONENT_NOT_CONFIGURED", problem)
        precision = load.get("precision") or {}
        dtype = torch.float16 if precision.get("compute_dtype") == "fp16" else torch.bfloat16
        scheme = ((precision.get("quantization") or {}).get("scheme")) or "none"
        # The checkpoint directory is read as data: nothing is fetched from the Hub, no code shipped with a
        # checkpoint is run, and pickled weight files are not accepted.
        local: dict[str, Any] = {"local_files_only": True, "trust_remote_code": False}
        kwargs: dict[str, Any] = {
            **local,
            "use_safetensors": True,
            "dtype": dtype,
            "device_map": {"": 0},
            "attn_implementation": (load.get("provider_options") or {}).get("attn_implementation", "sdpa"),
        }
        if scheme in ("nf4", "int8"):
            from transformers import BitsAndBytesConfig

            kwargs["quantization_config"] = (
                BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype)
                if scheme == "nf4"
                else BitsAndBytesConfig(load_in_8bit=True)
            )
        allocator = AllocatorWindow(0)
        allocator.start()
        with ctx.recorder.phase("load"):
            self.processor = AutoProcessor.from_pretrained(load["model_path"], **local)
            self.model = AutoModelForImageTextToText.from_pretrained(load["model_path"], **kwargs)
            self.model.eval()
        allocator.finish(ctx.recorder, scope="load")
        dtypes: dict[str, int] = {}
        for p in self.model.parameters():
            dtypes[str(p.dtype)] = dtypes.get(str(p.dtype), 0) + int(p.numel())
        root = Path(str(load["model_path"]))
        architectures = json.loads((root / "config.json").read_text(encoding="utf-8")).get("architectures")
        self.identity = identity.model_identity(root, {"model": root}, architectures=architectures)
        observed = {
            "parameter_dtypes": dtypes,
            "quantization": scheme,
            "backend_flags": torch_backend_flags(),
            "accumulation_dtype": None,
            "accumulation_dtype_reason": "kernel 累加精度無法觀測",
        }
        return LoadResult(
            effective_load=load,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity=self.identity,
            runtime_identity=runtime_identity(),
        )

    def unload(self, ctx: UnloadContext) -> None:
        with contextlib.suppress(Exception):
            import torch

            del self.model
            torch.cuda.empty_cache()

    def invoke(self, ctx: RunContext) -> None:
        import numpy as np
        import torch
        from phasyn_components.recorder.gpu import AllocatorWindow
        from phasyn_media.frames import encode_jpeg, extract_frames, frame_times, plan_samples
        from transformers import TextIteratorStreamer
        from transformers.video_utils import VideoMetadata

        rec = ctx.recorder
        params: dict[str, Any] = {k: v.get("default") for k, v in PARAMS.items()} | dict(ctx.parameters)
        item = ctx.input("video")
        path = item.require_path("video")
        fps_target = float(params["fast_motion_fps"] if params.get("fast_motion") else params["sampling_fps"])
        with rec.span("video.sample", part="video.sampling"):
            frames, info = frame_times(path)
            samples = plan_samples(
                frames,
                sampling_fps=fps_target,
                preserve_endpoints=bool(params["preserve_endpoints"]),
                max_frames=int(params["max_frames"]),
            )
            if len(samples) % 2:  # Qwen-VL 以 2 幀為一個 temporal patch；補最後一幀而不是丟幀
                samples.append(samples[-1])
            images = extract_frames(path, samples, max_side=int(params["max_side"]))
        duration = frames[-1].seconds + (frames[-1].seconds - frames[-2].seconds if len(frames) > 1 else 0.0)
        rec.set_metric("input_frame_count", len(samples), unit="count", scope="component_call", method="runtime_hook")
        evidence = []
        seen: set[int] = set()
        frame_lines = []
        for s, img in zip(samples, images, strict=True):
            fid = f"f{s.index:06d}"
            frame_lines.append(f"{fid} @ {s.seconds:.3f}s")
            if s.index in seen:
                continue
            seen.add(s.index)
            out = ctx.new_file(
                None,
                "image/jpeg",
                {"role": "evidence_frame", "source_pts": s.pts, "time_seconds": s.seconds},
                type_id="media.image.v1",
            )
            out.write(encode_jpeg(img))
            out.finish()
            evidence.append(
                {
                    "frame_id": fid,
                    "source_pts": int(s.pts),
                    "time_base": {"num": s.time_base.numerator, "den": s.time_base.denominator},
                    "time_seconds": float(s.seconds),
                    "file": {
                        "node_id": str(rec.node_id),
                        "file_id": out.file_id,
                        "size_bytes": out.size,
                        "sha256": out.sha256,
                        "media_type": "image/jpeg",
                        "metadata": {},
                    },
                }
            )
        language = "Traditional Chinese (zh-Hant)" if params["language"] == "zh-Hant" else "English"
        user_text = (
            f"Video duration: {duration:.3f} s. Sampled frames (id @ time): {', '.join(frame_lines)}. "
            f"Write all descriptions in {language}. "
            + (f"Context hint (not a fact source): {params['hint']}" if params.get("hint") else "")
        )
        messages = [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM}]},
            {"role": "user", "content": [{"type": "video"}, {"type": "text", "text": user_text}]},
        ]
        allocator = AllocatorWindow(0)
        allocator.start()
        with rec.span("processor", part="vision_encoder"):
            text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            video = np.stack(images)
            metadata = VideoMetadata(
                total_num_frames=len(frames),
                fps=1000.0,
                duration=duration,
                width=int(info["width"]),
                height=int(info["height"]),
                frames_indices=[round(s.seconds * 1000) for s in samples],
            )
            inputs = self.processor(
                text=[text], videos=[video], video_metadata=[metadata], do_sample_frames=False, return_tensors="pt"
            ).to(self.model.device)
        prompt_tokens = int(inputs["input_ids"].shape[-1])
        rec.set_metric("input_tokens", prompt_tokens, unit="count", scope="component_call", method="runtime_hook")
        streamer = TextIteratorStreamer(self.processor.tokenizer, skip_prompt=True, skip_special_tokens=True)

        def generate() -> Any:
            with torch.inference_mode():
                return self.model.generate(
                    **inputs,
                    max_new_tokens=int(params["max_new_tokens"]),
                    do_sample=False,
                    streamer=streamer,
                    stopping_criteria=cancel_criteria(ctx.cancelled),
                )

        with rec.span("generate", part="language_model"):
            output_text, ids, first_token_s = stream_generate(generate, streamer, should_stop=ctx.cancelled)
        ctx.check_cancelled()
        output_tokens = int(ids.shape[-1] - prompt_tokens) if ids is not None else None
        rec.set_metric("output_tokens", output_tokens, unit="count", scope="component_call", method="runtime_hook")
        rec.set_metric(
            "caption_ttft_ms",
            first_token_s * 1000 if first_token_s is not None else None,
            scope="captioner_model_start_to_first_token",
            method="host_monotonic_streamer",
            reason=None if first_token_s is not None else "沒有產生任何 token",
        )
        allocator.finish(rec, scope="invoke")
        rec.log("info", "captioner 原始輸出（截斷）", text=output_text[:8000], truncated=len(output_text) > 8000)
        with rec.span("scene.assemble", part="language_model"):
            try:
                raw = extract_json(output_text)
            except (ValueError, json.JSONDecodeError) as exc:
                raise ComponentError(
                    "MODEL_OUTPUT_INVALID",
                    f"captioner 輸出無法解析成 JSON：{exc}",
                    details={"output_excerpt": output_text[:2000]},
                ) from exc
            scene = build_scene(
                raw,
                source=item.file or {},
                duration=duration,
                evidence=evidence,
                caption_model={
                    "provider_id": self.provider_id,
                    "model": self.identity["components"]["model"].get("name"),
                    "sampling_fps": fps_target,
                    "frames": len(samples),
                    "max_new_tokens": int(params["max_new_tokens"]),
                },
            )
        out = ctx.new_file(
            "scene",
            "application/json",
            {"schema": "SceneDocument", "events": len(scene["events"]), "frames": len(evidence)},
        )
        out.write(json.dumps(scene, ensure_ascii=False, indent=2).encode("utf-8"))
        ctx.set_file_output("scene", out)


__all__ = ["QwenVLDescribeProvider", "build_scene", "cancel_criteria", "extract_json", "stream_generate"]
