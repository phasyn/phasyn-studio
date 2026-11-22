// 具型別接線：前端在儲存／執行前先檢查必填、型別、循環；伺服器仍是權威（422）。
// 規則與 Node 端 phasyn_components.pipeline 一致：type_id 必須完全相同，不做自動轉換。
import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import type { WireBinding, WirePipeline, WireStep, WireTypedValue } from "@/api/types";
import { describeConflicts, DIT_PROVIDER, samplingConflicts, stripSampling } from "@/lib/ditSampling";
import { localIdError, uniqueName } from "@/lib/ids";
import { isRecord } from "@/lib/json";
import { validateValue } from "@/lib/schema";
import { t } from "@/i18n";

export type DescriptorLookup = (nodeId: string, componentId: string) => ComponentDescriptor | null;

export type IssueSeverity = "error" | "warning";

export interface PipelineIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  stepId?: string;
  port?: string;
  /** 呼叫參數的問題：parameters 內的欄位路徑（空字串＝整個 parameters）；步驟的參數表單會在欄位旁顯示。 */
  parameter?: string;
}

export function bindingKind(binding: WireBinding): "input" | "step" | "literal" {
  if ("from_input" in binding) return "input";
  if ("from_step" in binding) return "step";
  return "literal";
}

/** 依賴的步驟（只有 from_step 會形成 DAG 邊）。 */
export function stepDependencies(step: WireStep): string[] {
  return Object.values(step.inputs)
    .filter((binding): binding is { from_step: string; output: string } => "from_step" in binding)
    .map((binding) => binding.from_step);
}

