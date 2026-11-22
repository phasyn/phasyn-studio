"""The opt-in Ref2VA reference-image short edge: which values a route may request and the canvas each one resolves to.
Pure geometry; nothing is loaded."""

from __future__ import annotations

import pytest
from phasyn_components.errors import ComponentError

from phasyn_h3 import refimage
from phasyn_h3.config import INVOKE_PROPS
from phasyn_h3.recipe.adapter import constants
from phasyn_h3.recipe.adapter.geometry import (
    EXPERIMENTAL_IMAGE_SHORT_EDGES,
    reference_image_short_edge,
    resolve_reference_image_shape,
)


@pytest.mark.parametrize("edge", [736, 768, 1024])
def test_opt_in_edges_are_kept(edge: int) -> None:
    assert reference_image_short_edge(edge) == edge
    assert refimage.requested({refimage.PARAM: edge}) == edge


@pytest.mark.parametrize("value", [None, 2048])
def test_pinned_path(value: int | None) -> None:
    assert reference_image_short_edge(value) is None


@pytest.mark.parametrize("value", [512, 720, 1536, 4096, True, "736"])
def test_other_values_are_refused(value: object) -> None:
    with pytest.raises(ValueError, match="736, 768, 1024, 2048 or null"):
        reference_image_short_edge(value)
    with pytest.raises(ComponentError) as caught:
        refimage.requested({refimage.PARAM: value})
    assert caught.value.code == "INVALID_ARGUMENT"


def test_every_opt_in_edge_is_on_the_token_grid() -> None:
    for edge in EXPERIMENTAL_IMAGE_SHORT_EDGES:
        assert edge % constants.REFERENCE_IMAGE_MULTIPLE == 0
        assert edge % constants.TOKEN_STRIDE == 0


@pytest.mark.parametrize(
    ("size", "edge", "expected"),
    [
        ((1280, 736), 736, {"width": 1280, "height": 736}),
        ((640, 368), 736, {"width": 1280, "height": 736}),
        ((1080, 1920), 768, {"width": 768, "height": 1376}),
        ((1280, 736), None, {"width": 3552, "height": 2048}),
    ],
)
def test_canvas(
    size: tuple[int, int], edge: int | None, expected: dict[str, int]
) -> None:
    assert resolve_reference_image_shape(*size, short_edge=edge) == expected


def test_te_parameters_schema_offers_the_opt_in_edges() -> None:
    schema = INVOKE_PROPS["conditioning"][refimage.PARAM]
    assert schema["enum"] == [None, 736, 768, 1024, 2048]
    assert schema["default"] == 2048


def test_opt_in_needs_a_ref2va_reference_image() -> None:
    job = {"task": "fl2va", "materials": [], refimage.PARAM: 736}
    with pytest.raises(ComponentError, match="requires Ref2VA reference_image"):
        refimage.of_job(job)
    job = {
        "task": "ref2va",
        "materials": [{"role": "reference_image"}],
        refimage.PARAM: 736,
    }
    assert refimage.of_job(job) == 736
