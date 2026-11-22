"""MiniMax H3 model rules: tasks and materials, geometry, sigma schedules, profile and LoRA rules, model manifests.

Pure Python + numpy; never imports torch (directly or transitively).  Upstream facts are pinned to
SGLang de487f80 / MiniMax-H3 d21241f0; see ``constants.py`` for the citation scheme.
"""

from __future__ import annotations

from .adapter import H3Adapter
from .constants import MODEL_DEFAULTS
from .manifests import local_manifest


__all__ = ["MODEL_DEFAULTS", "H3Adapter", "local_manifest"]
