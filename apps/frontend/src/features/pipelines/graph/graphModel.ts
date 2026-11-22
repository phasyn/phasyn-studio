// pipeline（＋目錄＋選填 run）→ 節點與連線（純函式）。
// 節點：每個 pipeline 輸入一個「輸入」節點、每個步驟一個節點。流程輸出不是節點，而是標在產生它的
// 步驟輸出接點上（GraphPort.exports；例如 DiT 的 video_latent 直接接到影片 VAE 解碼，同時標「↗ video_latent」）。
// 連線只來自 from_input／from_step；常值綁定不是連線，只在接點上標「常數」。
// run 模式的時間只取 started_at／finished_at 的實測差；任一缺漏＝null（附原因），絕不畫成 0。
import type { ComponentDescriptor, Port } from "@/api/generated/contracts";
import { asTypedValueMap, parseRunStep, type RunStepView, type WireBinding, type WirePipeline, type WireRun, type WireStep } from "@/api/types";
import { statusSpec } from "@/components/common/statusSpec";
import { providerKind, typeTone } from "@/components/workbench/kinds";
import type { Tone } from "@/components/workbench/tones";
import { placeLabel } from "@/lib/deviceTag";
import { formatMs } from "@/lib/format";
import { isoToMs } from "@/lib/time";
import { bindingType, topoOrder, type DescriptorLookup, type PipelineIssue } from "../pipelineModel";
import type {
  GraphEdge,
  GraphExport,
  GraphModel,
  GraphNode,
  GraphNodeKind,
  GraphPort,
  GraphSelection,
  IssueCount,
  NodeLabelLookup,
  StepRunInfo,
} from "./graphTypes";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";

/** 輸入節點唯一的接點名稱（顯示文字改用 type_id）。 */
export const VALUE_PORT = "value";

/** 節點的 key（輸出選取沒有節點，key 只用來比對）。 */
export function nodeKey(kind: GraphNodeKind | "output", id: string): string {
  return `${kind}:${id}`;
}

export function selectionKey(selection: GraphSelection | null | undefined): string | null {
  return selection ? nodeKey(selection.kind, selection.id) : null;
}

export function selectionOf(node: Pick<GraphNode, "kind" | "id">): GraphSelection {
  return { kind: node.kind, id: node.id };
}

/** 接點的 key（步驟＋輸出埠）。 */
export function exportPortKey(stepId: string, port: string): string {
  return `${stepId}␟${port}`;
}

/**
 * 流程輸出 → 產生它的步驟輸出接點（依宣告順序）；來源步驟不存在者列在 dangling（畫不到任何接點）。
 * run 模式另標是否已產生：yes＝run 輸出已有此鍵、pending＝run 進行中、no＝run 已結束仍沒有。
 */
export function pipelineExports(pipeline: WirePipeline, run: WireRun | null = null): { byPort: Map<string, GraphExport[]>; dangling: string[] } {
  const stepIds = new Set(pipeline.steps.map((step) => step.step_id));
  const runOutputs = run ? asTypedValueMap(run.outputs) : null;
  const byPort = new Map<string, GraphExport[]>();
  const dangling: string[] = [];
  for (const [name, target] of Object.entries(pipeline.outputs)) {
    if (!stepIds.has(target.from_step)) {
      dangling.push(name);
      continue;
    }
    const produced: GraphExport["produced"] = !runOutputs ? null : runOutputs[name] !== undefined ? "yes" : run?.state === "running" ? "pending" : "no";
    const key = exportPortKey(target.from_step, target.output);
    byPort.set(key, [...(byPort.get(key) ?? []), { name, produced }]);
  }
  return { byPort, dangling };
}

export interface GraphModelOptions {
  run?: WireRun | null;
  issues?: readonly PipelineIssue[];
  nodeLabel?: NodeLabelLookup;
}

const NO_ISSUES: IssueCount = { errors: 0, warnings: 0, messages: [] };

function emptyIssues(): IssueCount {
  return { errors: 0, warnings: 0, messages: [] };
}

function addIssue(target: IssueCount, issue: PipelineIssue): void {
  if (issue.severity === "error") target.errors += 1;
  else target.warnings += 1;
  target.messages.push(issue.message);
}

function portIssueKey(stepId: string, port: string): string {
  return `${stepId}␟${port}`;
}

