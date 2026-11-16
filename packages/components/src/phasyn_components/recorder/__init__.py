"""Recorder SDK。GPU hooks 在 ``phasyn_components.recorder.gpu``（需 torch，延遲匯入）。"""

from .core import DETAIL_MODES, LEVELS, Recorder, Span, environment_facts, merge_summaries
from .metrics import metric, not_applicable, unavailable
from .rmath import (
    config_diff,
    effective_gbps,
    paired_roundtrips,
    percentile,
    same_latent,
    transfer_totals,
    union_duration_ms,
)
from .sink import RecordingSink, list_segments, recording_dir

__all__ = [
    "DETAIL_MODES",
    "LEVELS",
    "Recorder",
    "RecordingSink",
    "Span",
    "config_diff",
    "effective_gbps",
    "environment_facts",
    "list_segments",
    "merge_summaries",
    "metric",
    "not_applicable",
    "paired_roundtrips",
    "percentile",
    "recording_dir",
    "same_latent",
    "transfer_totals",
    "unavailable",
    "union_duration_ms",
]
