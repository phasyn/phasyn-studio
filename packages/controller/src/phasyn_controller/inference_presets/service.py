"""Resolve, attest and dispatch a pinned preset through the existing Controller run manager."""

from __future__ import annotations

import asyncio
from http import HTTPStatus
from typing import TYPE_CHECKING

import httpx
from phasyn_components import contracts
from phasyn_components.canonical import digest
from phasyn_components.errors import ComponentError
from phasyn_components.inference_presets.compile import bind, capture
from phasyn_components.inference_presets.policy import Doc, invalid

from ..inference_recipes import _resolve
from ..runner.plan import plan_run
from .store import PresetStore


if TYPE_CHECKING:
    from ..state import Controller


class PresetService:
    """Validate, freeze and submit recorded inference recipes."""

    def __init__(self, ctl: Controller) -> None:
        """Use the Controller catalog and the durable preset store."""
        self.ctl = ctl
        self.store = PresetStore(ctl.data_dir / "inference-presets.sqlite")

    def save(self, pid: str, options: Doc) -> Doc:
        """Capture an immutable revision from the selected run."""
        rid = options["source_run_id"]
        run = self.ctl.runs.read(rid)
        actual = _resolve(self.ctl, rid, run)
        definition = capture(run, actual, options)
        return self.store.put(pid, options["expected_revision"], definition)

    def _plan(self, preset: Doc, body: Doc) -> tuple[Doc, list[Doc]]:
        values, files = bind(preset, body["inputs"])
        request = {
            "pipeline": preset["pipeline"],
            "inputs": values,
            "label": preset["label"],
            "origin": {
                "source_run_id": preset["source_run_id"],
                "inference_preset": {
                    "preset_id": preset["preset_id"],
                    "revision": preset["revision"],
                    "definition_sha256": preset["definition_sha256"],
                },
            },
        }
        contracts.validate("RunRequest", request, what="RunRequest")
        steps = preset["pipeline"]["steps"]
        descriptors = self.ctl.catalog.descriptors(
            {(s["node_id"], s["component_id"]) for s in steps}
        )
        _, _, planned = plan_run(request, descriptors)
        for step in steps:
            sid = step["step_id"]
            pin = preset["pins"][sid]
            desc = descriptors[(step["node_id"], step["component_id"])]
            cfg = desc["settings"]
            if (
                desc["provider_id"] != pin["provider"]
                or desc["state"] != "ready"
                or cfg.get("restart_required")
            ):
                raise invalid(
                    "provider_not_ready_or_changed",
                    step_id=sid,
                    expected=pin["provider"],
                )
            if (
                cfg["loaded_revision"] != pin["load_revision"]
                or digest(cfg.get("loaded")) != pin["load_sha256"]
            ):
                raise invalid(
                    "load_configuration_changed",
                    step_id=sid,
                    expected_revision=pin["load_revision"],
                )
            if planned[sid]["invoke_snapshot"] != step["parameters"]:
                raise invalid("invoke_defaults_changed", step_id=sid)
            self.ctl.catalog.endpoint_for_call(step["node_id"])
        return request, files

    async def _file(self, ref: Doc) -> None:
        if ref["node_id"] == self.ctl.instance_id:
            known = await asyncio.to_thread(self.ctl.files.fileref, ref["file_id"])
            if known != ref:
                raise invalid(
                    "controller_file_identity_mismatch", file_id=ref["file_id"]
                )
            return
        url = (
            self.ctl.catalog.endpoint_for_read(ref["node_id"])
            + "/api/files/"
            + ref["file_id"]
        )
        async with self.ctl.http.stream(
            "GET",
            url,
            headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"},
            timeout=8,
        ) as resp:
            headers = resp.headers
            if (
                resp.status_code != HTTPStatus.PARTIAL_CONTENT
                or headers.get("etag") != f'"{ref["sha256"]}"'
                or headers.get("content-range") != f"bytes 0-0/{ref['size_bytes']}"
                or headers.get("content-type", "").split(";")[0] != ref["media_type"]
                or headers.get("content-length") != "1"
            ):
                raise invalid("node_file_identity_mismatch", file_id=ref["file_id"])
            size = 0
            async for chunk in resp.aiter_raw(chunk_size=1):
                size += len(chunk)
                if size > 1:
                    raise invalid("invalid_range_response", file_id=ref["file_id"])
            if size != 1:
                raise invalid("invalid_range_response", file_id=ref["file_id"])

    async def preflight(self, preset: Doc, body: Doc) -> Doc:
        """Resolve substitutions and check source files against current Nodes."""
        request, files = await asyncio.to_thread(self._plan, preset, body)
        # Verify in small batches. Do not fetch tensors, model weights, or full video files.
        try:
            async with asyncio.timeout(40):
                for offset in range(0, len(files), 8):
                    await asyncio.gather(
                        *(self._file(ref) for ref in files[offset : offset + 8])
                    )
        except ComponentError:
            raise
        except (TimeoutError, OSError, httpx.HTTPError) as exc:
            raise ComponentError(
                "NODE_UNREACHABLE", "無法確認推論素材的發布狀態"
            ) from exc
        return {
            "request": request,
            "definition_sha256": preset["definition_sha256"],
            "revision": preset["revision"],
            "policy": preset["policy"],
            "files_checked": len(files),
            "source_recipe_sha256": preset["source_recipe_sha256"],
        }

    async def submit(self, pid: str, body: Doc) -> Doc:
        """Reserve the submission and dispatch the checked revision."""
        preset = await asyncio.to_thread(self.store.get, pid, body["revision"])
        sha = digest(body)
        # Never dispatch twice on a lost reply, including across Controller restarts.
        key = body["request_id"]
        old = await asyncio.to_thread(
            self.store.lookup, key, pid, preset["revision"], sha
        )
        if old is not None:
            return await self._receipt(old[0], old[1])
        plan = await self.preflight(preset, body)
        rid, fresh, state = await asyncio.to_thread(
            self.store.reserve, key, pid, preset["revision"], sha
        )
        if fresh:
            try:
                await self.ctl.runner.create(
                    plan["request"],
                    reserved_run_id=rid,
                    verified_preset=plan["request"]["origin"]["inference_preset"],
                )
            except ComponentError:
                await asyncio.to_thread(self.store.mark, rid, "rejected")
                raise
            await asyncio.to_thread(self.store.mark, rid, "accepted")
        return await self._receipt(rid, "accepted" if fresh else state)

    async def _receipt(self, rid: str, state: str) -> Doc:
        active = self.ctl.runner.snapshot(rid)
        if active is None and not self.ctl.runs.path(rid).is_file():
            raise ComponentError(
                "STATE_CONFLICT",
                "已保留的提交識別碼尚無可驗證的執行紀錄",
                details={"run_id": rid, "receipt_state": state},
            )
        run = (
            active
            if active is not None
            else await asyncio.to_thread(self.ctl.runs.read, rid)
        )
        return {
            "run_id": rid,
            "state": run["state"],
            "origin": run["request"]["origin"],
            "actual_recipe": f"/api/runs/{rid}/recipe",
        }