function indexIssues(issues: readonly PipelineIssue[]): { byStep: Map<string, IssueCount>; byPort: Map<string, IssueCount> } {
  const byStep = new Map<string, IssueCount>();
  const byPort = new Map<string, IssueCount>();
  for (const issue of issues) {
    if (issue.stepId === undefined) continue;
    const step = byStep.get(issue.stepId) ?? emptyIssues();
    addIssue(step, issue);
    byStep.set(issue.stepId, step);
    if (issue.port !== undefined) {
      const key = portIssueKey(issue.stepId, issue.port);
      const port = byPort.get(key) ?? emptyIssues();
      addIssue(port, issue);
      byPort.set(key, port);
    }
  }
  return { byStep, byPort };
}

/** 步驟依賴圖的強連通元件：大小 > 1 或自我引用的步驟都在循環中。 */
export function cyclicSteps(steps: readonly WireStep[]): Set<string> {
  const ids = new Set(steps.map((step) => step.step_id));
  const deps = new Map<string, string[]>();
  for (const step of steps) {
    if (deps.has(step.step_id)) continue;
    const list: string[] = [];
    for (const binding of Object.values(step.inputs)) {
      if ("from_step" in binding && ids.has(binding.from_step)) list.push(binding.from_step);
    }
    deps.set(step.step_id, list);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let counter = 0;
  const connect = (id: string) => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const dep of deps.get(id) ?? []) {
      if (!index.has(dep)) {
        connect(dep);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(dep) ?? 0));
      } else if (onStack.has(dep)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(dep) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    const selfLoop = (deps.get(id) ?? []).includes(id);
    if (component.length > 1 || selfLoop) for (const member of component) cyclic.add(member);
  };
  for (const id of deps.keys()) if (!index.has(id)) connect(id);
  return cyclic;
}

const NOT_STARTED = new Set(["pending", "waiting", "skipped", "cancelled"]);

/** finished_at − started_at；任一缺漏、無法解析或順序異常時為 null，並說明原因。 */
export function measuredDuration(view: Pick<RunStepView, "state" | "started_at" | "finished_at">): { ms: number | null; reason: string | null } {
  const start = isoToMs(view.started_at);
  const end = isoToMs(view.finished_at);
  if (start === null) {
    if (view.started_at != null && view.started_at !== "") return { ms: null, reason: t("開始時間無法解析") };
    return { ms: null, reason: NOT_STARTED.has(view.state) ? t("未開始") : t("沒有開始時間") };
  }
  if (end === null) {
    if (view.finished_at != null && view.finished_at !== "") return { ms: null, reason: t("結束時間無法解析") };
    return { ms: null, reason: view.state === "running" ? t("尚未結束") : t("沒有結束時間") };
  }
  if (end < start) return { ms: null, reason: t("結束早於開始（時戳異常）") };
  return { ms: end - start, reason: null };
}

function stepRunInfo(stepId: string, run: WireRun): StepRunInfo {
  const known = Object.hasOwn(run.steps, stepId);
  const view = parseRunStep(stepId, run.steps[stepId]);
  const duration = measuredDuration(view);
  return {
    state: known ? view.state : "unknown",
    startedAt: view.started_at,
    finishedAt: view.finished_at,
    durationMs: duration.ms,
    durationReason: known ? duration.reason : t("run 沒有這一步的紀錄"),
    errorCode: view.error?.code ?? null,
    errorMessage: (view.error?.message ?? "") || null,
    remoteOutcomeUnknown: view.remote_outcome_unknown || view.error?.remote_outcome_unknown === true,
  };
}

function makePort(name: string, side: "in" | "out", typeId: string | null, extra: Partial<GraphPort> = {}): GraphPort {
  return {
    name,
    label: name,
    side,
    typeId,
    tone: typeTone(typeId),
    required: false,
    connected: false,
    literal: null,
    missing: false,
    danglingSource: null,
    issues: NO_ISSUES,
    description: null,
    exports: [],
    ...extra,
  };
}

function fromDescriptor(port: Port, side: "in" | "out"): GraphPort {
  return makePort(port.name, side, port.type_id || null, { required: port.required, description: port.description || null });
}

interface StepContext {
  step: WireStep;
  descriptor: ComponentDescriptor | null;
  /** 下游引用的輸出名稱（依出現順序）。 */
  referencedOutputs: string[];
  runView: RunStepView | null;
}

