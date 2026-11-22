"""Free-VRAM pre-check of the Wan VACE worker (PyTorch-free parts)."""

from __future__ import annotations

from typing import Any

import pytest
from phasyn_components.errors import ComponentError

from phasyn_wan_edit.vram import (
    GIB,
    check_free,
    floor_bytes,
    measure_free,
    residency_of,
)


def test_sequential_offload_has_no_default_floor() -> None:
    assert (
        floor_bytes("sequential_offload", {"residency": "sequential_offload"}) is None
    )
    record = check_free(1 * GIB, "sequential_offload", {}, when="載入")
    assert record["result"] == "not_checked"


def test_model_offload_refuses_below_its_floor_before_running() -> None:
    with pytest.raises(ComponentError) as caught:
        check_free(3 * GIB, "model_offload", {}, when="生成")
    assert caught.value.code == "GPU_MEMORY_INSUFFICIENT"
    assert "sequential_offload" in caught.value.message
    assert caught.value.details["result"] == "refused"


def test_enough_free_memory_passes_and_is_recorded() -> None:
    record = check_free(14 * GIB, "model_offload", {}, when="載入")
    assert record["result"] == "passed"
    assert record["required_free_bytes"] == 13 * GIB


def test_unknown_reading_never_refuses() -> None:
    assert check_free(None, "gpu", {}, when="載入")["result"] == "unknown"


def test_override_sets_or_turns_off_the_floor() -> None:
    options = {"residency": "sequential_offload", "min_free_vram_gib": 4}
    with pytest.raises(ComponentError):
        check_free(2 * GIB, "sequential_offload", options, when="生成")
    assert (
        check_free(2 * GIB, "model_offload", {"min_free_vram_gib": 0}, when="生成")[
            "result"
        ]
        == "not_checked"
    )


@pytest.mark.parametrize("value", [True, "4", -1, 2048])
def test_invalid_override_is_refused(value: Any) -> None:
    with pytest.raises(ComponentError):
        floor_bytes("model_offload", {"min_free_vram_gib": value})


def test_unknown_residency_is_refused_not_replaced() -> None:
    assert residency_of(None) == "model_offload"
    assert residency_of({"residency": "sequential_offload"}) == "sequential_offload"
    with pytest.raises(ComponentError):
        residency_of({"residency": "disk"})


class _Cuda:
    def __init__(self, free: int | None) -> None:
        self.free = free

    def empty_cache(self) -> None:
        return None

    def mem_get_info(self, _device: int) -> tuple[int, int]:
        if self.free is None:
            raise RuntimeError("no device")
        return self.free, 16 * GIB


class _Torch:
    def __init__(self, free: int | None) -> None:
        self.cuda = _Cuda(free)


def test_measure_free_reads_the_device_or_reports_unknown() -> None:
    assert measure_free(_Torch(5 * GIB)) == 5 * GIB
    assert measure_free(_Torch(None)) is None