/** 拓撲排序；有循環時回傳循環路徑（a → b → a）。 */
export function topoOrder(steps: readonly WireStep[]): { order: string[]; cycle: string[] | null } {
  const deps = new Map(steps.map((step) => [step.step_id, stepDependencies(step)]));
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  let cycle: string[] | null = null;
  const visit = (id: string, chain: string[]) => {
    if (cycle) return;
    const mark = state.get(id);
    if (mark === 2) return;
    if (mark === 1) {
      cycle = [...chain.slice(chain.indexOf(id)), id];
      return;
    }
    state.set(id, 1);
    for (const dep of [...(deps.get(id) ?? [])].sort()) {
      if (deps.has(dep)) visit(dep, [...chain, id]);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const step of steps) visit(step.step_id, []);
  return { order, cycle };
}

/** binding 的 type_id：pipeline 輸入、上游輸出或常值；上游元件不在目錄時為 null（無法判斷）。 */
export function bindingType(binding: WireBinding, pipeline: WirePipeline, lookup: DescriptorLookup): string | null {
  if ("from_input" in binding) return pipeline.inputs.find((port) => port.name === binding.from_input)?.type_id ?? null;
  if ("literal" in binding) return binding.literal.type_id;
  const source = pipeline.steps.find((step) => step.step_id === binding.from_step);
  if (!source) return null;
  const descriptor = lookup(source.node_id, source.component_id);
  return descriptor?.outputs.find((port) => port.name === binding.output)?.type_id ?? null;
}

function literalTransportError(port: Port, literal: WireTypedValue): string | null {
  if (port.transport === "file" && !("file" in literal)) return t("{name} 需要檔案（FileRef），常值是 inline JSON", { name: port.name });
  if (port.transport === "inline" && "file" in literal) return t("{name} 需要 inline JSON，常值是檔案", { name: port.name });
  return null;
}

/** 接線檢查：錯誤會被伺服器以 422 拒絕；警告是目錄資訊不足或可能的遺漏。 */
export function validatePipeline(pipeline: WirePipeline, lookup: DescriptorLookup): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const error = (code: string, message: string, extra: Partial<PipelineIssue> = {}) => issues.push({ severity: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<PipelineIssue> = {}) => issues.push({ severity: "warning", code, message, ...extra });

  const idError = localIdError(pipeline.pipeline_id, "pipeline_id ");
  if (idError != null && idError !== "") error("INVALID_ARGUMENT", idError);
  if (pipeline.steps.length === 0) error("INVALID_ARGUMENT", t("至少需要一個步驟"));

  const inputNames = pipeline.inputs.map((port) => port.name);
  pipeline.inputs.forEach((port) => {
    const nameError = localIdError(port.name, t("輸入名稱 "));
    if (nameError != null && nameError !== "") error("INVALID_ARGUMENT", t("pipeline 輸入：{nameError}", { nameError }));
    if (!port.type_id) error("INVALID_ARGUMENT", t("pipeline 輸入 {name} 缺少 type_id", { name: port.name }));
  });
  for (const name of new Set(inputNames.filter((name, index) => inputNames.indexOf(name) !== index))) {
    error("INVALID_ARGUMENT", t("pipeline 輸入名稱重複：{name}", { name }));
  }

  const stepIds = pipeline.steps.map((step) => step.step_id);
  for (const id of new Set(stepIds.filter((id, index) => stepIds.indexOf(id) !== index))) {
    error("INVALID_ARGUMENT", t("step_id 重複：{id}", { id }), { stepId: id });
  }
  const used = new Set<string>();

  for (const step of pipeline.steps) {
    const sid = step.step_id;
    const stepIdError = localIdError(sid, "step_id ");
    if (stepIdError != null && stepIdError !== "") error("INVALID_ARGUMENT", stepIdError, { stepId: sid });
    if (!step.node_id || !step.component_id) {
      error("INVALID_ARGUMENT", t("{sid}：尚未選擇元件", { sid }), { stepId: sid });
      continue;
    }
    for (const [port, binding] of Object.entries(step.inputs)) {
      if ("from_input" in binding) {
        used.add(binding.from_input);
        if (!inputNames.includes(binding.from_input)) {
          error("PORT_MISMATCH", t("{sid}.{port} 引用不存在的 pipeline 輸入 {from_input}", { sid, port, from_input: binding.from_input }), { stepId: sid, port });
        }
      } else if ("from_step" in binding) {
        if (binding.from_step === sid) error("CYCLIC_PIPELINE", t("{sid}.{port} 不能引用自己的輸出", { sid, port }), { stepId: sid, port });
        else if (!stepIds.includes(binding.from_step)) {
          error("PORT_MISMATCH", t("{sid}.{port} 引用不存在的步驟 {from_step}", { sid, port, from_step: binding.from_step }), { stepId: sid, port });
        }
      } else if (!binding.literal.type_id) {
        error("INVALID_ARGUMENT", t("{sid}.{port} 的常值缺少 type_id", { sid, port }), { stepId: sid, port });
      }
    }
    const descriptor = lookup(step.node_id, step.component_id);
    if (!descriptor) {
      warn("COMPONENT_NOT_READY", t("{sid}：目錄中找不到 {component_id}（Node 離線或元件不存在）；無法檢查接線，建立 run 時伺服器會拒絕", { sid, component_id: step.component_id }), { stepId: sid });
      continue;
    }
    const sampling = samplingConflicts(step.parameters, descriptor);
    const contract = sampling.filter((item) => item.blocking);
    const soft = sampling.filter((item) => !item.blocking);
    if (contract.length > 0) error("SAMPLING_CONTRACT", t("{sid}：{contract}", { sid, contract: describeConflicts(contract, step.component_id, t("這一步")) }), { stepId: sid });
    if (soft.length > 0) warn("SAMPLING_DEFAULT", t("{sid}：{soft}", { sid, soft: describeConflicts(soft, step.component_id, t("這一步")) }), { stepId: sid });
    // 呼叫參數 vs 元件的 parameters_schema（與伺服器 validate_pipeline 相同：schema 非空才檢查，不符＝422 INVALID_ARGUMENT）
    const paramsSchema = descriptor.settings.parameters_schema;
    if (isRecord(paramsSchema) && Object.keys(paramsSchema).length > 0) {
      for (const problem of validateValue(paramsSchema, step.parameters, paramsSchema)) {
        error("INVALID_ARGUMENT", t("{sid}.parameters{value}：{message}", { sid, value: problem.path ? `.${problem.path}` : "", message: problem.message }), { stepId: sid, parameter: problem.path });
      }
    }
    const ports = new Map(descriptor.inputs.map((port) => [port.name, port]));
    for (const port of Object.keys(step.inputs)) {
      if (!ports.has(port)) error("PORT_MISMATCH", t("{sid}：元件 {component_id} 沒有輸入 {port}", { sid, component_id: step.component_id, port }), { stepId: sid, port });
    }
    for (const port of descriptor.inputs) {
      const binding = step.inputs[port.name];
      if (!binding) {
        if (port.required) error("PORT_MISMATCH", t("{sid}：缺少必填輸入 {name}（{type_id}）", { sid, name: port.name, type_id: port.type_id }), { stepId: sid, port: port.name });
        continue;
      }
      if ("from_step" in binding) {
        const source = pipeline.steps.find((item) => item.step_id === binding.from_step);
        const sourceDescriptor = source ? lookup(source.node_id, source.component_id) : null;
        if (sourceDescriptor && !sourceDescriptor.outputs.some((output) => output.name === binding.output)) {
          error("PORT_MISMATCH", t("{sid}.{name}：步驟 {from_step} 沒有輸出 {output}", { sid, name: port.name, from_step: binding.from_step, output: binding.output }), { stepId: sid, port: port.name });
          continue;
        }
      }
      const got = bindingType(binding, pipeline, lookup);
      if (got !== null && got !== port.type_id) {
        error("PORT_MISMATCH", t("{sid}.{name} 需要 {type_id}，接到的是 {got}；type_id 不同不做自動轉換", { sid, name: port.name, type_id: port.type_id, got }), { stepId: sid, port: port.name });
      }
      if ("literal" in binding) {
        const transport = literalTransportError(port, binding.literal);
        if (transport != null && transport !== "") error("PORT_MISMATCH", `${sid}.${transport}`, { stepId: sid, port: port.name });
      }
    }
  }

  const { cycle } = topoOrder(pipeline.steps);
  if (cycle) error("CYCLIC_PIPELINE", t("接線有循環：{cycle}", { cycle: cycle.join(" → ") }));

  const outputNames = Object.keys(pipeline.outputs);
  if (outputNames.length === 0) warn("NO_OUTPUTS", t("沒有宣告 pipeline 輸出：run 仍會保留每個步驟的輸出"));
  for (const [name, target] of Object.entries(pipeline.outputs)) {
    const nameError = localIdError(name, t("輸出名稱 "));
    if (nameError != null && nameError !== "") error("INVALID_ARGUMENT", t("pipeline 輸出：{nameError}", { nameError }));
    const source = pipeline.steps.find((step) => step.step_id === target.from_step);
    if (!source) {
      error("PORT_MISMATCH", t("pipeline 輸出 {name} 引用不存在的步驟 {from_step}", { name, from_step: target.from_step }));
      continue;
    }
    const descriptor = lookup(source.node_id, source.component_id);
    if (descriptor && !descriptor.outputs.some((port) => port.name === target.output)) {
      error("PORT_MISMATCH", t("pipeline 輸出 {name}：步驟 {from_step} 沒有輸出 {output}", { name, from_step: target.from_step, output: target.output }));
    }
  }
  for (const port of pipeline.inputs) {
    if (!used.has(port.name)) warn("UNUSED_INPUT", t("pipeline 輸入 {name} 沒有任何步驟使用", { name: port.name }));
  }
  return issues;
}

/** 步驟輸出選項的值（step_id 可含 ':'，因此用 ID 不允許的 '→' 分隔）。 */
export function outputValue(stepId: string, output: string): string {
  return `${stepId}→${output}`;
}

export function parseOutputValue(value: string): { stepId: string; output: string } | null {
  const index = value.indexOf("→");
  if (index <= 0) return null;
  return { stepId: value.slice(0, index), output: value.slice(index + 1) };
}

export interface SourceOption {
  value: string;
  label: string;
  typeId: string | null;
  compatible: boolean;
  reason: string | null;
}

/** 某個輸入埠可選的來源：pipeline 輸入與其他步驟輸出；型別不符者標示原因（UI 以 disabled 呈現）。 */
export function sourceOptions(pipeline: WirePipeline, stepIndex: number, port: Port, lookup: DescriptorLookup): { inputs: SourceOption[]; outputs: SourceOption[] } {
  const inputs = pipeline.inputs.map((input) => {
    const compatible = input.type_id === port.type_id;
    return {
      value: input.name,
      label: input.name,
      typeId: input.type_id,
      compatible,
      reason: compatible ? null : t("型別 {type_id} ≠ {type_id2}", { type_id: input.type_id, type_id2: port.type_id }),
    };
  });
  const outputs: SourceOption[] = [];
  pipeline.steps.forEach((step, index) => {
    if (index === stepIndex) return;
    const descriptor = lookup(step.node_id, step.component_id);
    if (!descriptor) {
      outputs.push({ value: outputValue(step.step_id, ""), label: t("{step_id}（元件不在目錄）", { step_id: step.step_id }), typeId: null, compatible: false, reason: t("無法得知輸出型別") });
      return;
    }
    for (const output of descriptor.outputs) {
      const compatible = output.type_id === port.type_id;
      const later = index > stepIndex ? t("（排在後面）") : "";
      outputs.push({
        value: outputValue(step.step_id, output.name),
        label: `${step.step_id}.${output.name}${later}`,
        typeId: output.type_id,
        compatible,
        reason: compatible ? null : t("型別 {type_id} ≠ {type_id2}", { type_id: output.type_id, type_id2: port.type_id }),
      });
    }
  });
  return { inputs, outputs };
}

export interface WiringEdge {
  from: string;
  to: string;
  typeId: string | null;
  kind: "input" | "step" | "literal" | "output";
}

/** 接線摘要：依拓撲順序列出每條邊（有循環時依清單順序）。 */
export function wiringEdges(pipeline: WirePipeline, lookup: DescriptorLookup): WiringEdge[] {
  const { order, cycle } = topoOrder(pipeline.steps);
  const ids = cycle ? pipeline.steps.map((step) => step.step_id) : order;
  const edges: WiringEdge[] = [];
  for (const id of ids) {
    const step = pipeline.steps.find((item) => item.step_id === id);
    if (!step) continue;
    for (const [port, binding] of Object.entries(step.inputs)) {
      const typeId = bindingType(binding, pipeline, lookup);
      if ("from_input" in binding) edges.push({ from: t("輸入 {from_input}", { from_input: binding.from_input }), to: `${id}.${port}`, typeId, kind: "input" });
      else if ("from_step" in binding) edges.push({ from: `${binding.from_step}.${binding.output}`, to: `${id}.${port}`, typeId, kind: "step" });
      else edges.push({ from: t("常值（{value}）", { value: "file" in binding.literal ? t("檔案") : "inline" }), to: `${id}.${port}`, typeId, kind: "literal" });
    }
  }
  for (const [name, target] of Object.entries(pipeline.outputs)) {
    const source = pipeline.steps.find((step) => step.step_id === target.from_step);
    const typeId = source ? (lookup(source.node_id, source.component_id)?.outputs.find((port) => port.name === target.output)?.type_id ?? null) : null;
    edges.push({ from: `${target.from_step}.${target.output}`, to: t("輸出 {name}", { name }), typeId, kind: "output" });
  }
  return edges;
}

/** run 輸入檢查（與 Node 端 validate_run_inputs 一致）。 */
export function runInputIssues(pipeline: WirePipeline, inputs: Record<string, WireTypedValue | null | undefined>): string[] {
  const messages: string[] = [];
  const names = new Set(pipeline.inputs.map((port) => port.name));
  for (const name of Object.keys(inputs)) if (inputs[name] && !names.has(name)) messages.push(t("run 輸入有未宣告的名稱：{name}", { name }));
  for (const port of pipeline.inputs) {
    const value = inputs[port.name];
    if (!value) {
      if (port.required) messages.push(t("缺少必填輸入 {name}（{type_id}）", { name: port.name, type_id: port.type_id }));
      continue;
    }
    if (value.type_id !== port.type_id) messages.push(t("{name} 需要 {type_id}，目前是 {type_id2}", { name: port.name, type_id: port.type_id, type_id2: value.type_id }));
    if (port.transport === "file" && !("file" in value)) messages.push(t("{name} 需要檔案（FileRef）", { name: port.name }));
    if (port.transport === "inline" && "file" in value) messages.push(t("{name} 需要 inline 內容", { name: port.name }));
  }
  return messages;
}

/**
 * 步驟改用另一個 instance：保留新元件也有的輸入埠接線；已知 provider 不同時清空呼叫參數（schema 不同）。
 * previous＝目前元件的描述；目錄中找不到（例如元件已刪除）時無從比較，保留參數——新 schema 不接受的鍵
 * 由參數檢查（validateValue）標出，不默默丟掉。
 */
export function withComponent(step: WireStep, previous: ComponentDescriptor | null, nodeId: string, next: ComponentDescriptor): WireStep {
  const ports = new Set(next.inputs.map((port) => port.name));
  const inputs: Record<string, WireBinding> = {};
  for (const [port, binding] of Object.entries(step.inputs)) if (ports.has(port)) inputs[port] = binding;
  const keepParameters = previous === null || next.provider_id === previous.provider_id;
  let parameters = keepParameters ? step.parameters : {};
  // 換成另一個 DiT：舊 DiT 的步數與 shift 不一定適用（加速 LoRA 有採樣合約），改用新元件保存的預設
  if (keepParameters && previous !== null && next.provider_id === DIT_PROVIDER && previous.component_id !== next.component_id) parameters = stripSampling(parameters).parameters;
  return { ...step, node_id: nodeId, component_id: next.component_id, inputs, parameters };
}

export function emptyPipeline(pipelineId: string, label: string): WirePipeline {
  return { pipeline_id: pipelineId, label, inputs: [], steps: [], outputs: {} };
}

function mapBindings(pipeline: WirePipeline, map: (binding: WireBinding) => WireBinding | null): WirePipeline {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => {
      const inputs: Record<string, WireBinding> = {};
      for (const [port, binding] of Object.entries(step.inputs)) {
        const next = map(binding);
        if (next) inputs[port] = next;
      }
      return { ...step, inputs };
    }),
  };
}

