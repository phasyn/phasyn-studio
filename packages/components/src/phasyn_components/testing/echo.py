"""``test.echo``: CPU contract-test provider (a test fixture, not a generative model).

It cannot stand in for accepting a DiT, Qwen or VAE component. It exercises registration,
start/stop, typed inputs and outputs, logs, file transfer, per-step cancellation, the failure
path, per-part compute settings for two sub-parts, and "accumulation precision unknown -> null".
Registered only when test providers are enabled (see :mod:`phasyn_components.testing`).
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from ..errors import ComponentError
from ..provider import BaseProvider, Description, LoadContext, LoadResult, Part, Port, RunContext, settings_schema
from ..recorder.metrics import metric
from ..settings import normalize_recording

PART_SCHEMA = {
    "type": "object",
    "properties": {"compute_dtype": {"enum": ["native", "fp32", "fp16"], "description": "測試用：只記錄，不改變行為"}},
}
INVOKE_PROPS: dict[str, dict[str, Any]] = {
    "steps": {"type": "integer", "minimum": 0, "maximum": 100000, "default": 0},
    "step_ms": {"type": "number", "minimum": 0, "maximum": 600000, "default": 0},
    "fail": {"type": "boolean", "default": False},
    "fail_code": {"type": "string", "default": "RUNTIME_ERROR"},
}


class EchoProvider(BaseProvider):
    provider_id = "test.echo"

    @classmethod
    def describe(cls, settings: Mapping[str, Any] | None) -> Description:
        return Description(
            provider_id=cls.provider_id,
            kind="test.echo",
            label="CPU 契約測試元件（test fixture，不是生成模型）",
            inputs=[Port("value", "test.echo.v1", True, "either", "任意 JSON 或檔案；原樣回傳")],
            outputs=[Port("value", "test.echo.v1", True, "either", "與輸入相同的內容（檔案會複製成新檔）")],
            parts=[
                Part("echo.stage_a", "stage", PART_SCHEMA, ["host_ms", "calls"]),
                Part("echo.stage_b", "stage", PART_SCHEMA, ["host_ms", "calls"]),
            ],
            settings_schema=settings_schema(
                precision_properties={
                    "compute_dtype": {"enum": ["native", "fp32", "fp16"]},
                    "accumulation_dtype": {"type": ["string", "null"]},
                },
                provider_options={"load_ms": {"type": "number", "minimum": 0, "maximum": 600000}},
                invoke_properties=INVOKE_PROPS,
                device_kinds=("cpu",),
            ),
            parameters_schema={"type": "object", "properties": INVOKE_PROPS, "additionalProperties": False},
            default_settings={
                "load": {
                    "device": {"kind": "cpu", "id": "cpu", "resource_group": "cpu-echo"},
                    "precision": {"compute_dtype": "native"},
                    "provider_options": {},
                },
                "invoke": {"steps": 0, "step_ms": 0},
                "recording": normalize_recording({"mode": "detailed"}),
            },
            synthetic=True,
        )

    def load(self, ctx: LoadContext) -> LoadResult:
        load_ms = float((ctx.load.get("provider_options") or {}).get("load_ms") or 0)
        if load_ms:
            time.sleep(load_ms / 1000)
        precision = ctx.load.get("precision") or {}
        observed = {
            "compute_dtype": precision.get("compute_dtype", "native"),
            "accumulation_dtype": None,
            "accumulation_dtype_reason": "CPU 測試元件沒有可觀測的累加精度；未知不等於 FP32",
        }
        return LoadResult(
            effective_load=ctx.load,
            observed=observed,
            expanded_parts=ctx.expanded_parts,
            model_identity={"model": "test.echo", "identity_strength": "builtin", "synthetic": True},
            runtime_identity={"provider_id": self.provider_id, "kind": "cpu"},
        )

    def invoke(self, ctx: RunContext) -> None:
        rec = ctx.recorder
        params = ctx.parameters
        steps = int(params.get("steps") or 0)
        step_ms = float(params.get("step_ms") or 0)
        rec.declare("scheduler_steps_completed")
        for i in range(steps):
            ctx.check_cancelled()
            part = "echo.stage_a" if i % 2 == 0 else "echo.stage_b"
            t0 = time.perf_counter_ns()
            with rec.span("echo.step", part=part, step_index=i):
                time.sleep(step_ms / 1000)
            rec.step(i, host_ms=(time.perf_counter_ns() - t0) / 1e6, scheduler_update_index=i, forward_index=i)
            rec.count("scheduler_steps_completed")
        ctx.check_cancelled()
        if params.get("fail"):
            raise ComponentError(str(params.get("fail_code") or "RUNTIME_ERROR"), "test.echo 依參數要求的測試失敗")
        item = ctx.input("value")
        if item.file is None:
            ctx.set_output("value", item.value)
            rec.set_metric("output_frame_count", None, quality="not_applicable", reason="echo 不產生影格")
            return
        path = item.require_path("value")
        out = ctx.new_file(
            "value",
            str(item.file.get("media_type") or "application/octet-stream"),
            {"echo_of": {k: item.file.get(k) for k in ("node_id", "file_id", "sha256")}},
        )
        t0 = time.perf_counter_ns()
        read = 0
        with open(path, "rb") as fh:
            while chunk := fh.read(8 * 1024 * 1024):
                ctx.check_cancelled()
                out.write(chunk)
                read += len(chunk)
        rec.transfer(
            "disk_read",
            direction="DISK_IN",
            submitted_bytes=read,
            host_ms=(time.perf_counter_ns() - t0) / 1e6,
            byte_basis="logical_file",
            owner="consumer",
            src=f"file:{item.file.get('file_id')}",
            dst="process",
            src_memory_kind="disk",
            dst_memory_kind="host",
        )
        ctx.set_file_output("value", out)
        rec.put_metric(
            "test.echo_bytes",
            metric("test.echo_bytes", read, unit="bytes", scope="component_call", method="io_wrapper"),
        )


__all__ = ["EchoProvider"]
