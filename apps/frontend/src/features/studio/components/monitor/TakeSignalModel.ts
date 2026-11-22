import { componentUsable, findComponent } from "@/api/catalog";
import type { Catalog, FileRef } from "@/api/generated/contracts";
import { asTypedValue, type WirePipeline, type WireRun } from "@/api/types";
import { makeLookup, readinessText, validatePipeline } from "@/features/pipelines";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

export const SIGNAL_PIPELINE = "prepare-control-and-review-local";

const providers = { report: "media.take_analysis", evidence: "media.take_analysis", control: "media.edge_control" } as const;

/** A saved graph may refer to different Node/instance IDs; check the actual configured outputs and bindings. */
export function setupIssue(graph: WirePipeline, catalog: Catalog): string | null {
  const source = graph.inputs.find((port) => port.name === "video");
  if (source?.type_id !== "media.video.v1" || source.transport === "inline" || graph.inputs.some((p) => p.required && p.name !== "video")) {
    return t("這個檢查流程必須能以一個 video 影片檔執行。");
  }
  const reached = new Set<string>();
  for (const [port, provider] of Object.entries(providers)) {
    const output = graph.outputs[port];
    const step = graph.steps.find((entry) => entry.step_id === output?.from_step);
    const binding = step?.inputs["video"];
    if (!step || output?.output !== port || !binding || !("from_input" in binding) || binding.from_input !== "video") {
      return t("輸出 {port} 必須直接使用選取的影片。", { port });
    }
    const entry = findComponent(catalog, step.node_id, step.component_id);
    if (!entry) return t("Node {node} 找不到元件 {component}。", { node: step.node_id, component: step.component_id });
    if (entry.descriptor.provider_id !== provider) return t("元件 {component} 必須提供 {provider}。", { component: step.component_id, provider });
    if (entry.node.stale || !componentUsable(entry.descriptor)) return `${step.component_id} · ${readinessText(entry)}`;
    reached.add(step.step_id);
  }
  if (reached.size !== graph.steps.length || reached.size !== 2) return t("請讓這個流程只執行影片檢查與輪廓擷取兩個步驟。");
  return validatePipeline(graph, makeLookup(catalog)).find((issue) => issue.severity === "error")?.message ?? null;
}

export function matchesReview(run: WireRun, note: string, file: FileRef): boolean {
  const input = run.request.inputs["video"];
  return run.request.pipeline.pipeline_id === SIGNAL_PIPELINE && run.request.origin?.note === note
    && input?.type_id === "media.video.v1" && "file" in input && input.file.sha256 === file.sha256;
}

export function outputFile(run: WireRun, name: string, typeId: string, mime: string): FileRef | null {
  const out = asTypedValue(run.outputs[name]);
  return out?.type_id === typeId && "file" in out && out.file.media_type === mime ? out.file : null;
}

export interface Finding {
  kind: "black" | "freeze";
  start_frame: number;
  end_frame: number;
  start_seconds: number;
  end_seconds: number;
  evidence_frame: number;
  evidence_tile: number | null;
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value) || (value["kind"] !== "black" && value["kind"] !== "freeze")) return false;
  const { start_frame: start, end_frame: end, start_seconds: first, end_seconds: last, evidence_frame: frame, evidence_tile: tile } = value;
  return typeof start === "number" && Number.isSafeInteger(start) && start >= 0 && typeof end === "number" && Number.isSafeInteger(end) && end > start
    && typeof first === "number" && Number.isFinite(first) && first >= 0 && typeof last === "number" && Number.isFinite(last) && last > first
    && typeof frame === "number" && Number.isSafeInteger(frame) && frame >= start && frame < end
    && (tile === null || (typeof tile === "number" && Number.isSafeInteger(tile) && tile >= 0));
}

export function findingsOf(value: unknown, source: FileRef, evidence: FileRef): Finding[] {
  if (!isRecord(value) || value["schema"] !== "media.take_analysis.v1" || value["source_sha256"] !== source.sha256
    || !isRecord(value["evidence"]) || value["evidence"]["sha256"] !== evidence.sha256 || value["evidence"]["file_id"] !== evidence.file_id
    || !Array.isArray(value["findings"]) || !value["findings"].every(isFinding)) {
    throw new Error(t("報告與這個 Take 或證據圖不符。"));
  }
  return value["findings"];
}
