"""具型別接線的檢查與 DAG 排序.

只檢查名稱、必填、type_id、參數基本型別（provider parameters_schema）與無循環。
consumer 真正需要的 shape／layout／latent space 由元件執行時檢查。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from . import contracts
from .errors import ComponentError
from .typed import check_typed_value


DescriptorKey = tuple[str, str]  # (node_id, component_id)


_VISITED = 2


def _port_map(ports: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    return {str(p["name"]): p for p in ports}


def binding_kind(binding: Mapping[str, Any]) -> str:
    """Identify the source of a pipeline input binding."""
    if "from_input" in binding:
        return "input"
    if "from_step" in binding:
        return "step"
    return "literal"


def dependencies(step: Mapping[str, Any]) -> set[str]:
    """List dependencies between pipeline steps."""
    return {
        str(b["from_step"])
        for b in (step.get("inputs") or {}).values()
        if "from_step" in b
    }


def topo_order(steps: Sequence[Mapping[str, Any]]) -> list[str]:
    """Return steps in dependency order."""
    ids = [str(s["step_id"]) for s in steps]
    deps = {str(s["step_id"]): dependencies(s) for s in steps}
    order: list[str] = []
    state: dict[str, int] = {}  # 1=visiting 2=done

    def visit(node: str, chain: list[str]) -> None:
        mark = state.get(node)
        if mark == _VISITED:
            return
        if mark == 1:
            cycle = [*chain[chain.index(node) :], node]
            raise ComponentError(
                "CYCLIC_PIPELINE",
                f"接線有循環：{' → '.join(cycle)}",
                details={"cycle": cycle},
            )
        state[node] = 1
        for dep in sorted(deps.get(node, ())):
            visit(dep, [*chain, node])
        state[node] = _VISITED
        order.append(node)

    for sid in ids:
        visit(sid, [])
    return order


def validate_pipeline(
    pipeline: Mapping[str, Any],
    descriptors: Mapping[DescriptorKey, Mapping[str, Any]] | None = None,
    *,
    require_descriptors: bool = False,
) -> list[str]:
    """回傳拓撲順序；有錯誤時拋 ComponentError（422）.

    ``descriptors`` 為主控目錄中的 ComponentDescriptor（以 (node_id, component_id) 索引）。
    沒有目錄資料時只做結構與循環檢查（保存草稿用）；``require_descriptors`` 為真時（建立 run）
    每一步都必須能在目錄中找到。
    """
    if not isinstance(pipeline, Mapping):
        raise ComponentError("INVALID_ARGUMENT", "接線必須是 JSON object")
    contracts.validate("Pipeline", dict(pipeline), what="接線")
    steps = list(pipeline["steps"])
    step_ids = [str(s["step_id"]) for s in steps]
    duplicates = sorted({s for s in step_ids if step_ids.count(s) > 1})
    if duplicates:
        raise ComponentError(
            "INVALID_ARGUMENT",
            f"step_id 重複：{', '.join(duplicates)}",
            details={"duplicates": duplicates},
        )
    pipe_inputs = _port_map(pipeline.get("inputs") or [])
    by_id = {str(s["step_id"]): s for s in steps}

    _check_step_references(steps, pipe_inputs, by_id)
    order = topo_order(steps)

    for name, out in (pipeline.get("outputs") or {}).items():
        if str(out["from_step"]) not in by_id:
            raise ComponentError(
                "PORT_MISMATCH", f"接線輸出 {name} 引用不存在的步驟 {out['from_step']}"
            )

    if descriptors is None and not require_descriptors:
        return order
    descriptors = descriptors or {}

    _check_step_descriptors(
        steps, pipe_inputs, by_id, descriptors, require_descriptors=require_descriptors
    )
    for name, out in (pipeline.get("outputs") or {}).items():
        src = by_id[str(out["from_step"])]
        desc = descriptors.get((str(src["node_id"]), str(src["component_id"])))
        if desc is not None and str(out["output"]) not in _port_map(
            desc.get("outputs") or []
        ):
            raise ComponentError(
                "PORT_MISMATCH",
                f"接線輸出 {name}：步驟 {out['from_step']} 沒有輸出 {out['output']}",
            )
    return order


def _check_step_descriptors(
    steps: list[dict[str, Any]],
    pipe_inputs: Mapping[str, Any],
    by_id: Mapping[str, Any],
    descriptors: Mapping[DescriptorKey, Mapping[str, Any]],
    *,
    require_descriptors: bool,
) -> None:
    for step in steps:
        sid = str(step["step_id"])
        key = (str(step["node_id"]), str(step["component_id"]))
        desc = descriptors.get(key)
        if desc is None:
            if require_descriptors:
                raise ComponentError(
                    "COMPONENT_NOT_READY",
                    f"{sid}：目錄中找不到 node {key[0]} 的元件 {key[1]}（Node 未登記或元件不存在）",
                    details={"step": sid, "node_id": key[0], "component_id": key[1]},
                )
            continue
        inputs = _port_map(desc.get("inputs") or [])
        bound = step.get("inputs") or {}
        unknown = sorted(set(bound) - set(inputs))
        if unknown:
            raise ComponentError(
                "PORT_MISMATCH",
                f"{sid}：元件 {key[1]} 沒有輸入 {', '.join(unknown)}",
                details={
                    "step": sid,
                    "unknown_inputs": unknown,
                    "available": sorted(inputs),
                },
            )
        missing = sorted(
            n for n, p in inputs.items() if p.get("required") and n not in bound
        )
        if missing:
            raise ComponentError(
                "PORT_MISMATCH",
                f"{sid}：缺少必填輸入 {', '.join(missing)}",
                details={"step": sid, "missing": missing},
            )
        for port, binding in bound.items():
            want = str(inputs[port]["type_id"])
            got = _binding_type(binding, pipe_inputs, by_id, descriptors)
            if got is not None and got != want:
                raise ComponentError(
                    "PORT_MISMATCH",
                    f"{sid}.{port} 需要 {want}，接到的是 {got}；type_id 不同不做自動轉換",
                    details={"step": sid, "port": port, "expected": want, "got": got},
                )
        params_schema = (desc.get("settings") or {}).get("parameters_schema") or {}
        if params_schema:
            contracts.validate_with_schema(
                params_schema,
                step.get("parameters") or {},
                code="INVALID_ARGUMENT",
                what=f"{sid} 參數不符合元件宣告",
            )


def _check_step_references(
    steps: list[dict[str, Any]],
    pipe_inputs: Mapping[str, Any],
    by_id: Mapping[str, Any],
) -> None:
    for step in steps:
        sid = str(step["step_id"])
        for port, binding in (step.get("inputs") or {}).items():
            kind = binding_kind(binding)
            if kind == "input" and str(binding["from_input"]) not in pipe_inputs:
                raise ComponentError(
                    "PORT_MISMATCH",
                    f"{sid}.{port} 引用不存在的接線輸入 {binding['from_input']}",
                    details={"step": sid, "port": port},
                )
            if kind == "step":
                src = str(binding["from_step"])
                if src == sid:
                    raise ComponentError(
                        "CYCLIC_PIPELINE",
                        f"{sid}.{port} 不能引用自己的輸出",
                        details={"step": sid},
                    )
                if src not in by_id:
                    raise ComponentError(
                        "PORT_MISMATCH",
                        f"{sid}.{port} 引用不存在的步驟 {src}",
                        details={"step": sid, "port": port},
                    )
            if kind == "literal":
                check_typed_value(binding["literal"], where=f"{sid}.{port} literal")


def _binding_type(
    binding: Mapping[str, Any],
    pipe_inputs: Mapping[str, Mapping[str, Any]],
    by_id: Mapping[str, Mapping[str, Any]],
    descriptors: Mapping[DescriptorKey, Mapping[str, Any]],
) -> str | None:
    kind = binding_kind(binding)
    if kind == "input":
        return str(pipe_inputs[str(binding["from_input"])]["type_id"])
    if kind == "literal":
        return str(binding["literal"]["type_id"])
    src = by_id[str(binding["from_step"])]
    desc = descriptors.get((str(src["node_id"]), str(src["component_id"])))
    if desc is None:
        return None
    outputs = _port_map(desc.get("outputs") or [])
    out_name = str(binding["output"])
    if out_name not in outputs:
        raise ComponentError(
            "PORT_MISMATCH",
            f"步驟 {src['step_id']} 沒有輸出 {out_name}",
            details={
                "step": src["step_id"],
                "output": out_name,
                "available": sorted(outputs),
            },
        )
    return str(outputs[out_name]["type_id"])


def validate_run_inputs(pipeline: Mapping[str, Any], inputs: Mapping[str, Any]) -> None:
    """Validate supplied inputs against the pipeline ports."""
    ports = _port_map(pipeline.get("inputs") or [])
    unknown = sorted(set(inputs) - set(ports))
    if unknown:
        raise ComponentError(
            "PORT_MISMATCH", f"run 輸入有未宣告的名稱：{', '.join(unknown)}"
        )
    for name, port in ports.items():
        if name not in inputs:
            if port.get("required"):
                raise ComponentError(
                    "PORT_MISMATCH",
                    f"缺少必填 run 輸入 {name}",
                    details={"input": name},
                )
            continue
        value = check_typed_value(inputs[name], where=f"run 輸入 {name}")
        if value["type_id"] != port["type_id"]:
            raise ComponentError(
                "PORT_MISMATCH",
                f"run 輸入 {name} 需要 {port['type_id']}，收到 {value['type_id']}",
                details={
                    "input": name,
                    "expected": port["type_id"],
                    "got": value["type_id"],
                },
            )
        transport = port.get("transport")
        if transport == "file" and "file" not in value:
            raise ComponentError("PORT_MISMATCH", f"run 輸入 {name} 需要 FileRef")
        if transport == "inline" and "value" not in value:
            raise ComponentError("PORT_MISMATCH", f"run 輸入 {name} 需要 inline JSON")


__all__ = [
    "binding_kind",
    "dependencies",
    "topo_order",
    "validate_pipeline",
    "validate_run_inputs",
]
