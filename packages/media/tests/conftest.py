"""Media test options: ``slow`` tests run real FFmpeg exports end to end; select them with ``pytest -m slow``."""

from __future__ import annotations

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "slow: real FFmpeg exports of synthetic timelines (seconds each); run with -m slow"
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Leave the slow tests out of a run whose marker expression does not name them."""
    if "slow" in (config.option.markexpr or ""):
        return
    skip = pytest.mark.skip(reason="slow: run with -m slow")
    for item in items:
        if item.get_closest_marker("slow") is not None:
            item.add_marker(skip)
