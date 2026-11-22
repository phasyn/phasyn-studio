"""Local CPU component for versioned art handoffs and verified returns."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from phasyn_components.errors import ComponentError
from phasyn_components.provider import BaseProvider, Description, Port
from phasyn_media.errors import MediaError
from phasyn_media.providers._failure import media_failure
from phasyn_media.tools import find_ffmpeg, find_ffprobe

from .exchange import export_art, return_art


if TYPE_CHECKING:
    from collections.abc import Mapping

    from phasyn_components.provider import RunContext


class ArtExchangeProvider(BaseProvider):
    """Accept both generator outputs and ordinary imported source media."""

    provider_id: ClassVar[str] = "art.exchange"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        """Discover typed inputs and outputs without opening any media."""
        del settings
        folder = Path(__file__).with_name("native_capabilities")
        data = json.loads(
            (folder / f"{cls.provider_id}.json").read_text(encoding="utf-8")
        )
        try:
            find_ffmpeg()
            find_ffprobe()
        except MediaError:
            available = False
        else:
            available = True
        return Description(
            provider_id=cls.provider_id,
            kind=cls.provider_id,
            label=data["label"],
            inputs=[Port(**p) for p in data["inputs"]],
            outputs=[Port(**p) for p in data["outputs"]],
            settings_schema=data["settings_schema"],
            parameters_schema=data["parameters_schema"],
            default_settings=data["default_settings"],
            available=available,
            unavailable_code=None if available else "MEDIA_TOOL_FAILED",
            unavailable_reason=None if available else "FFmpeg and ffprobe are required",
            facts={
                "manifest_type": "art.exchange-manifest.v1",
                "return_creates_revision": True,
            },
        )

    def invoke(self, ctx: RunContext) -> None:
        """Export the selected plates or validate a proposed replacement."""
        operation = ctx.parameters.get("operation", "export")
        try:
            with ctx.recorder.phase("art_exchange"):
                if operation == "export":
                    export_art(ctx)
                elif operation == "return":
                    return_art(ctx)
                else:
                    raise ComponentError(
                        "INVALID_ARGUMENT", "Unknown art exchange operation"
                    )
        except MediaError as exc:
            raise media_failure(ctx, exc, what="美術素材往返") from exc
