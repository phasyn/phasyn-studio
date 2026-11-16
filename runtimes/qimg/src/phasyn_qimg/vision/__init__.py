"""``qimg.vision``: Qwen3-VL image reverse prompting (caption/analyze/revise/compare/pairwise).

Prompt templates and model-side JSON schemas are fixed data files whose fingerprints each result's provenance
records (``prompts/``, ``schemas/``); outputs are strict JSON with at most one format repair inside the same invoke.
Heavy imports (torch, transformers, PIL) happen only inside load()/invoke(), so the package can be imported and
tested without GPU dependencies.
"""
