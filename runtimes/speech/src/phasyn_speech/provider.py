"""Synthesize a stand-alone dialogue track with the pinned Qwen CustomVoice variant."""

from __future__ import annotations

import gc
import hashlib
import os
from importlib import import_module
from importlib.metadata import version
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, ClassVar, override

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, LoadResult, Port

from .snapshot import declaration, stage_weights


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import LoadContext, RunContext, UnloadContext


_MAX_TEXT = 2048
_ENGINE_VERSION = "0.1.1"


def _line(ctx: RunContext) -> str:
    value = ctx.input("text").value
    if isinstance(value, dict):
        value = value.get("text")
    if (
        not isinstance(value, str)
        or not value.strip()
        or "\0" in value
        or len(value) > _MAX_TEXT
    ):
        raise ComponentError(
            "INVALID_ARGUMENT", f"單段台詞需為 1 至 {_MAX_TEXT} 字元的文字"
        )
    return value


def _choice(value: Any, options: list[str], label: str) -> str:
    if not isinstance(value, str) or value not in options:
        raise ComponentError(
            "INVALID_ARGUMENT", f"載入的 CustomVoice 版本不支援這個{label}"
        )
    return value


def _write_track(
    ctx: RunContext, samples: Any, rate: int, provenance: dict[str, Any]
) -> None:
    np = import_module("numpy")
    sf = import_module("soundfile")
    wave = np.asarray(samples)
    if (
        wave.ndim != 1
        or wave.size == 0
        or wave.dtype.kind != "f"
        or not np.isfinite(wave).all()
    ):
        raise ComponentError(
            "RUNTIME_ERROR", "配音模型輸出了空白、非單聲道或無效的樣本"
        )
    if type(rate) is not int or rate <= 0:
        raise ComponentError("RUNTIME_ERROR", "配音模型傳回了無效取樣率")
    # IEEE float WAV retains the decoder's unnormalised float32 samples, including peaks above 0 dBFS.
    audio_info = {
        "sample_rate": rate,
        "sample_count": int(wave.size),
        "channels": 1,
        "subtype": "FLOAT",
    }
    output = ctx.new_file(
        "audio", "audio/wav", {"kind": "synthesized_dialogue", **audio_info}
    )
    sf.write(str(output.path), wave, rate, format="WAV", subtype="FLOAT")
    observed = sf.info(str(output.path))
    if (observed.frames, observed.samplerate, observed.channels, observed.subtype) != (
        wave.size,
        rate,
        1,
        "FLOAT",
    ):
        raise ComponentError("RUNTIME_ERROR", "完成的 WAV 與模型輸出樣本規格不符")
    ctx.check_cancelled()
    output.adopt_written()
    ctx.set_file_output("audio", output)
    ctx.set_output(
        "report", {**provenance, **audio_info, "audio": ctx.file_ref(output)}
    )


