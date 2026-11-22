"""qimg.vision 測試共用：假的 engine（不載入任何權重）、替換 GPU／PIL hook 的 provider、直接呼叫用的 context。

假 engine 依序回傳指定的原始輸出，記錄每次 prepare 收到的 messages，token 數由 messages 長度決定（可調整），
讓修復、context 預算與容量預檢的路徑都能在 CPU 上測試。圖片載入以尺寸假物件代替（PIL 的正規化另有測試）。
裝置記憶體只替換「量測」（mem_get_info、is_integrated、/proc/meminfo 文字）；決定可用量的 ``phasyn_qimg.memory.resolve``
與容量判斷是真的。
"""

from __future__ import annotations

import copy
import json
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, override

from phasyn_components.files import FileStore
from phasyn_components.provider import InputValue, LoadContext, ProviderHost, RunContext
from phasyn_components.recorder import Recorder
from phasyn_components.settings import normalize_recording
from phasyn_components.testing.ids import NODE_A_ID

from phasyn_qimg import memory
from phasyn_qimg.vision.describe import OPTIONS
from phasyn_qimg.vision.engine import Generation, Prepared
from phasyn_qimg.vision.images import ViewImage, crop_box
from phasyn_qimg.vision.provider import QwenVisionProvider


FIXTURES = Path(__file__).resolve().parent / "fixtures"
NODE = NODE_A_ID
SECTION_KEYS = (
    "subject",
    "action",
    "composition",
    "environment",
    "lighting",
    "appearance",
    "style",
    "visible_text",
)
QWEN_4B_TEXT = {
    "num_hidden_layers": 36,
    "num_key_value_heads": 8,
    "num_attention_heads": 32,
    "head_dim": 128,
    "hidden_size": 2560,
}
OUTPUTS = {
    "result": "prompt.vision.result.v1",
    "caption": "text.prompt.v1",
    "scene": "prompt.scene.v1",
    "comparison": "prompt.comparison.v1",
    "pairwise": "prompt.pairwise.v1",
}
SIZES = {
    "image": (640, 480),
    "generated": (512, 512),
    "candidate_a": (512, 512),
    "candidate_b": (512, 512),
}
GIB = 1024**3
KIB = 1024


def meminfo_text(
    *, available: int, free: int, total: int = 125 * GIB, swap_free: int = 0
) -> str:
    """/proc/meminfo 格式的文字（kB）。"""
    return (
        f"MemTotal:       {total // KIB} kB\nMemFree:        {free // KIB} kB\n"
        f"MemAvailable:   {available // KIB} kB\nBuffers:          1024 kB\nSwapFree:       {swap_free // KIB} kB\n"
    )


# 預設主機：MemAvailable 64 GiB、MemFree 7 GiB（大量可回收 page cache，整合記憶體 GPU 的情況）
MEMINFO_64G = meminfo_text(available=64 * GIB, free=7 * GIB)


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def conversions() -> dict[str, Any]:
    return dict(fixture("golden_conversions.json"))


def zh_scene() -> dict[str, Any]:
    """DiT 對照資料中的 zh-TW 場景（subject 鎖定且為有意修改、visible_text 鎖定）。"""
    data = fixture("golden_messages.json")
    for value in data["shared"].values():
        if value.get("prompt_language") == "zh-TW":
            return copy.deepcopy(value)
    raise AssertionError("fixture 缺少 zh-TW 場景")


class FakeImage:
    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height


class FakeEngine:
    def __init__(
        self,
        outputs: Sequence[str | dict[str, Any]],
        *,
        tokens: Callable[[list[dict[str, Any]]], int] | None = None,
        stop_after_first_token: bool = False,
        on_generate: Callable[[], None] | None = None,
    ) -> None:
        self.outputs = list(outputs)
        self.prepared: list[list[dict[str, Any]]] = []
        self.generated = 0
        self.max_new_tokens: list[int] = []
        self.tokens = tokens or (lambda _messages: 120)
        self.stop_after_first_token = stop_after_first_token
        self.on_generate = on_generate
        self.closed = False

    def prepare(
        self, messages: list[dict[str, Any]], images: Sequence[Any]
    ) -> Prepared:
        self.prepared.append(messages)
        dims = [
            (image.width - image.width % 32, image.height - image.height % 32)
            for image in images
        ]
        return Prepared(
            inputs={"messages": messages},
            input_tokens=int(self.tokens(messages)),
            effective_pixels=dims,
        )

    def generate(
        self,
        prepared: Prepared,
        *,
        max_new_tokens: int,
        should_stop: Callable[[], bool],
    ) -> Generation:
        del prepared
        self.generated += 1
        self.max_new_tokens.append(max_new_tokens)
        if self.on_generate is not None:
            self.on_generate()
        if self.stop_after_first_token:
            assert should_stop(), "測試預期此時已要求取消"
        item = self.outputs.pop(0)
        if isinstance(item, str):
            item = {"raw": item}
        return Generation(
            raw=str(item["raw"]),
            output_tokens=int(item.get("output_tokens", 50)),
            finish_reason=str(item.get("finish_reason", "stop")),
            elapsed_ms=12.5,
            first_token_ms=item.get("first_token_ms", 3.0),
        )

    def close(self) -> None:
        self.closed = True