/** 改 step_id：一併更新引用它的接線與 pipeline 輸出。 */
export function renameStep(pipeline: WirePipeline, from: string, to: string): WirePipeline {
  const next = mapBindings(pipeline, (binding) => ("from_step" in binding && binding.from_step === from ? { ...binding, from_step: to } : binding));
  const outputs: WirePipeline["outputs"] = {};
  for (const [name, target] of Object.entries(pipeline.outputs)) outputs[name] = target.from_step === from ? { ...target, from_step: to } : target;
  return { ...next, steps: next.steps.map((step) => (step.step_id === from ? { ...step, step_id: to } : step)), outputs };
}

/** 改 pipeline 輸入名稱：一併更新 from_input 引用。 */
export function renameInput(pipeline: WirePipeline, from: string, to: string): WirePipeline {
  const next = mapBindings(pipeline, (binding) => ("from_input" in binding && binding.from_input === from ? { from_input: to } : binding));
  return { ...next, inputs: pipeline.inputs.map((port) => (port.name === from ? { ...port, name: to } : port)) };
}

/** 移除步驟：引用它的接線與輸出一併移除（下游會顯示缺少必填輸入）。 */
export function removeStep(pipeline: WirePipeline, index: number): WirePipeline {
  const removed = pipeline.steps[index]?.step_id;
  if (removed === undefined) return pipeline;
  const next = mapBindings({ ...pipeline, steps: pipeline.steps.filter((_, position) => position !== index) }, (binding) =>
    "from_step" in binding && binding.from_step === removed ? null : binding,
  );
  const outputs: WirePipeline["outputs"] = {};
  for (const [name, target] of Object.entries(pipeline.outputs)) if (target.from_step !== removed) outputs[name] = target;
  return { ...next, outputs };
}