/** pipeline → 節點圖資料。 */
export function buildGraphModel(pipeline: WirePipeline, lookup: DescriptorLookup, options: GraphModelOptions = {}): GraphModel {
  const run = options.run ?? null;
  const { byStep, byPort } = indexIssues(options.issues ?? []);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 重複的名稱（驗證錯誤）只畫第一個，避免節點 key 衝突；問題由驗證清單回報。
  const inputs = new Map<string, Port>();
  for (const port of pipeline.inputs) if (!inputs.has(port.name)) inputs.set(port.name, port);
  const contexts = new Map<string, StepContext>();
  for (const step of pipeline.steps) {
    if (contexts.has(step.step_id)) continue;
    const descriptor = step.node_id && step.component_id ? lookup(step.node_id, step.component_id) : null;
    const runView = run && Object.hasOwn(run.steps, step.step_id) ? parseRunStep(step.step_id, run.steps[step.step_id]) : null;
    contexts.set(step.step_id, { step, descriptor, referencedOutputs: [], runView });
  }
  const reference = (stepId: string, output: string) => {
    const context = contexts.get(stepId);
    if (context && !context.referencedOutputs.includes(output)) context.referencedOutputs.push(output);
  };
  for (const { step } of contexts.values()) {
    for (const binding of Object.values(step.inputs)) if ("from_step" in binding) reference(binding.from_step, binding.output);
  }
  // 流程輸出引用的接點也要存在（元件不在目錄時由此補出接點，徽章才有位置）。
  for (const target of Object.values(pipeline.outputs)) reference(target.from_step, target.output);
  const exported = pipelineExports(pipeline, run);

  /** 步驟輸出的型別：目錄描述優先，元件不在目錄時用 run 實際輸出的 type_id。 */
  const outputType = (stepId: string, output: string): string | null => {
    const context = contexts.get(stepId);
    if (!context) return null;
    const declared = context.descriptor?.outputs.find((port) => port.name === output)?.type_id;
    if (declared != null && declared !== "") return declared;
    return context.runView?.outputs[output]?.type_id ?? null;
  };

  const { order: topo, cycle } = topoOrder(pipeline.steps);
  const cyclic = cyclicSteps(pipeline.steps);
  const stepOrder = new Map<string, number>();
  (cycle ? pipeline.steps.map((step) => step.step_id) : topo).forEach((id) => {
    if (!stepOrder.has(id)) stepOrder.set(id, stepOrder.size);
  });

  // 輸入節點。
  const usedInputs = new Set<string>();
  for (const { step } of contexts.values()) {
    for (const binding of Object.values(step.inputs)) if ("from_input" in binding) usedInputs.add(binding.from_input);
  }
  [...inputs.values()].forEach((port, index) => {
    const typeId = port.type_id || null;
    nodes.push({
      key: nodeKey("input", port.name),
      kind: "input",
      id: port.name,
      title: port.name,
      subtitle: port.required ? t("流程輸入 · 必填") : t("流程輸入 · 選填"),
      tone: typeTone(typeId),
      providerId: null,
      kindLabel: t("流程輸入"),
      componentId: null,
      componentLabel: null,
      nodeId: null,
      nodeLabel: null,
      unknownComponent: false,
      cyclic: false,
      required: port.required,
      inputs: [],
      outputs: [
        makePort(VALUE_PORT, "out", typeId, {
          label: typeId ?? t("型別未知"),
          connected: usedInputs.has(port.name),
          description: port.description || null,
        }),
      ],
      run: null,
      issues: NO_ISSUES,
      order: index,
    });
  });

  // 步驟節點與指向步驟輸入的連線。
  for (const context of contexts.values()) {
    const { step, descriptor } = context;
    const sid = step.step_id;
    const kind = providerKind(descriptor?.provider_id);
    const key = nodeKey("step", sid);
    const bindings = Object.entries(step.inputs);

    const inPorts: GraphPort[] = descriptor ? descriptor.inputs.map((port) => fromDescriptor(port, "in")) : [];
    for (const [name, binding] of bindings) {
      if (inPorts.some((port) => port.name === name)) continue;
      const typeId = "from_step" in binding ? outputType(binding.from_step, binding.output) : bindingType(binding, pipeline, lookup);
      inPorts.push(makePort(name, "in", (typeId ?? "") || null, { missing: descriptor !== null }));
    }
    const outPorts: GraphPort[] = descriptor ? descriptor.outputs.map((port) => fromDescriptor(port, "out")) : [];
    const runOutputs = context.runView ? Object.keys(context.runView.outputs) : [];
    for (const name of [...context.referencedOutputs, ...(descriptor ? [] : runOutputs)]) {
      if (outPorts.some((port) => port.name === name)) continue;
      outPorts.push(makePort(name, "out", outputType(sid, name), { missing: descriptor !== null }));
    }
    for (const port of outPorts) {
      port.connected = context.referencedOutputs.includes(port.name);
      port.exports = exported.byPort.get(exportPortKey(sid, port.name)) ?? [];
    }

    for (const port of inPorts) {
      port.issues = byPort.get(portIssueKey(sid, port.name)) ?? NO_ISSUES;
      const binding: WireBinding | undefined = step.inputs[port.name];
      if (!binding) continue;
      if ("literal" in binding) {
        port.literal = { typeId: binding.literal.type_id, file: "file" in binding.literal };
        continue;
      }
      if ("from_input" in binding) {
        const source = inputs.get(binding.from_input);
        if (!source) {
          port.danglingSource = t("pipeline 輸入 {from_input} 不存在", { from_input: binding.from_input });
          continue;
        }
        port.connected = true;
        const sourceType = source.type_id || null;
        edges.push(edge("input", nodeKey("input", source.name), VALUE_PORT, key, port.name, sourceType, port.typeId));
        continue;
      }
      if (!contexts.has(binding.from_step)) {
        port.danglingSource = t("步驟 {from_step} 不存在", { from_step: binding.from_step });
        continue;
      }
      port.connected = true;
      edges.push(edge("step", nodeKey("step", binding.from_step), binding.output, key, port.name, outputType(binding.from_step, binding.output), port.typeId));
    }

    const rawNodeLabel = step.node_id ? (options.nodeLabel?.(step.node_id) ?? null) : null;
    const nodeLabel = (rawNodeLabel != null && rawNodeLabel !== "") ? placeLabel(descriptor?.device, rawNodeLabel) : null;
    const componentId = step.component_id || null;
    nodes.push({
      key,
      kind: "step",
      id: sid,
      title: sid,
      subtitle: (componentId != null && componentId !== "") ? [componentId, nodeLabel].filter(Boolean).join(" · ") : t("尚未選擇 instance"),
      tone: descriptor ? kind.tone : "neutral",
      providerId: descriptor?.provider_id ?? null,
      kindLabel: descriptor ? kind.label : (componentId != null && componentId !== "") ? t("未知元件") : t("尚未選擇 instance"),
      componentId,
      componentLabel: (descriptor?.label ?? "") || null,
      nodeId: step.node_id || null,
      nodeLabel,
      unknownComponent: descriptor === null,
      cyclic: cyclic.has(sid),
      required: false,
      inputs: inPorts,
      outputs: outPorts,
      run: run ? stepRunInfo(sid, run) : null,
      issues: byStep.get(sid) ?? NO_ISSUES,
      order: stepOrder.get(sid) ?? stepOrder.size,
    });
  }

  return { nodes, edges, cycle, runMode: run !== null, danglingExports: exported.dangling };
}

