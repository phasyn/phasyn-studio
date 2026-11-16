"""provider_id -> provider class: the built-in table plus ``phasyn.providers`` entry points.

Runtime packages extend the SDK by declaring entry points in the ``phasyn.providers`` group; the
controller never needs to change. An entry point wins over a built-in provider with the same id.
Targets are ``"module:Class"`` strings imported only when a component process loads the provider,
so the CPU media providers can live in ``phasyn_media`` without this package depending on it.
The ``test.*`` providers from :mod:`phasyn_components.testing` resolve only when the component
process runs with ``PHASYN_ENABLE_TEST_PROVIDERS=1``.
"""

from __future__ import annotations

import importlib
from functools import lru_cache
from typing import Any

from . import testing
from .errors import ComponentError, exception_message

ENTRY_POINT_GROUP = "phasyn.providers"

BUILTIN: dict[str, str] = {
    "caption.compile": "phasyn_components.providers.caption:CaptionCompileProvider",
    "dataset.export": "phasyn_components.providers.dataset:DatasetExportProvider",
    "media.mux": "phasyn_media.providers.mux:MuxProvider",
    "media.probe": "phasyn_media.providers.mux:ProbeProvider",
    "media.concat": "phasyn_media.providers.concat:ConcatProvider",
    "media.frame": "phasyn_media.providers.frame:FrameProvider",
}


@lru_cache(maxsize=1)
def _entry_points() -> dict[str, str]:
    from importlib.metadata import entry_points

    return {ep.name: ep.value for ep in entry_points(group=ENTRY_POINT_GROUP)}


def _table() -> dict[str, str]:
    table = dict(BUILTIN)
    if testing.enabled():
        table.update(testing.PROVIDERS)
    table.update(_entry_points())
    return table


def provider_target(provider_id: str) -> str:
    target = _table().get(provider_id)
    if target is not None:
        return target
    if provider_id in testing.PROVIDERS:
        raise ComponentError(
            "PROVIDER_NOT_INSTALLED",
            f"測試用 provider {provider_id} 未啟用（元件程序需設定環境變數 {testing.ENABLE_ENV}=1）",
            details={"provider_id": provider_id, "enable_env": testing.ENABLE_ENV},
            status=422,
        )
    raise ComponentError(
        "PROVIDER_NOT_INSTALLED",
        f"此 runtime 沒有安裝 provider {provider_id}（缺少對應套件）",
        details={"provider_id": provider_id},
        status=422,
    )


def load_provider_class(provider_id: str) -> Any:
    target = provider_target(provider_id)
    module_name, _, attr = target.partition(":")
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise ComponentError(
            "PROVIDER_NOT_INSTALLED",
            f"provider {provider_id} 的模組 {module_name} 無法匯入：{exception_message(exc)}",
            details={"provider_id": provider_id, "module": module_name},
            status=422,
        ) from exc
    cls = getattr(module, attr, None)
    if cls is None:
        raise ComponentError("PROVIDER_NOT_INSTALLED", f"{target} 不存在", status=422)
    return cls


def known_providers() -> list[str]:
    return sorted(_table())


__all__ = [
    "BUILTIN",
    "ENTRY_POINT_GROUP",
    "known_providers",
    "load_provider_class",
    "provider_target",
]
