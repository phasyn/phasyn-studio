"""qimg.dit 設定／參數：variant×placement 的明確組合、422 規則、schema（Node PATCH 時的 allOf）與檔案／ABI 檢查。torch-free。"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from phasyn_components.errors import ComponentError

from phasyn_qimg.dit import options as o


def load(**overrides: object) -> dict[str, Any]:
    doc: dict[str, Any] = copy.deepcopy(o.default_settings("bf16", "phase")["load"])
    doc["model_path"] = "/models"
    for key, value in overrides.items():
        section, _, field = key.partition("__")
        if field:
            doc[section][field] = value
        else:
            doc[section] = value
    return doc


@pytest.mark.parametrize(
    ("mutate", "fragment"),
    [
        (lambda d: d["offload"].update(mode="gguf_phase"), "placement"),
        (
            lambda d: d["provider_options"].update(
                variant="gguf_q4km", gguf_file="g.gguf"
            ),
            "placement",
        ),
        (lambda d: d["offload"].update(pin_memory="static"), "pin_memory"),
        (lambda d: d["offload"].update(mode="group_stream"), "pin_memory"),
        (lambda d: d["precision"].update(compute_dtype="fp16"), "bf16"),
        (lambda d: d["provider_options"].update(base="/abs/path"), "絕對"),
        (lambda d: d["provider_options"].update(transformer_override="../x"), ".."),
        (lambda d: d["provider_options"].update(gguf_file="x.gguf"), "gguf_file"),
        (
            lambda d: d["provider_options"].update(
                adapters=[{"name": "a", "path": "a.bin", "scale": 1}]
            ),
            "safetensors",
        ),
        (
            lambda d: d["provider_options"].update(
                adapters=[
                    {"name": "a", "path": "a.safetensors", "scale": 1},
                    {"name": "a", "path": "b.safetensors", "scale": 1},
                ]
            ),
            "重複",
        ),
        (
            lambda d: d["provider_options"].update(
                adapters=[{"name": "a", "path": "a.safetensors", "scale": 9}]
            ),
            "\N{MINUS SIGN}5..5",
        ),
    ],
)
def test_invalid_combinations_are_422(
    mutate: Callable[[dict[str, Any]], None], fragment: str
) -> None:
    doc = load()
    mutate(doc)
    with pytest.raises(ComponentError) as err:
        o.parse_options(doc)
    assert err.value.status == 422 and fragment in err.value.message


def _tree(
    root: Path, *, context: int = 24, z_dim: int = 64, cls: str = o.TRANSFORMER_CLASS
) -> Path:
    base = root / "qwen-image-2.1"
    for sub in ("transformer", "text_encoder", "vae", "scheduler"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    (base / "transformer" / "config.json").write_text(
        json.dumps(
            {
                "_class_name": cls,
                "context_in_dim": 24,
                "in_channels": 64,
                "num_layers": 3,
            }
        )
    )
    (base / "transformer" / "diffusion_pytorch_model.safetensors").write_bytes(b"x")
    (base / "text_encoder" / "config.json").write_text(
        json.dumps({"text_config": {"hidden_size": context}})
    )
    (base / "vae" / "config.json").write_text(json.dumps({"z_dim": z_dim}))
    (base / "scheduler" / "scheduler_config.json").write_text("{}")
    return base


def test_gguf_kernel_env_is_refused(tmp_path: Path) -> None:
    _tree(tmp_path)
    (tmp_path / "g").mkdir()
    (tmp_path / "g" / "m.gguf").write_bytes(b"GGUF")
    doc: dict[str, Any] = copy.deepcopy(o.default_settings("gguf_q4km")["load"])
    doc.update(model_path=str(tmp_path))
    doc["provider_options"]["gguf_file"] = "g/m.gguf"
    opts = o.parse_options(doc)
    assert o.configuration_problem(opts, environ={}) is None
    code, reason = o.configuration_problem(opts, environ={o.GGUF_KERNEL_ENV: "1"}) or (
        "",
        "",
    )
    assert code == "UNSUPPORTED_SETTING" and o.GGUF_KERNEL_ENV in reason
