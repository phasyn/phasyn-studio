"""Creative wire contracts for versioned project entries and shot bindings."""

from __future__ import annotations

from typing import Any

from phasyn_components.contracts import validate


MEDIA_KINDS = {
    "character_image": "image",
    "source_audio": "audio",
    "performance_video": "video",
}


def validate_write(kind: str, body: Any) -> None:
    """Use the same revision and media-role contract exposed to Studio, CLI, and MCP."""
    name = (
        "StudioCreativeEntryWrite" if kind == "entry" else "StudioCreativeBindingWrite"
    )
    validate(name, body, what="創作設定")
