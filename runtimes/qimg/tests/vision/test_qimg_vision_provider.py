"""qimg.vision provider（假 engine，不載入權重）：每個 op 的輸出、同一 invoke 內最多一次修復、不修復的情況、
context 預算（修復時只省略前次輸出）、容量預檢 enforce／report（獨立 GPU 與統一記憶體）、op 輸入規則、取消與載入檢查。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from phasyn_components import contracts
from phasyn_components.provider import RunContext
from qimg_vision_support import (
    FakeEngine,
    Harness,
)


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def run(
    h: Harness,
    engine: FakeEngine,
    inputs: dict[str, Any],
    params: dict[str, Any],
    **options: Any,
) -> RunContext:
    provider = h.provider(engine, **options)
    ctx = h.context(inputs, params)
    provider.invoke(ctx)
    return ctx


def test_caption_outputs_text_result_provenance_and_metrics(tmp_path: Path) -> None:
    h = Harness(tmp_path)
    engine = FakeEngine(["  一個紅色茶壺放在木桌上。  "])
    ctx = run(
        h, engine, {"image": h.image("image")}, {"op": "caption", "language": "zh-TW"}
    )
    assert ctx.outputs["caption"] == {
        "type_id": "text.prompt.v1",
        "value": "一個紅色茶壺放在木桌上。",
    }
    result = ctx.outputs["result"]["value"]
    contracts.validate("PromptVisionResult", result)
    assert set(ctx.outputs) == {"result", "caption"}
    assert result["output_format"] == "plain-caption/1" and len(result["attempts"]) == 1
    file = h.image("image").file
    assert file is not None
    assert result["views"][0] == {
        "view_id": "v-full", "port": "image", "sha256": file["sha256"], "crop": None,
        "width": 640, "height": 480, "effective_width": 640, "effective_height": 480, "source_format": "PNG",
        "had_alpha": False, "had_icc_profile": False,
    }  # fmt: skip
    provenance = result["provenance"]
    assert (
        list(provenance["templates"]) == ["qwen_caption"]
        and provenance["repair_input_policy"] is None
    )
    assert provenance["dtype"] == "bf16" and provenance["do_sample"] is False
    assert (
        provenance["model"]["name"] == "model"
        and provenance["template_source"] == "phasyn_qimg/vision/prompts"
    )
    assert str(tmp_path) not in json.dumps(
        result
    )  # Studio stores the provenance: no absolute model path
    assert (
        result["capacity"]["stage"] == "invoke" and result["capacity"]["fits"] is True
    )
    assert engine.max_new_tokens == [768]  # caption 用 caption_max_new_tokens
    system = engine.prepared[0][0]["content"]
    assert system.endswith("Write the caption entirely in Traditional Chinese (zh-TW).")
    metrics = ctx.recorder.finalize("succeeded")["metrics"]
    assert (
        metrics["input_tokens"]["value"] == 120
        and metrics["output_tokens"]["value"] == 50
    )
    assert (
        metrics["caption_ttft_ms"]["value"] == 3.0
        and metrics["qimg.vision.attempts"]["value"] == 1
    )
