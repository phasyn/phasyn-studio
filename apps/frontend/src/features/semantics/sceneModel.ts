// SceneDocument 編修：觀測事實（entities／events／camera／unknowns）與 generation_edits 分開；
// 檢查事件時間不超出 duration、證據與主體 ID 存在。資料錯誤會阻擋「另存新 Scene」，但沒有 reviewed／approved 旗標。
import type { ComponentDescriptor, FileRef, SceneDocument, SceneEvent } from "@/api/generated/contracts";
import type { WirePipeline, WireRun, WireTypedValue } from "@/api/types";
import { asTypedValueMap, runSteps } from "@/api/types";
import { localIdError, uniqueName } from "@/lib/ids";
import { isRecord } from "@/lib/json";
import { describeField, objectProperties } from "@/lib/schema";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface SceneIssue {
  path: string;
  message: string;
}

export function sceneIssues(scene: SceneDocument): SceneIssue[] {
  const issues: SceneIssue[] = [];
  if (!(scene.duration_seconds > 0)) issues.push({ path: "duration_seconds", message: t("duration 必須大於 0") });
  const entityIds = scene.entities.map((entity) => entity.entity_id);
  const frameIds = new Set(scene.evidence.map((frame) => frame.frame_id));
  scene.entities.forEach((entity, index) => {
    const error = localIdError(entity.entity_id, "entity_id ");
    if (error != null && error !== "") issues.push({ path: `entities[${String(index)}].entity_id`, message: error });
    if (entityIds.indexOf(entity.entity_id) !== index) issues.push({ path: `entities[${String(index)}].entity_id`, message: t("entity_id 重複：{entity_id}", { entity_id: entity.entity_id }) });
  });
  const eventIds = scene.events.map((event) => event.event_id);
  scene.events.forEach((event, index) => {
    const base = `events[${String(index)}]`;
    const error = localIdError(event.event_id, "event_id ");
    if (error != null && error !== "") issues.push({ path: `${base}.event_id`, message: error });
    if (eventIds.indexOf(event.event_id) !== index) issues.push({ path: `${base}.event_id`, message: t("event_id 重複：{event_id}", { event_id: event.event_id }) });
    if (!Number.isFinite(event.start_seconds) || event.start_seconds < 0) issues.push({ path: `${base}.start_seconds`, message: t("開始時間必須 ≥ 0") });
    if (!Number.isFinite(event.end_seconds) || event.end_seconds < event.start_seconds) issues.push({ path: `${base}.end_seconds`, message: t("結束時間不可早於開始") });
    if (event.end_seconds > scene.duration_seconds) issues.push({ path: `${base}.end_seconds`, message: t("超出影片長度 {duration_seconds} s", { duration_seconds: scene.duration_seconds }) });
    for (const id of event.entity_ids) if (!entityIds.includes(id)) issues.push({ path: `${base}.entity_ids`, message: t("主體 {id} 不存在", { id }) });
    for (const id of event.evidence_frame_ids) if (!frameIds.has(id)) issues.push({ path: `${base}.evidence_frame_ids`, message: t("證據幀 {id} 不存在", { id }) });
    if (!event.description.trim()) issues.push({ path: `${base}.description`, message: t("事件描述不可為空") });
  });
  return issues;
}

export function newEvent(scene: SceneDocument): SceneEvent {
  const id = uniqueName("e", new Set(scene.events.map((event) => event.event_id)));
  const end = Math.min(scene.duration_seconds, 1);
  return { event_id: id, entity_ids: [], start_seconds: 0, end_seconds: end, description: "", evidence_frame_ids: [], certainty: "observed" };
}

export function newEntityId(scene: SceneDocument): string {
  return uniqueName("entity", new Set(scene.entities.map((entity) => entity.entity_id)));
}

/** run 中第一個指定型別的值（run 輸出優先，其次各步驟輸出）。 */
export function findRunValue(run: WireRun | undefined, typeId: string): WireTypedValue | null {
  if (!run) return null;
  const fromOutputs = Object.values(asTypedValueMap(run.outputs)).find((value) => value.type_id === typeId);
  if (fromOutputs) return fromOutputs;
  for (const step of runSteps(run)) {
    const found = Object.values(step.outputs).find((value) => value.type_id === typeId);
    if (found) return found;
  }
  return null;
}

/** run 請求中的來源影片（反推 run 的輸入）。 */
export function findRunInputFile(run: WireRun | undefined, typeId: string): { type_id: string; file: FileRef } | null {
  if (!run) return null;
  for (const value of Object.values(asTypedValueMap(run.request.inputs))) {
    if (value.type_id === typeId && "file" in value) return { type_id: typeId, file: value.file };
  }
  return null;
}

