"""Local CPU provider for editable screenplay-derived storyboards."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ..errors import ComponentError
from ..native_manifest import package_data, read_manifest
from ..provider import BaseProvider, Description, Port, RunContext
from .script_board import compile_board


class StoryboardFromScriptProvider(BaseProvider):
    """Group screenplay text into editable Studio storyboard shots."""

    provider_id = "storyboard.from_script"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:  # noqa: ARG003 - The published describe interface accepts settings.
        """Use the same capability document for cold discovery and for a loaded component."""
        raw = package_data("phasyn_components", f"{cls.provider_id}.json")
        if raw is None:
            raise ComponentError("RUNTIME_ERROR", "缺少劇本元件宣告檔")
        doc = read_manifest(raw, cls.provider_id, f"{cls.__module__}:{cls.__name__}")
        return Description(
            provider_id=cls.provider_id,
            kind=doc["kind"],
            label=doc["label"],
            inputs=[Port(**port) for port in doc["inputs"]],
            outputs=[Port(**port) for port in doc["outputs"]],
            settings_schema=doc["settings_schema"],
            parameters_schema=doc["parameters_schema"],
            default_settings=doc["default_settings"],
        )

    def invoke(self, ctx: RunContext) -> None:
        """Publish the complete editable JSON as an immutable file."""
        source = ctx.input("script").value
        if isinstance(source, dict):
            source = source.get("text")
        if not isinstance(source, str):
            raise ComponentError("INVALID_ARGUMENT", "script 必須是文字")
        ctx.check_cancelled()
        with ctx.recorder.span("storyboard.compile", part="script"):
            board = compile_board(
                source,
                board_id=ctx.parameters.get("board_id"),
                cut_s=float(ctx.parameters.get("cut_seconds", 2)),
            )
            payload = (json.dumps(board, ensure_ascii=False, indent=2) + "\n").encode(
                "utf-8"
            )
        ctx.check_cancelled()
        result = ctx.new_file(
            "board",
            "application/json",
            {
                "schema_version": 1,
                "scene_count": len(board["scenes"]),
                "shot_count": len(board["shots"]),
                "source_sha256": board["source"]["sha256"],
            },
        )
        result.write(payload)
        ctx.set_file_output("board", result)
