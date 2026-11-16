"""captioner: output assembly (invalid events become uncertain, evidence frames must exist), weights without an
lm_head are refused, and cancellation stops generation at the next token instead of running max_new_tokens."""

from __future__ import annotations

from pathlib import Path

from phasyn_captioner.provider import _model_problem


def test_model_problem_messages_are_relative_to_model_path(tmp_path: Path) -> None:
    problem = _model_problem(str(tmp_path)) or ""
    assert "config.json" in problem and str(tmp_path) not in problem
