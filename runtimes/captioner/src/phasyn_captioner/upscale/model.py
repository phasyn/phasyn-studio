"""The parsed Anime4K chain as PyTorch convolutions, run frame by frame in bounded tiles.

torch is imported inside the functions only (``describe`` and the control plane never import it). ``forward`` follows
the shader exactly: MAIN is RGB plus alpha 1, every conv reads CReLU views of earlier textures with replicate
padding, and the 2× output is the pixel-shuffled R/G/B residual plus MAIN upsampled bilinearly (half-pixel centres,
edge clamp). ``upscale_frame`` splits a frame into tiles of at most ``tile_pixels`` input pixels, reads each with
``spec.halo`` extra pixels and keeps only the interior, so the tiled result is the whole-frame result.

With a ``MethodSpec`` that has a restore chain and a clamp (Soft_VL), ``forward`` first records the clamp statistics of
the input, runs the 1× restore chain (its last stage adds MAIN), feeds the restored MAIN to the 2× chain and clamps
the output's luma at the end; the tile halo is the method's. Without them the original path runs unchanged.
"""

from __future__ import annotations

from typing import Any

from .plan import tile_grid
from .shader import MAIN, ChainSpec, MethodSpec


class Anime4KModel:
    """Weights resident on one device in one dtype; ``forward`` takes and returns ``[N, 3, H, W]`` RGB in [0, 1]."""

    def __init__(self, spec: ChainSpec | MethodSpec, device: Any, dtype: Any) -> None:
        import torch

        method = spec if isinstance(spec, MethodSpec) else None
        chain: ChainSpec = spec.upscale if isinstance(spec, MethodSpec) else spec
        self.spec = chain
        self.method = method
        self.halo = method.halo if method else chain.halo
        self.device = torch.device(device)
        self.dtype = dtype

        def tensors(stages: Any) -> list[Any]:
            return [
                (
                    stage,
                    torch.as_tensor(stage.weight, dtype=dtype, device=self.device),
                    torch.as_tensor(stage.bias, dtype=dtype, device=self.device),
                )
                for stage in stages
            ]

        self.stages = tensors(self.spec.stages)
        self.restore = tensors(method.restore.stages) if method and method.restore else []
        self.clamp = method.clamp if method else None

    def parameter_count(self) -> int:
        return sum(int(w.numel() + b.numel()) for _, w, b in [*self.restore, *self.stages])

    @staticmethod
    def _run(stages: Any, tex: dict[str, Any]) -> Any:
        import torch
        import torch.nn.functional as F

        y = None
        for stage, weight, bias in stages:
            views = []
            for name, activation in stage.inputs:
                t = tex[name]
                views.append(t if activation == "id" else F.relu(t) if activation == "pos" else F.relu(-t))
            x = torch.cat(views, dim=1)
            if stage.pad:
                x = F.pad(x, (stage.pad,) * 4, mode="replicate")
            y = F.conv2d(x, weight, bias)
            for k, name in enumerate(stage.saves):
                if name != MAIN:
                    tex[name] = y[:, 4 * k : 4 * k + 4]
        return y

    def _luma(self, rgb: Any) -> Any:
        import torch

        assert self.clamp is not None
        weights = torch.tensor(self.clamp.luma, dtype=rgb.dtype, device=rgb.device).view(1, 3, 1, 1)
        return (rgb[:, :3] * weights).sum(1, keepdim=True)

    def _clamp_stats(self, rgb: Any) -> Any:
        """5-pixel luma maximum, horizontal then vertical, replicate edges (Clamp_Highlights STATSMAX)."""
        import torch.nn.functional as F

        assert self.clamp is not None
        half = self.clamp.kernel // 2
        luma = F.pad(self._luma(rgb), (half, half, 0, 0), mode="replicate")
        luma = F.max_pool2d(luma, (1, self.clamp.kernel), stride=1)
        luma = F.pad(luma, (0, 0, half, half), mode="replicate")
        return F.max_pool2d(luma, (self.clamp.kernel, 1), stride=1)

    def _forward_method(self, rgb: Any) -> Any:
        import torch
        import torch.nn.functional as F

        stats = self._clamp_stats(rgb) if self.clamp else None
        main = torch.cat([rgb, torch.ones_like(rgb[:, :1])], dim=1)
        if self.restore:
            main = self._run(self.restore, {MAIN: main}) + main  # Restore's last pass: result + MAIN
        tex = {MAIN: main}
        for stage, weight, bias in self.stages:
            views = []
            for name, activation in stage.inputs:
                t = tex[name]
                views.append(t if activation == "id" else F.relu(t) if activation == "pos" else F.relu(-t))
            x = torch.cat(views, dim=1)
            if stage.pad:
                x = F.pad(x, (stage.pad,) * 4, mode="replicate")
            y = F.conv2d(x, weight, bias)
            for k, name in enumerate(stage.saves):
                tex[name] = y[:, 4 * k : 4 * k + 4]
        residual = torch.cat([F.pixel_shuffle(tex[name], 2) for name in self.spec.depth_to_space], dim=1)
        out = F.interpolate(main[:, :3], scale_factor=2, mode="bilinear", align_corners=False) + residual
        if stats is not None:
            limit = F.interpolate(stats, size=out.shape[-2:], mode="bilinear", align_corners=False)
            out = out - F.relu(self._luma(out) - limit)
        return out

    def forward(self, rgb: Any) -> Any:
        import torch
        import torch.nn.functional as F

        if self.restore or self.clamp:
            return self._forward_method(rgb)
        tex = {MAIN: torch.cat([rgb, torch.ones_like(rgb[:, :1])], dim=1)}
        for stage, weight, bias in self.stages:
            views = []
            for name, activation in stage.inputs:
                t = tex[name]
                views.append(t if activation == "id" else F.relu(t) if activation == "pos" else F.relu(-t))
            x = torch.cat(views, dim=1)
            if stage.pad:
                x = F.pad(x, (stage.pad,) * 4, mode="replicate")
            y = F.conv2d(x, weight, bias)
            for k, name in enumerate(stage.saves):
                tex[name] = y[:, 4 * k : 4 * k + 4]
        residual = torch.cat([F.pixel_shuffle(tex[name], 2) for name in self.spec.depth_to_space], dim=1)
        return F.interpolate(rgb, scale_factor=2, mode="bilinear", align_corners=False) + residual

    def upscale_frame(self, rgb: Any, tile_pixels: int) -> tuple[Any, int]:
        """2× of one ``[1, 3, H, W]`` frame through halo tiles → (``[1, 3, 2H, 2W]``, number of tiles)."""
        import torch

        _, _, height, width = rgb.shape
        halo = self.halo
        out = torch.empty((1, 3, 2 * height, 2 * width), dtype=rgb.dtype, device=rgb.device)
        tiles = tile_grid(height, width, tile_pixels)
        for y0, y1, x0, x1 in tiles:
            hy0, hy1 = max(0, y0 - halo), min(height, y1 + halo)
            hx0, hx1 = max(0, x0 - halo), min(width, x1 + halo)
            part = self.forward(rgb[:, :, hy0:hy1, hx0:hx1])
            oy, ox = 2 * (y0 - hy0), 2 * (x0 - hx0)
            out[:, :, 2 * y0 : 2 * y1, 2 * x0 : 2 * x1] = part[:, :, oy : oy + 2 * (y1 - y0), ox : ox + 2 * (x1 - x0)]
        return out, len(tiles)