function edge(
  kind: GraphEdge["kind"],
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
  sourceType: string | null,
  targetType: string | null,
): GraphEdge {
  const typeId = sourceType ?? targetType;
  return {
    key: `${fromNode}.${fromPort}→${toNode}.${toPort}`,
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
    typeId,
    tone: typeTone(typeId),
    kind,
    mismatch: sourceType !== null && targetType !== null && sourceType !== targetType,
  };
}

export type NodeBadgeKind = "error-code" | "remote-unknown" | "errors" | "warnings" | "unknown-component" | "cycle" | "unused";

export interface NodeBadge {
  kind: NodeBadgeKind;
  tone: Tone;
  label: string;
  /** label 是 ID／代碼（mono）。 */
  mono: boolean;
  title: string;
}

/** 卡片資訊列的標記（版面高度與畫面共用同一份，順序＝重要性）。 */
export function nodeBadges(node: GraphNode): NodeBadge[] {
  const badges: NodeBadge[] = [];
  const push = (kind: NodeBadgeKind, tone: Tone, label: string, title: string, mono = false) => badges.push({ kind, tone, label, title, mono });
  if (node.run?.errorCode != null && node.run.errorCode !== "") push("error-code", "danger", node.run.errorCode, (node.run.errorMessage != null && node.run.errorMessage !== "") ? t("{errorCode}：{errorMessage}", { errorCode: node.run.errorCode, errorMessage: tServer(node.run.errorMessage) }) : node.run.errorCode, true);
  if (node.run?.remoteOutcomeUnknown === true) push("remote-unknown", "warning", t("遠端結果未知"), t("逾時或連線中斷：Node 端是否完成未知（不自動重送）"));
  if (node.issues.errors > 0) push("errors", "danger", t("{errors} 錯誤", { errors: node.issues.errors }), node.issues.messages.join("\n"));
  if (node.issues.warnings > 0) push("warnings", "warning", t("{warnings} 警告", { warnings: node.issues.warnings }), node.issues.messages.join("\n"));
  if (node.unknownComponent && (node.componentId != null && node.componentId !== "")) push("unknown-component", "neutral", t("未知元件"), t("目錄中找不到這個元件（可能已刪除，或 Node 離線）；接點由接線推得，請改選其他 instance"));
  if (node.cyclic) push("cycle", "warning", t("循環"), t("此步驟在接線循環中（CYCLIC_PIPELINE），伺服器會拒絕"));
  if (node.kind === "input" && node.outputs[0] && !node.outputs[0].connected) push("unused", "neutral", t("未使用"), t("沒有任何步驟使用這個輸入"));
  return badges;
}

