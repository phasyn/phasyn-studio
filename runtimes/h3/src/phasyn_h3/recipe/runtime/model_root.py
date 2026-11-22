"""The model root of this component process (``PHASYN_MODEL_ROOT``, set from ``load.model_path``); torch-free.

Weights are never downloaded: a missing root or file fails fast, and messages name files relative to the
model root (never the user's absolute layout).
"""

from __future__ import annotations

import os
from pathlib import Path

from .errors import ModelFilesMissing


MODEL_ROOT_ENV = "PHASYN_MODEL_ROOT"


def model_root() -> Path:
    """Resolve the selected model snapshot directory."""
    raw = os.environ.get(MODEL_ROOT_ENV)
    if not raw:
        raise ModelFilesMissing(
            "MODEL_ROOT_UNSET", f"未設定 {MODEL_ROOT_ENV}；runtime 不會自動下載權重"
        )
    root = Path(raw)
    if not root.is_dir():
        raise ModelFilesMissing(
            "MODEL_ROOT_MISSING", f"{MODEL_ROOT_ENV}（load.model_path）不存在或不是目錄"
        )
    return root.resolve()


__all__ = ["MODEL_ROOT_ENV", "model_root"]