class CustomVoiceProvider(BaseProvider):
    """Render one approved line as one independently addressable audio asset."""

    provider_id: ClassVar[str] = "speech.custom_voice"
    _model: Any = None
    _cuda = False
    _snapshot: TemporaryDirectory[str] | None = None

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Return packaged roles and choices without opening a GPU or any weights."""
        del settings
        doc = declaration()
        ready = all(
            find_spec(name) is not None for name in doc["resources"]["required_modules"]
        )
        return Description(
            provider_id=cls.provider_id,
            kind=doc["kind"],
            label=doc["label"],
            inputs=[Port(**port) for port in doc["inputs"]],
            outputs=[Port(**port) for port in doc["outputs"]],
            parameters_schema=doc["parameters_schema"],
            settings_schema=doc["settings_schema"],
            default_settings=doc["default_settings"],
            available=ready,
            unavailable_code=None if ready else "PROVIDER_NOT_INSTALLED",
            unavailable_reason=None
            if ready
            else "請在配音專用環境安裝 qwen-tts 與宣告的相依套件",
            facts={
                "studio_speech": {
                    "version": 1,
                    "text": "text",
                    "audio": "audio",
                    "language": "language",
                    "speaker": "speaker",
                },
                "model_id": doc["models"][0]["id"],
                "model_revision": doc["models"][0]["revision"],
            },
        )

    @override
    def load(self, ctx: LoadContext) -> LoadResult:
        """Activate the verified checkpoint on the assigned CPU or visible GPU."""
        if self._model is not None:
            raise ComponentError("INVALID_ARGUMENT", "請先卸載既有配音模型")
        if (
            os.environ.get("HF_HUB_OFFLINE") != "1"
            or os.environ.get("TRANSFORMERS_OFFLINE") != "1"
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "配音 runtime 需要開啟 Hugging Face 和 Transformers 的離線設定",
            )
        model = declaration()["models"][0]
        load = ctx.load
        source = load.get("model_path")
        device = ctx.device.get("kind")
        if (
            device not in {"cpu", "cuda"}
            or not isinstance(source, str)
            or not Path(source).is_absolute()
            or load.get("model_revision") != model["revision"]
        ):
            raise ComponentError(
                "INVALID_ARGUMENT",
                "請設定 CPU 或 CUDA 裝置、官方 CustomVoice 版本與完整本機路徑",
            )
        if version("qwen-tts") != _ENGINE_VERSION:
            raise ComponentError(
                "PROVIDER_NOT_INSTALLED", f"配音元件需要 qwen-tts {_ENGINE_VERSION}"
            )
        torch = import_module("torch")
        if device == "cuda" and (
            not torch.cuda.is_available()
            or not torch.cuda.is_bf16_supported(including_emulation=False)
        ):
            raise ComponentError(
                "COMPONENT_NOT_READY", "這個配音配方需要支援 BF16 的 CUDA 裝置"
            )
        ctx.work_dir.mkdir(exist_ok=True, parents=True)
        pending = TemporaryDirectory(prefix="custom-voice-", dir=ctx.work_dir)
        try:
            with ctx.recorder.phase("verify-weights"):
                stage_weights(Path(source), Path(pending.name), model["files"])
            with ctx.recorder.phase("load-voice"):
                api = import_module("qwen_tts").Qwen3TTSModel
                self._model = api.from_pretrained(
                    pending.name,
                    local_files_only=True,
                    trust_remote_code=False,
                    dtype=torch.bfloat16 if device == "cuda" else torch.float32,
                    device_map="cuda:0" if device == "cuda" else "cpu",
                    attn_implementation="sdpa",
                )
        except BaseException:
            pending.cleanup()
            raise
        self._snapshot = pending
        self._cuda = device == "cuda"
        return LoadResult(
            effective_load=load,
            expanded_parts=ctx.expanded_parts,
            model_identity={
                "model_id": model["id"],
                "revision": model["revision"],
                "files": model["files"],
            },
            runtime_identity={
                "qwen_tts": _ENGINE_VERSION,
                "torch": str(torch.__version__),
                "device": device,
                "dtype": "bfloat16" if self._cuda else "float32",
                "attention": "sdpa",
            },
        )

    @override
    def unload(self, ctx: UnloadContext) -> None:
        """Release model references, allocations and the verified private snapshot."""
        with ctx.recorder.phase("unload"):
            self._model = None
            gc.collect()
            if self._snapshot is not None:
                if self._cuda:
                    import_module("torch").cuda.empty_cache()
                self._cuda = False
                self._snapshot.cleanup()
                self._snapshot = None

    def invoke(self, ctx: RunContext) -> None:
        """Check actual speaker/language support, synthesize and publish one complete track."""
        engine = self._model
        if engine is None:
            raise ComponentError("COMPONENT_NOT_READY", "請先載入離線配音模型")
        doc = declaration()
        defaults = doc["parameters_schema"]["properties"]
        language = _choice(
            ctx.parameters.get("language", defaults["language"]["default"]),
            defaults["language"]["enum"],
            "語言",
        )
        speaker = _choice(
            ctx.parameters.get("speaker", defaults["speaker"]["default"]),
            defaults["speaker"]["enum"],
            "音色",
        )
        _choice(language.lower(), engine.get_supported_languages(), "語言")
        _choice(speaker.lower(), engine.get_supported_speakers(), "音色")
        instruct = ctx.parameters.get("instruct", "")
        if (
            not isinstance(instruct, str)
            or len(instruct) > defaults["instruct"]["maxLength"]
            or "\0" in instruct
        ):
            raise ComponentError("INVALID_ARGUMENT", "請縮短或修正配音指示")
        seed = ctx.parameters.get("seed", defaults["seed"]["default"])
        if type(seed) is not int or not 0 <= seed <= defaults["seed"]["maximum"]:
            raise ComponentError("INVALID_ARGUMENT", "配音 seed 超出範圍")
        text = _line(ctx)
        torch = import_module("torch")

        def before_step(_module: object, _inputs: object) -> None:
            ctx.check_cancelled()

        ctx.check_cancelled()
        with (
            ctx.recorder.phase("synthesize"),
            torch.inference_mode(),
            torch.random.fork_rng(devices=[0] if self._cuda else []),
        ):
            torch.default_generator.manual_seed(seed)
            if self._cuda:
                torch.cuda.manual_seed(seed)
            # The upstream 0.1.1 wrapper does not forward arbitrary stopping criteria.
            # Its talker enters forward once per codec step; remove our hook even when cancelled.
            with engine.model.talker.register_forward_pre_hook(before_step):
                waves, rate = engine.generate_custom_voice(
                    text=text,
                    language=language,
                    speaker=speaker,
                    instruct=instruct or None,
                )
        ctx.check_cancelled()
        if len(waves) != 1:
            raise ComponentError("RUNTIME_ERROR", "配音模型未傳回這一段台詞的單一聲軌")
        model = doc["models"][0]
        capture_text = ctx.settings.get("recording", {}).get("capture_prompt", True)
        options = {
            "language": language,
            "speaker": speaker,
            "instruct": instruct if capture_text else None,
            "instruct_sha256": hashlib.sha256(instruct.encode()).hexdigest(),
            "seed": seed,
            "sampling": dict(engine.model.generate_config),
        }
        provenance = {
            "schema_version": "1.0",
            "operation": "text_to_speech",
            "provider_id": self.provider_id,
            "model_id": model["id"],
            "model_revision": model["revision"],
            "variant": model["variants"][0],
            "runtime_version": _ENGINE_VERSION,
            "text": text if capture_text else None,
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "effective_settings": options,
            "voice_id": f"{model['id']}@{model['revision']}#{speaker}",
        }
        with ctx.recorder.phase("publish-audio"):
            _write_track(ctx, waves[0], rate, provenance)
