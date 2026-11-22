"""Transfer measured face or body motion to a fixed character image with triangle warps."""

from __future__ import annotations

from importlib import import_module

import numpy as np
from numpy.typing import NDArray
from phasyn_components.errors import ComponentError


Frame = NDArray[np.uint8]
Points = NDArray[np.float32]
_MIN_AREA = 0.5
_MIN_VISIBILITY = 0.5
_TRIANGLE_LOOKUP_TOLERANCE = 0.1


def coordinates(rows: list[list[float]], size: tuple[int, int]) -> Points:
    """Convert normalized coordinates to image pixels."""
    return np.asarray(
        np.asarray(rows, np.float32)[:, :2] * np.asarray(size, np.float32),
        dtype=np.float32,
    )


def skeleton(
    frame: Frame, points: list[list[float]], edges: list[tuple[int, int]]
) -> Frame:
    """Draw only detected segments with sufficient visibility on a black canvas."""
    cv = import_module("cv2")
    out = np.zeros_like(frame)
    if not points:
        return out
    height, width = frame.shape[:2]
    pixels = coordinates(points, (width, height)).round().astype(np.int32)
    for start, end in edges:
        if any(points[i][3] < _MIN_VISIBILITY for i in (start, end)):
            continue
        cv.line(
            out,
            tuple(pixels[start]),
            tuple(pixels[end]),
            (255, 255, 255),
            max(1, width // 250),
            cv.LINE_AA,
        )
    return out


class CharacterMesh:
    """Anchor the reference background and transfer relative motion inside a bounded mesh."""

    def __init__(
        self,
        image: Frame,
        points: list[list[float]],
        edges: list[tuple[int, int]],
        *,
        body: bool,
    ) -> None:
        """Prepare the reference mesh from visible landmarks and fixed boundary anchors."""
        self.cv = import_module("cv2")
        self.image = image
        self.height, self.width = image.shape[:2]
        self.body = body
        indices = {index for edge in edges for index in edge}
        if not body:
            indices.update((1, 4, 6, 168, 195))
        self.indices = sorted(indices)
        self.source = self._points(points, (self.width, self.height))
        margin = np.maximum(np.ptp(self.source, axis=0) * 0.18, 3)
        left, top = np.maximum(np.min(self.source, axis=0) - margin, 0)
        right, bottom = np.minimum(
            np.max(self.source, axis=0) + margin, (self.width - 1, self.height - 1)
        )
        self.edges = np.array(
            [
                (left, top),
                (left, bottom),
                (right, top),
                (right, bottom),
                ((left + right) / 2, top),
                ((left + right) / 2, bottom),
                (left, (top + bottom) / 2),
                (right, (top + bottom) / 2),
            ],
            np.float32,
        )
        self.controls = np.vstack((self.source, self.edges))
        subdiv = self.cv.Subdiv2D((0, 0, self.width, self.height))
        for x, y in self.controls:
            subdiv.insert((float(x), float(y)))
        self.triangles = []
        for triangle in subdiv.getTriangleList().reshape(-1, 3, 2):
            distances = np.linalg.norm(
                triangle[:, None, :] - self.controls[None, :, :], axis=2
            )
            if np.max(np.min(distances, axis=1)) < _TRIANGLE_LOOKUP_TOLERANCE:
                self.triangles.append(np.argmin(distances, axis=1))
        self.neutral: Points | None = None

    def _points(self, rows: list[list[float]], size: tuple[int, int]) -> Points:
        if self.body and any(rows[i][3] < _MIN_VISIBILITY for i in self.indices):
            raise ComponentError(
                "UNSUPPORTED_COMBINATION",
                "The full body must be visible in the driving and reference frames.",
            )
        pixels = coordinates(rows, size)[self.indices]
        if (
            not np.all(np.isfinite(pixels))
            or np.any(pixels < 0)
            or np.any(pixels >= (size[0] - 1, size[1] - 1))
        ):
            raise ComponentError(
                "UNSUPPORTED_COMBINATION",
                "The complete subject contour must be in frame.",
            )
        return pixels

    def animate(
        self, rows: list[list[float]], driver: tuple[int, int], strength: float
    ) -> Frame:
        """Apply relative displacements from the driver's first frame to the source portrait."""
        current = self._points(rows, driver)
        if self.neutral is None:
            self.neutral = current.copy()
        if strength == 0:
            return self.image.copy()
        factor = np.ptp(self.source, axis=0) / np.maximum(
            np.ptp(self.neutral, axis=0), 1
        )
        target = np.clip(
            self.source + (current - self.neutral) * factor * strength,
            (0, 0),
            (self.width - 1, self.height - 1),
        )
        dst = np.asarray(np.vstack((target, self.edges)), np.float32)
        canvas = self.image.copy()
        for indices in self.triangles:
            self._triangle(canvas, self.controls[indices], dst[indices])
        return canvas

    def _triangle(self, canvas: Frame, src: Points, dst: Points) -> None:
        if abs(self.cv.contourArea(dst)) < _MIN_AREA:
            return
        x, y, width, height = self.cv.boundingRect(dst)
        local = np.ascontiguousarray(dst - np.array([x, y], np.float32))
        matrix = self.cv.getAffineTransform(src, local)
        warped = self.cv.warpAffine(
            self.image,
            matrix,
            (width, height),
            flags=self.cv.INTER_LINEAR,
            borderMode=self.cv.BORDER_REFLECT_101,
        )
        mask = np.zeros((height, width), np.uint8)
        self.cv.fillConvexPoly(mask, np.int32(np.round(local)), 1)
        np.copyto(
            canvas[y : y + height, x : x + width],
            warped,
            where=mask[:, :, None].astype(bool),
        )