class NullAllocator:
    def start(self) -> None:
        return None

    def finish(self, rec: Any, *, scope: str) -> None:
        del rec, scope


class FakeVisionProvider(QwenVisionProvider):
    """GPU、PIL、torch 相關 hook 全部替換；其餘（驗證、修復、預算、容量判斷、輸出）是真的。"""

    engine_factory: Callable[[], FakeEngine] = staticmethod(lambda: FakeEngine([]))
    device_free: int | None = 11 * GIB
    device_total: int | None = 12 * GIB
    integrated: bool | None = (
        False  # torch.cuda.get_device_properties(0).is_integrated；None=讀不到
    )
    meminfo: str | None = MEMINFO_64G  # None=/proc/meminfo 讀不到

    @override
    def _create_engine(self, model_path: str, options: Any) -> Any:
        return self.engine_factory()

    @override
    def _require_cuda(self) -> None:
        return None

    @override
    def _device_memory(self, options: Any) -> memory.DeviceMemory:
        cuda = memory.CudaMemory(
            free_bytes=self.device_free,
            total_bytes=self.device_total if self.device_free is not None else None,
            reason=None
            if self.device_free is not None
            else "RuntimeError: 假裝置量測失敗",
            is_integrated=self.integrated,
            integrated_reason=None
            if self.integrated is not None
            else "RuntimeError: 假裝置讀不到 properties",
        )
        host = (
            memory.parse_meminfo(self.meminfo)
            if self.meminfo is not None
            else memory.HostMemory(
                reason="無法讀取 /proc/meminfo：PermissionError: 假的"
            )
        )
        return memory.resolve(
            cuda,
            host,
            memory_model=str(options["memory_model"]),
            unified_reserve_bytes=int(options["unified_reserve_bytes"]),
        )

    @override
    def _allocator(self) -> Any:
        return NullAllocator()

    @override
    def _runtime_identity(self) -> dict[str, Any]:
        return {"kind": "fake"}

    @override
    def _backend_flags(self) -> dict[str, Any]:
        return {}

    @override
    def _load_image(self, path: Path, port: str) -> ViewImage:
        width, height = SIZES[port]
        return ViewImage(
            FakeImage(width, height),
            width,
            height,
            "PNG",
            had_alpha=False,
            had_icc_profile=False,
        )

    @override
    def _crop_image(self, view: ViewImage, crop: Any) -> ViewImage:
        x0, y0, x1, y1 = crop_box(crop, view.width, view.height)
        return ViewImage(
            FakeImage(x1 - x0, y1 - y0),
            x1 - x0,
            y1 - y0,
            "PNG",
            had_alpha=False,
            had_icc_profile=False,
        )


def model_dir(root: Path, *, weights: int = 4096) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "config.json").write_text(
        json.dumps(
            {
                "architectures": ["Qwen3VLForConditionalGeneration"],
                "text_config": QWEN_4B_TEXT,
            }
        ),
        encoding="utf-8",
    )
    (root / "preprocessor_config.json").write_text("{}", encoding="utf-8")
    (root / "tokenizer.json").write_text("{}", encoding="utf-8")
    (root / "model.safetensors").write_bytes(b"\0" * weights)
    return root


class Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp = tmp_path
        self.store = FileStore(tmp_path / "data", NODE)
        self.host = ProviderHost(
            node_id=NODE,
            component_id="vision",
            data_dir=tmp_path,
            work_dir=tmp_path,
            device={},
            process_instance_id="t",
        )
        self.model = model_dir(tmp_path / "model")

    def recorder(self, operation: str) -> Recorder:
        return Recorder(
            recordings_root=self.tmp / "recordings",
            recording_id=str(uuid.uuid4()),
            stream_id="runtime",
            node_id=NODE,
            component_id="vision",
            provider_id="qimg.vision",
            process_instance_id=str(uuid.uuid4()),
            operation=operation,
        )

    def settings(self, **options: Any) -> dict[str, Any]:
        return {
            "load": {
                "model_path": str(self.model),
                "device": {
                    "kind": "cuda",
                    "id": "GPU-TEST",
                    "resource_group": "gpu-test",
                },
                "precision": {
                    "compute_dtype": "bf16",
                    "quantization": {"scheme": "none"},
                },
                "offload": {"mode": "none"},
                "part_overrides": [],
                "provider_options": options,
            },
            "invoke": {},
            "recording": normalize_recording({"mode": "detailed"}),
        }

    def provider(
        self,
        engine: FakeEngine,
        *,
        free: int | None = 11 * GIB,
        integrated: bool | None = False,
        meminfo: str | None = MEMINFO_64G,
        **options: Any,
    ) -> FakeVisionProvider:
        provider = self.unloaded(
            engine, free=free, integrated=integrated, meminfo=meminfo
        )
        provider.load(self.load_context(**options))
        return provider

    def unloaded(
        self,
        engine: FakeEngine,
        *,
        free: int | None = 11 * GIB,
        integrated: bool | None = False,
        meminfo: str | None = MEMINFO_64G,
    ) -> FakeVisionProvider:
        """尚未 load 的假 provider（量測值：mem_get_info free、is_integrated、/proc/meminfo 文字）。"""

        class Provider(FakeVisionProvider):
            engine_factory = staticmethod(lambda: engine)
            device_free = free

        Provider.integrated = integrated
        Provider.meminfo = meminfo
        return Provider(self.host)

    def load_context(self, **options: Any) -> LoadContext:
        return LoadContext(
            expanded_parts={},
            recorder=self.recorder("load"),
            device={"kind": "cuda"},
            work_dir=self.tmp / "work",
            settings=self.settings(**options),
        )

    def image(self, port: str) -> InputValue:
        writer = self.store.new_writer("image/png", {})
        writer.write(f"fake {port}".encode())
        ref = writer.commit()
        return InputValue(
            type_id="media.image.v1",
            file=ref,
            path=self.store.payload_path(ref["file_id"]),
        )

    def context(
        self,
        inputs: dict[str, InputValue],
        parameters: dict[str, Any],
        *,
        cancel: threading.Event | None = None,
    ) -> RunContext:
        return RunContext(
            call_id=str(uuid.uuid4()),
            run_id=str(uuid.uuid4()),
            step_id="vision",
            parameters=parameters,
            inputs=inputs,
            store=self.store,
            deadline_ns=time.monotonic_ns() + 60 * 10**9,
            cancel_event=cancel if cancel is not None else threading.Event(),
            output_types=OUTPUTS,
            recorder=self.recorder("invoke"),
            device={"kind": "cuda"},
            work_dir=self.tmp / "work",
            settings={},
        )


def inline(type_id: str, value: Any) -> InputValue:
    return InputValue(type_id=type_id, value=value)


def compact_scene_output(
    language: str = "zh-TW", *, subject: dict[str, str] | None = None
) -> dict[str, Any]:
    """模型 compact 輸出（inline-scene/1）：subject+composition 有 observed 證據，style 只有 uncertain."""
    sections: dict[str, dict[str, Any]] = {
        key: {
            "text_en": "",
            "text_zh_tw": "",
            "explanation_zh_tw": "",
            "observations": [],
        }
        for key in SECTION_KEYS
    }
    sections["subject"] = {
        "text_en": "A red teapot.",
        "text_zh_tw": "一個紅色茶壺。" if language == "zh-TW" else "",
        "explanation_zh_tw": "可見茶壺",
        "observations": [
            {
                "view_id": "v-full",
                "claim_en": "A red teapot is visible.",
                "certainty": "observed",
            }
        ],
        **(subject or {}),
    }
    sections["composition"] = {
        "text_en": "The teapot is centered.",
        "text_zh_tw": "茶壺置中。" if language == "zh-TW" else "",
        "explanation_zh_tw": "位置",
        "observations": [
            {
                "view_id": "v-full",
                "claim_en": "The teapot is in the middle.",
                "certainty": "observed",
            }
        ],
    }
    return {"sections": sections, "uncertainty_notes": []}


def flat_comparison(label: str = "minor") -> dict[str, Any]:
    return {
        "metrics": [
            {
                "section": key,
                "label": label if key == "subject" else "match",
                "evidence_zh_tw": f"{key} 說明",
            }
            for key in SECTION_KEYS
        ],
        "unexpected_elements": [],
        "differences": [
            {
                "section": "subject",
                "description_zh_tw": "顏色不同",
                "suggested_change_en": "Make it red.",
            }
        ],
        "text_transcription": "",
        "unjudgeable_reason": None,
    }


__all__ = [
    "GIB",
    "MEMINFO_64G",
    "OPTIONS",
    "SECTION_KEYS",
    "FakeEngine",
    "FakeVisionProvider",
    "Harness",
    "compact_scene_output",
    "conversions",
    "fixture",
    "flat_comparison",
    "inline",
    "meminfo_text",
    "model_dir",
    "zh_scene",
]
