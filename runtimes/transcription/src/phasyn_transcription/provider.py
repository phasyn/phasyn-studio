"""Offline speech transcription provider with independent transcript and SRT artifacts."""

from __future__ import annotations

import json
from collections.abc import Mapping
from importlib import import_module
from importlib.metadata import version
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, LoadResult, Port

from .snapshot import MODEL, verified_files, weight_plan
from .source import SAMPLE_RATE, unpack_audio
from .transcript import recognize, subtitles


if TYPE_CHECKING:
    from phasyn_components.provider import (
        InputValue,
        LoadContext,
        RunContext,
        UnloadContext,
    )
    from phasyn_components.weights import WeightPlan


_PROVIDER = "media.transcribe"
_DECLARATION = Path(__file__).with_name("native_capabilities") / f"{_PROVIDER}.json"


def _source(ctx: RunContext) -> tuple[str, InputValue]:
    selected = [
        (name, value)
        for name in ("audio_file", "video_file")
        if (value := ctx.optional_input(name)) is not None
    ]
    if len(selected) != 1:
        raise ComponentError(
            "INVALID_ARGUMENT", "Choose exactly one audio or video source"
        )
    return selected[0]


class TranscriptionProvider(BaseProvider):
    """Recognize one local source using the verified multilingual small model."""

    provider_id: ClassVar[str] = _PROVIDER
    model: Any = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Return portable typed ports without importing the inference libraries."""
        del settings
        data = json.loads(_DECLARATION.read_text(encoding="utf-8"))
        missing = [
            name
            for name in data["resources"]["required_modules"]
            if find_spec(name) is None
        ]
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label=data["label"],
            inputs=[Port(**row) for row in data["inputs"]],
            outputs=[Port(**row) for row in data["outputs"]],
            settings_schema=data["settings_schema"],
            parameters_schema=data["parameters_schema"],
            default_settings=data["default_settings"],
            available=not missing,
            unavailable_code="PROVIDER_NOT_INSTALLED" if missing else None,
            unavailable_reason=f"Missing ASR runtime libraries: {', '.join(missing)}"
            if missing
            else None,
            facts={
                "time_basis": "container_start",
                "subtitle_time_basis": "clip_origin",
                "transcription": "speech.transcript.v1",
            },
        )

    @classmethod
    def weights(cls, settings: Mapping[str, Any] | None) -> WeightPlan:
        """Expose the immutable public inventory for the explicit Node weight installer."""
        load = (settings or {}).get("load")
        path = load.get("model_path") if isinstance(load, Mapping) else None
        return weight_plan(path if isinstance(path, str) else None)

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Load from verified memory; CUDA's assigned device is local ordinal zero."""
        if ctx.load.get("model_revision") not in (None, MODEL.revision):
            raise ComponentError(
                "INVALID_ARGUMENT", "Unsupported ASR checkpoint revision"
            )
        device = ctx.device["kind"]
        if device not in {"cpu", "cuda"}:
            raise ComponentError("UNSUPPORTED_SETTING", "Unsupported ASR device")
        compute = "float16" if device == "cuda" else "int8"
        ct2 = import_module("ctranslate2")
        if compute not in ct2.get_supported_compute_types(device, 0):
            raise ComponentError(
                "UNSUPPORTED_SETTING", f"ASR device does not support {compute}"
            )
        with ctx.recorder.phase("verify_weights"):
            files = verified_files(Path(ctx.load["model_path"]))
        engine = import_module("faster_whisper")
        ctx.work_dir.mkdir(parents=True, exist_ok=True)
        with ctx.recorder.phase("load"), TemporaryDirectory(dir=ctx.work_dir) as empty:
            self.model = engine.WhisperModel(
                empty,
                files=files,
                local_files_only=True,
                device=device,
                device_index=0,
                compute_type=compute,
                num_workers=1,
            )
        return LoadResult(
            effective_load=ctx.load,
            expanded_parts=ctx.expanded_parts,
            model_identity={"repo": MODEL.repo, "revision": MODEL.revision},
            runtime_identity={
                "faster_whisper": version("faster-whisper"),
                "ctranslate2": version("ctranslate2"),
                "compute_type": self.model.model.compute_type,
            },
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release the component's resident CTranslate2 model."""
        with ctx.recorder.phase("unload"):
            self.model = None

    def invoke(self, ctx: RunContext) -> None:
        """Publish both immutable files after decoding and transcription have completed."""
        if self.model is None:
            raise ComponentError(
                "COMPONENT_NOT_READY", "Load the ASR model before transcribing"
            )
        port, source = _source(ctx)
        path = source.require_path(port)
        if source.file is None:
            raise ComponentError(
                "INVALID_ARGUMENT", "Transcription requires a published source file"
            )
        with TemporaryDirectory(dir=ctx.work_dir, prefix="asr-") as work:
            pcm = Path(work) / "source.pcm"
            with ctx.recorder.phase("decode_audio"):
                track, count = unpack_audio(ctx, path, pcm)
            ctx.check_cancelled()
            with ctx.recorder.phase("transcribe"):
                cues, recognition = recognize(ctx, self.model, pcm, count)
        language, confidence = recognition["language"], recognition["confidence"]
        ctx.check_cancelled()
        source_file = {
            key: source.file[key]
            for key in ("node_id", "file_id", "size_bytes", "media_type", "sha256")
        }
        settings = {
            "audio_stream": track.ordinal,
            "channel": ctx.parameters.get("channel"),
            "language": ctx.parameters.get("language"),
            "vad": ctx.parameters.get("vad", True),
            "word_timestamps": ctx.parameters.get("word_timestamps", False),
            "chinese_script": ctx.parameters.get("chinese_script"),
            "script_conversion": recognition["script_conversion"],
            "beam_size": 5,
        }
        transcript = {
            "schema_version": "1.1",
            "time_basis": "container_start",
            "source": {
                "file": source_file,
                "audio_stream": track.ordinal,
                "stream_index": track.index,
                "channel": settings["channel"],
                "channel_count": track.channel_count,
                "source_start_time": track.source_start_time,
                "clip_origin_offset": {
                    "num": track.clip_origin_offset.numerator,
                    "den": track.clip_origin_offset.denominator,
                },
                "stream_start_time": track.stream_start_time,
            },
            "sample_rate": SAMPLE_RATE,
            "sample_count": count,
            "model": {
                "repo": MODEL.repo,
                "revision": MODEL.revision,
                "faster_whisper_version": version("faster-whisper"),
                "ctranslate2_version": version("ctranslate2"),
                "compute_type": self.model.model.compute_type,
            },
            "settings": settings,
            "language": language,
            "language_probability": confidence,
            "segments": cues,
        }
        metadata = {"source_sha256": source_file["sha256"], "segment_count": len(cues)}
        srt = ctx.new_file(
            "srt_file",
            "application/x-subrip",
            {**metadata, "filename": "subtitles.srt"},
        )
        srt.write(subtitles(cues, offset_ms=round(1000 * track.clip_origin_offset)))
        ctx.set_file_output("srt_file", srt)
        document = ctx.new_file(
            "transcript_file",
            "application/json",
            {**metadata, "filename": "transcript.json"},
        )
        document.write(
            json.dumps(transcript, ensure_ascii=False, allow_nan=False).encode("utf-8")
        )
        ctx.set_file_output("transcript_file", document)
