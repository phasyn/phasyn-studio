"""Deterministic part of image reverse prompting (Inference Studio): eight-section scene semantics, prompt compilation and per-section scoring.

No torch/PIL imports. Shapes are validated by the contracts (PromptScene, …); this package only adds the
semantic rules JSON Schema cannot express.
"""
