"""phasyn_qimg 的 torch-free 部分：參數／設定規則、describe()、entry points、prompt 模板與尺寸規則。

這些測試在控制面環境（沒有 torch／PIL）也會跑：provider 模組在 import 時不得載入重型函式庫。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from phasyn_components.errors import ComponentError

from phasyn_qimg import config


@pytest.mark.static
def test_import_is_torch_free() -> None:
    # 控制面沒有這些套件；有安裝的環境也不該因 import provider 模組而載入它們
    heavy = [
        name for name in ("torch", "diffusers", "transformers") if name in sys.modules
    ]
    if heavy:
        pytest.skip(f"此程序已有其他測試載入 {heavy}；只在乾淨程序中有意義")
    import phasyn_qimg.compose  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.
    import phasyn_qimg.conditioning  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.
    import phasyn_qimg.prepare  # noqa: PLC0415 - Load optional runtime dependencies only on the path that needs them.
    import phasyn_qimg.vae  # noqa: F401, PLC0415 - Load optional runtime dependencies only on the path that needs them.

    assert not [
        name
        for name in ("torch", "diffusers", "transformers", "PIL")
        if name in sys.modules
    ]


@pytest.mark.parametrize("base", ["/abs/path", "../outside", "a/../../b"])
def test_model_dir_must_stay_under_models_root(base: str) -> None:
    with pytest.raises(ComponentError) as err:
        config.model_dir({"model_path": "/models", "provider_options": {"base": base}})
    assert err.value.code == "UNSUPPORTED_SETTING"
    assert config.model_dir({"model_path": "/models"}) == Path("/models/qwen-image-2.1")