/** 移除 pipeline 輸入：引用它的接線一併移除。 */
export function removeInput(pipeline: WirePipeline, name: string): WirePipeline {
  const next = mapBindings(pipeline, (binding) => ("from_input" in binding && binding.from_input === name ? null : binding));
  return { ...next, inputs: pipeline.inputs.filter((port) => port.name !== name) };
}

/** 某個步驟的輸出埠 → 宣告成的流程輸出名稱（依宣告順序）。 */
export function exportsOfStep(pipeline: WirePipeline, stepId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, target] of Object.entries(pipeline.outputs)) {
    if (target.from_step !== stepId) continue;
    (out[target.output] ??= []).push(name);
  }
  return out;
}

/** 把步驟的輸出埠宣告為流程輸出（名稱預設＝埠名，重複時加序號）。 */
export function addExport(pipeline: WirePipeline, stepId: string, port: string): { pipeline: WirePipeline; name: string } {
  const name = uniqueName(port, new Set(Object.keys(pipeline.outputs)));
  return { pipeline: { ...pipeline, outputs: { ...pipeline.outputs, [name]: { from_step: stepId, output: port } } }, name };
}

/** 流程輸出改名的檢查（格式與重複）；合法＝null。 */
export function exportNameError(pipeline: WirePipeline, current: string, next: string): string | null {
  const error = localIdError(next, t("名稱 "));
  if (error != null && error !== "") return error;
  if (next !== current && Object.hasOwn(pipeline.outputs, next)) return t("名稱重複");
  return null;
}

/** 改名（保留宣告順序）。 */
export function renameExport(pipeline: WirePipeline, from: string, to: string): WirePipeline {
  return { ...pipeline, outputs: Object.fromEntries(Object.entries(pipeline.outputs).map(([name, target]) => [name === from ? to : name, target])) };
}

/** 改來源（保留名稱與順序）。 */
export function retargetExport(pipeline: WirePipeline, name: string, target: { from_step: string; output: string }): WirePipeline {
  return { ...pipeline, outputs: Object.fromEntries(Object.entries(pipeline.outputs).map(([key, value]) => [key, key === name ? target : value])) };
}

/** 不再列為流程輸出（步驟仍會產生這個輸出）。 */
export function removeExport(pipeline: WirePipeline, name: string): WirePipeline {
  return { ...pipeline, outputs: Object.fromEntries(Object.entries(pipeline.outputs).filter(([key]) => key !== name)) };
}
