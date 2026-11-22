"""First-forward dispatcher observations for an explicitly requested eager DiT invocation."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator, Mapping
from typing import Any


# Record concrete dispatcher events only. The generic scaled_dot_product_attention
# entry does not identify the implementation selected by torch.
_OPERATORS = frozenset(
    {
        "aten::_scaled_dot_product_flash_attention",
        "aten::_scaled_dot_product_flash_attention_for_cpu",
        "aten::_scaled_dot_product_efficient_attention",
        "aten::_scaled_dot_product_cudnn_attention",
        "aten::_scaled_dot_product_attention_math",
        "aten::_scaled_dot_product_attention_math_for_mps",
        "aten::_scaled_dot_product_fused_attention_overrideable",
    }
)


@contextlib.contextmanager
def observe(inputs: Mapping[str, Any], report: dict[str, Any]) -> Iterator[None]:
    """Record the native operators dispatched by the first real attention forward."""
    import torch
    from torch.profiler import ProfilerActivity, profile

    # Describe the H3 inputs, never capture their contents or imply they are Q/K/V.
    report["model_inputs"] = {
        name: {"shape": list(v.shape), "dtype": str(v.dtype), "device": str(v.device)}
        for name in ("x", "audio_x", "prompt_embeds", "update_mask")
        if isinstance((v := inputs.get(name)), torch.Tensor)
    }
    report.update(
        scope="first_dit_forward",
        mechanism="torch_cpu_dispatch_events",
        torch_version=str(torch.__version__),
    )
    if torch.autograd._profiler_enabled():  # type: ignore[attr-defined]  # pinned Torch profiler state
        report.update(status="unknown", reason="profiler_already_active", operators={})
        yield
        return

    # Recording shapes on every ATen op could retain temporary tensors on streamed GPUs.
    with profile(
        activities=[ProfilerActivity.CPU], record_shapes=False, with_stack=False
    ) as recording:
        yield
    operators = {
        event.key: int(event.count)
        for event in recording.key_averages()
        if event.key in _OPERATORS
    }
    report.update(status="observed" if operators else "unknown", operators=operators)
    if not operators:
        report["reason"] = "no_recognized_sdpa_dispatch"