/** run 模式的步驟卡多一列「耗時」。 */
export function hasRunLine(node: GraphNode): boolean {
  return node.kind === "step" && node.run !== null;
}

export function metaRowsOf(node: GraphNode): number {
  return (hasRunLine(node) ? 1 : 0) + (nodeBadges(node).length > 0 ? 1 : 0);
}

/** run 模式的狀態文字（run 沒有這一步＝「未回報」）。 */
export function stateLabel(node: GraphNode): string | null {
  if (!node.run) return null;
  return node.run.state === "unknown" ? t("未回報") : statusSpec("step", node.run.state).label;
}

/** 「耗時 1.466 s」或「耗時 未量測（未開始）」。 */
export function durationText(node: GraphNode): string | null {
  if (!node.run) return null;
  return node.run.durationMs !== null ? t("耗時 {durationMs}", { durationMs: formatMs(node.run.durationMs) }) : t("耗時 未量測（{value}）", { value: node.run.durationReason ?? t("原因未知") });
}

export function producedText(produced: GraphExport["produced"]): string | null {
  if (produced === "yes") return t("已產生");
  if (produced === "pending") return t("尚未產生");
  if (produced === "no") return t("未產生");
  return null;
}

/** 「final（mux.asset，已產生）」：接點上的流程輸出（aria-label、title 用）。 */
export function describeExports(node: Pick<GraphNode, "id" | "outputs">): string[] {
  return node.outputs.flatMap((port) =>
    port.exports.map((item) => {
      const state = producedText(item.produced);
      return t("{name}（{id}.{name2}{value}）", { name: item.name, id: node.id, name2: port.name, value: (state != null && state !== "") ? t("，{state}", { state }) : "" });
    }),
  );
}

/** 節點的單行說明（aria-label 與 title 共用）。 */
export function describeNode(node: GraphNode, stateLabel: string | null, durationText: string | null): string {
  const parts: string[] = [];
  if (node.kind === "input") parts.push(t("流程輸入 {id}", { id: node.id }), node.outputs[0]?.typeId ?? t("型別未知"), node.required ? t("必填") : t("選填"));
  else {
    parts.push(t("步驟 {id}", { id: node.id }));
    if (node.componentId != null && node.componentId !== "") parts.push(t("元件 {componentId}{value}", { componentId: node.componentId, value: (node.nodeLabel != null && node.nodeLabel !== "") ? t("（{nodeLabel}）", { nodeLabel: node.nodeLabel }) : "" }));
    if (node.unknownComponent) parts.push(t("未知元件"));
    if (stateLabel != null && stateLabel !== "") parts.push(t("狀態 {stateLabel}", { stateLabel }));
    if (durationText != null && durationText !== "") parts.push(durationText);
    if (node.run?.errorCode != null && node.run.errorCode !== "") parts.push(t("錯誤 {errorCode}", { errorCode: node.run.errorCode }));
    if (node.run?.remoteOutcomeUnknown === true) parts.push(t("遠端結果未知"));
    if (node.cyclic) parts.push(t("在接線循環中"));
    const exports = describeExports(node);
    if (exports.length > 0) parts.push(t("流程輸出 {exports}", { exports: formatList(exports) }));
  }
  if (node.issues.errors > 0) parts.push(t("{errors} 個錯誤", { errors: node.issues.errors }));
  if (node.issues.warnings > 0) parts.push(t("{warnings} 個警告", { warnings: node.issues.warnings }));
  return formatList(parts, { separator: "，" });
}
