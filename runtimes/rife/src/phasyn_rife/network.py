# SPDX-License-Identifier: MIT
# Adapted from Practical-RIFE 4.26, train_log/IFNet_HDv3.py, copyright 2021 hzwer.
"""Inference-only IFNet for the Practical-RIFE 4.26 checkpoint.

Layer names are part of the checkpoint format. All five flow estimates act on
the same full-resolution pixel grid, from the coarsest scale to the finest.
"""

from __future__ import annotations

from typing import override

import torch
from torch import Tensor, nn
from torch.nn import functional


def _downsample(inputs: int, outputs: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(inputs, outputs, 3, stride=2, padding=1),
        nn.LeakyReLU(0.2),
    )


class _Features(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, stride=2, padding=1)
        self.cnn1 = nn.Conv2d(16, 16, 3, padding=1)
        self.cnn2 = nn.Conv2d(16, 16, 3, padding=1)
        self.cnn3 = nn.ConvTranspose2d(16, 4, 4, stride=2, padding=1)

    @override
    def forward(self, image: Tensor) -> Tensor:
        features = functional.leaky_relu(self.cnn0(image), 0.2)
        features = functional.leaky_relu(self.cnn1(features), 0.2)
        features = functional.leaky_relu(self.cnn2(features), 0.2)
        encoded: Tensor = self.cnn3(features)
        return encoded


class _Residual(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv = nn.Conv2d(channels, channels, 3, padding=1)
        self.beta = nn.Parameter(torch.ones(1, channels, 1, 1))

    @override
    def forward(self, features: Tensor) -> Tensor:
        return functional.leaky_relu(self.conv(features) * self.beta + features, 0.2)


class _FlowBlock(nn.Module):
    def __init__(self, inputs: int, channels: int) -> None:
        super().__init__()
        self.conv0 = nn.Sequential(
            _downsample(inputs, channels // 2), _downsample(channels // 2, channels)
        )
        self.convblock = nn.Sequential(*(_Residual(channels) for _ in range(8)))
        self.lastconv = nn.Sequential(
            nn.ConvTranspose2d(channels, 52, 4, stride=2, padding=1), nn.PixelShuffle(2)
        )

    @override
    def forward(
        self, features: Tensor, flow: Tensor | None, scale: float
    ) -> tuple[Tensor, Tensor, Tensor]:
        def reduce_size(tensor: Tensor) -> Tensor:
            return functional.interpolate(
                tensor, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
            )

        inputs = reduce_size(features)
        if flow is not None:
            inputs = torch.cat((inputs, reduce_size(flow) / scale), dim=1)
        prediction = self.lastconv(self.convblock(self.conv0(inputs)))
        result = functional.interpolate(
            prediction, scale_factor=scale, mode="bilinear", align_corners=False
        )
        return result[:, :4] * scale, result[:, 4:5], result[:, 5:]


def _sampling_grid(image: Tensor) -> Tensor:
    height, width = image.shape[-2:]
    y, x = torch.meshgrid(
        torch.linspace(-1.0, 1.0, height, device=image.device, dtype=image.dtype),
        torch.linspace(-1.0, 1.0, width, device=image.device, dtype=image.dtype),
        indexing="ij",
    )
    return torch.stack((x, y), dim=0).unsqueeze(0)


def _warp(features: Tensor, flow: Tensor, grid: Tensor) -> Tensor:
    height, width = features.shape[-2:]
    offsets = torch.cat(
        (flow[:, :1] / ((width - 1) / 2), flow[:, 1:2] / ((height - 1) / 2)),
        dim=1,
    )
    return functional.grid_sample(
        features,
        (grid + offsets).permute(0, 2, 3, 1),
        mode="bilinear",
        padding_mode="border",
        align_corners=True,
    )


class FlowNetwork(nn.Module):
    """Estimate bidirectional optical flow and blend the two warped RGB frames."""

    def __init__(self) -> None:
        """Build only the layers used during interpolation."""
        super().__init__()
        self.encode = _Features()
        self.block0 = _FlowBlock(15, 192)
        self.block1 = _FlowBlock(28, 128)
        self.block2 = _FlowBlock(28, 96)
        self.block3 = _FlowBlock(28, 64)
        self.block4 = _FlowBlock(28, 32)

    @override
    def forward(self, left: Tensor, right: Tensor, timestep: float) -> Tensor:
        """Interpolate normalized, padded NCHW frames at the given time."""
        left_features = self.encode(left)
        right_features = self.encode(right)
        time_plane = torch.full_like(left[:, :1], timestep)
        initial = torch.cat((left, right, left_features, right_features, time_plane), 1)
        flow, mask, features = self.block0(initial, None, 16.0)
        grid = _sampling_grid(left)
        left_rgb_features = torch.cat((left, left_features), 1)
        right_rgb_features = torch.cat((right, right_features), 1)
        for block, scale in (
            (self.block1, 8.0),
            (self.block2, 4.0),
            (self.block3, 2.0),
            (self.block4, 1.0),
        ):
            warped_left = _warp(left_rgb_features, flow[:, :2], grid)
            warped_right = _warp(right_rgb_features, flow[:, 2:4], grid)
            inputs = torch.cat(
                (
                    warped_left[:, :3],
                    warped_right[:, :3],
                    warped_left[:, 3:],
                    warped_right[:, 3:],
                    time_plane,
                    mask,
                    features,
                ),
                dim=1,
            )
            delta, mask, features = block(inputs, flow, scale)
            flow = flow + delta
        weight = torch.sigmoid(mask)
        return _warp(left, flow[:, :2], grid) * weight + _warp(
            right, flow[:, 2:4], grid
        ) * (1 - weight)