def resize_to(frames: Any, width: int, height: int) -> Any:
    """Exact output size: bicubic with antialias (antialias only matters when shrinking), clamped to [0, 1]."""
    import torch.nn.functional as F

    if frames.shape[-2:] == (height, width):
        return frames.clamp(0.0, 1.0)
    resized = F.interpolate(frames.float(), size=(height, width), mode="bicubic", align_corners=False, antialias=True)
    return resized.clamp(0.0, 1.0)


def to_uint8(frames: Any) -> Any:
    """``[N, 3, H, W]`` in [0, 1] → host ``uint8 [N, H, W, 3]`` (rounded, not truncated)."""
    import torch

    scaled = frames.float().mul(255.0).round_().clamp_(0, 255).to(torch.uint8)
    return scaled.permute(0, 2, 3, 1).contiguous().cpu().numpy()


def from_uint8(frame: Any, device: Any, dtype: Any) -> Any:
    """Host ``uint8 [H, W, 3]`` → ``[1, 3, H, W]`` in [0, 1] on ``device``."""
    import torch

    tensor = torch.from_numpy(frame).to(device=device)
    return tensor.permute(2, 0, 1).unsqueeze(0).float().div_(255.0).to(dtype)


__all__ = ["Anime4KModel", "from_uint8", "resize_to", "to_uint8"]
