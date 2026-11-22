"""One H3 request's pinned SGLang Cache-DiT adapter. Nothing survives a successful unmount."""

from __future__ import annotations

import contextlib
import functools
import hashlib
import importlib.metadata
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from . import SGLANG_SOURCE_REVISION
from .denoise_cache_rules import reject


_MIN_CACHE_BLOCKS = 3
_SOURCE = {
    "cache_dit/caching/cache_adapters/cache_adapter.py": "1d9cf9a850f16a5ab2c4e916d72bea469de935aa37290fb7ec26ba8bb2e6b6db",
    "sglang/multimodal_gen/runtime/models/dits/minimax_h3.py": "4e59f81b606c63d6292cd744cd6e387a2033f782d0d9013262b14775df1c918b",
    "sglang/multimodal_gen/runtime/cache/cache_dit_integration.py": "5065504e12eb8b95b1967df9de433e5fe62b95b799d78f674c12dcdeedf58f61",
    "sglang/multimodal_gen/runtime/managers/memory_managers/layerwise_offload.py": "8b5bce011c5430a2a5b7da2c222168ca774539664b5039a59d5f0534ae8bbcac",
    "cache_dit/caching/cache_blocks/pattern_3_4_5.py": "b933a8d8648e5eaec94f7658885a6be22bab17453d01a8bd1107e7ed3f3afd2c",
}


@functools.cache
def _source_check() -> None:
    try:
        version = importlib.metadata.version("cache-dit")
    except importlib.metadata.PackageNotFoundError as exc:
        raise reject(
            "CACHE_DIT_VERSION",
            "Install the pinned inference runtime with cache-dit 1.5.1.",
        ) from exc
    if version != "1.5.1":
        raise reject("CACHE_DIT_VERSION", "The H3 adapter requires cache-dit 1.5.1.")
    for path, expected in _SOURCE.items():
        dist = importlib.metadata.distribution(path.split("/")[0])
        with Path(str(dist.locate_file(path))).open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise reject(
                    "CACHE_DIT_SOURCE_DRIFT", f"Unsupported source revision for {path}."
                )


@contextlib.contextmanager
def _adaln(model: Any, blocks: tuple[Any, ...]) -> Iterator[None]:
    """Restore the per-block parameter selection hidden by the adapter's single wrapper."""
    holder = getattr(model, "adaln_cache", None)
    if holder is None:
        yield
        return
    received = None
    original = holder.block_all

    def block_all(*args: Any, **kwargs: Any) -> Any:
        nonlocal received
        received = original(*args, **kwargs)
        if len(received) != len(blocks):
            raise reject(
                "CACHE_DIT_ADALN_LAYOUT",
                "AdaLN parameter count must match the original H3 block stack.",
            )
        return received

    def hook(index: int, _module: Any, args: Any, kwargs: Any) -> Any:
        if received is None or kwargs.get("adaln_params") is None:
            raise reject(
                "CACHE_DIT_ADALN_LAYOUT",
                "The H3 transformer did not supply per-block AdaLN parameters.",
            )
        return args, {**kwargs, "adaln_params": received[index]}

    with contextlib.ExitStack() as stack:
        if "block_all" in vars(holder):
            stack.callback(setattr, holder, "block_all", original)
        else:
            stack.callback(delattr, holder, "block_all")
        holder.block_all = block_all
        for i, block in enumerate(blocks):
            stack.callback(
                block.register_forward_pre_hook(
                    functools.partial(hook, i), with_kwargs=True
                ).remove
            )
        yield


def check_clean(model: Any) -> None:
    """Reject a transformer with a leftover adapter or an incomplete restoration."""
    if (
        getattr(model, "_phasyn_cache_dit_quarantined", False)
        or getattr(model, "_is_cached", False)
        or hasattr(model, "_sglang_cache_dit_adapter")
    ):
        raise reject(
            "CACHE_DIT_UNCLEAN",
            "A prior Cache-DiT adapter remains attached. Reload this component.",
        )


@contextlib.contextmanager
def active(
    model: Any, option: Mapping[str, Any], steps: int
) -> Iterator[dict[str, Any]]:
    """Bind Cache-DiT for this request, record the blocks it reused, then restore the stack."""
    _source_check()
    cache_dit = importlib.import_module("cache_dit")
    from sglang.multimodal_gen.runtime.cache.cache_dit_integration import (  # type: ignore[import-untyped]
        CacheDitConfig,
        disable_cache_on_transformer,
        enable_cache_on_transformer,
    )

    check_clean(model)
    blocks = tuple(model.blocks)
    if len(blocks) < _MIN_CACHE_BLOCKS or any(
        getattr(b, "preserve_input_for_cache_dit", False) for b in blocks
    ):
        raise reject(
            "CACHE_DIT_BLOCK_LAYOUT",
            "Expected at least three untouched native H3 blocks.",
        )
    config = CacheDitConfig(
        enabled=True,
        Fn_compute_blocks=1,
        Bn_compute_blocks=1,
        max_warmup_steps=option["warmup_steps"],
        residual_diff_threshold=option["threshold"],
        max_continuous_cached_steps=option["max_reuse_steps"],
        num_inference_steps=steps,
    )
    report = {
        **option,
        "first_compute_blocks": 1,
        "last_compute_blocks": 1,
        "steps": steps,
        "cache_dit_version": "1.5.1",
        "sglang_revision": SGLANG_SOURCE_REVISION,
        "source_sha256": dict(_SOURCE),
    }
    original_forward = model.forward
    with _adaln(model, blocks):
        try:
            model.set_cache_dit_input_preservation(True)
            enable_cache_on_transformer(
                model, config, model_name="H3 transformer", has_separate_cfg=False
            )
            if not getattr(model, "_is_cached", False) or not hasattr(
                model, "_sglang_cache_dit_adapter"
            ):
                raise reject(
                    "CACHE_DIT_NOT_BOUND",
                    "SGLang did not attach its native H3 block adapter.",
                )
            yield report
            stats = cache_dit.summary(model, logging=False)[0]
            cached = list(stats.cached_steps)
            if (
                stats.accumulated_executed_steps != steps
                or stats.accumulated_cached_steps != len(cached)
            ):
                raise reject(
                    "CACHE_DIT_ACCOUNTING",
                    "Cache-DiT step counts did not match the denoising schedule.",
                )
            report.update(
                cached_steps=cached,
                reused_steps=len(cached),
                full_steps=steps - len(cached),
                block_count=len(blocks),
            )
        finally:
            try:
                disable_cache_on_transformer(model)
                check_clean(model)
                _check_restored(model, original_forward, blocks)
                model.set_cache_dit_input_preservation(False)
            except BaseException:
                model._phasyn_cache_dit_quarantined = True
                raise


def _check_restored(model: Any, original_forward: Any, blocks: tuple[Any, ...]) -> None:
    if model.forward != original_forward or tuple(model.blocks) != blocks:
        raise reject(
            "CACHE_DIT_UNCLEAN",
            "Failed to restore the original H3 block stack.",
        )