/** 單一元件、單一步驟的流程（輸入名稱固定，輸出列出元件的全部輸出）。 */
export function singleStepPipeline(
  pipelineId: string,
  label: string,
  stepId: string,
  descriptor: ComponentDescriptor,
  inputName: string,
  inputType: string,
  parameters: Record<string, unknown>,
): WirePipeline | null {
  const port = descriptor.inputs.find((candidate) => candidate.type_id === inputType);
  if (!port) return null;
  const outputs: WirePipeline["outputs"] = {};
  for (const output of descriptor.outputs) outputs[output.name] = { from_step: stepId, output: output.name };
  return {
    pipeline_id: pipelineId,
    label,
    inputs: [{ name: inputName, type_id: inputType, required: true, transport: port.transport, description: port.description || inputName }],
    steps: [{ step_id: stepId, node_id: descriptor.node_id, component_id: descriptor.component_id, inputs: { [port.name]: { from_input: inputName } }, parameters }],
    outputs,
  };
}

/** 依 parameters_schema 預填：schema 有 default 用 default，否則用工作流程建議值；schema 沒宣告的欄位不填。 */
export function suggestedParameters(descriptor: ComponentDescriptor | null, suggestions: Record<string, unknown>): Record<string, unknown> {
  if (!descriptor) return {};
  const schema = descriptor.settings.parameters_schema;
  const root = isRecord(schema) ? schema : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, property] of objectProperties(schema, root)) {
    if (!Object.hasOwn(suggestions, key)) continue;
    const info = describeField(property, root);
    out[key] = info.hasDefault ? info.defaultValue : suggestions[key];
  }
  return out;
}

export type SplitChoice = "auto" | "train" | "validation" | "test";

export interface DatasetRow {
  key: string;
  sample_id: string;
  source: FileRef;
  caption: string;
  source_group: string;
  split: SplitChoice;
}

/**
 * dataset.export 的輸入文件（phasyn_components/providers/dataset.py 接受此形式與純陣列）：
 * { schema_version, format, rows: [{ sample_id, source, caption, source_group, split|null }] }；split=null 表示交給元件依來源群組切分。
 */
export function datasetRowsDocument(rows: readonly DatasetRow[]): Record<string, unknown> {
  return {
    schema_version: "4.0",
    format: "video_text_pairs",
    rows: rows.map((row) => ({
      sample_id: row.sample_id,
      source: row.source,
      caption: row.caption,
      source_group: row.source_group,
      split: row.split === "auto" ? null : row.split,
    })),
  };
}

/** 匯出前的警告（不阻擋）：來源群組太少、明確 split 造成空集合、樣本很少。 */
export function datasetWarnings(rows: readonly DatasetRow[]): string[] {
  const warnings: string[] = [];
  if (rows.length === 0) return warnings;
  const groups = new Set(rows.map((row) => row.source_group));
  if (groups.size < 2) warnings.push(t("只有 1 個來源群組：依來源分組時無法切出不洩漏的驗證集"));
  if (rows.length < 10) warnings.push(t("只有 {rowsCount} 筆樣本：訓練／驗證集會非常小", { rowsCount: rows.length }));
  const explicit = rows.filter((row) => row.split !== "auto");
  if (explicit.length === rows.length) {
    for (const split of ["train", "validation"] as const) {
      if (!rows.some((row) => row.split === split)) warnings.push(t("所有列都明確指定 split，但 {split} 為空", { split }));
    }
  }
  const crossSplit = [...groups].filter((group) => new Set(rows.filter((row) => row.source_group === group && row.split !== "auto").map((row) => row.split)).size > 1);
  if (crossSplit.length > 0) warnings.push(t("來源群組 {crossSplit} 被明確指定到不同 split：同源片段可能洩漏到驗證集", { crossSplit: formatList(crossSplit) }));
  return warnings;
}

export interface SplitCounts {
  train: number;
  validation: number;
  test: number;
}

/** 匯出結果 manifest 的 split 統計與警告（空 split 或樣本很少只警告）。 */
export function manifestSplitSummary(manifest: unknown): { counts: SplitCounts; total: number; warnings: string[] } | null {
  if (!isRecord(manifest) || !Array.isArray(manifest["items"])) return null;
  const counts: SplitCounts = { train: 0, validation: 0, test: 0 };
  for (const item of manifest["items"]) {
    if (isRecord(item) && (item["split"] === "train" || item["split"] === "validation" || item["split"] === "test")) counts[item["split"]] += 1;
  }
  const total = manifest["items"].length;
  const warnings: string[] = [];
  if (counts.train === 0) warnings.push(t("train 為空"));
  if (counts.validation === 0) warnings.push(t("validation 為空"));
  if (total > 0 && total < 10) warnings.push(t("只有 {total} 筆樣本", { total }));
  return { counts, total, warnings };
}
