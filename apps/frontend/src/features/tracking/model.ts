// Pure logic of the tracking (recorder / recording settings) page: row model, filtering and grouping, drafts and changed
// fields, bulk patch planning and per-row results.
// Write semantics: a PATCH carries only the changed recording fields (objects merge,
// arrays are replaced whole) plus expected_revision; nothing is resent automatically and REVISION_CONFLICT is left to the
// user to reload. Recording changes apply from the next call without a restart.
import type { ComponentEntry, NodeLiveness, NodeView } from "@/api/catalog";
import type { ComponentDescriptor, SettingsView } from "@/api/generated/contracts";
import { CONTRACT_ROOT, RECORDER_CONFIG_SCHEMA } from "@/lib/contractSchemas";
import { domId } from "@/lib/dom";
import { toErrorInfo, writeOutcomeUnknown } from "@/lib/errors";
import { isRecord, valuesEqual, type JsonObject } from "@/lib/json";
import { applyMergePatch, diffToPatch } from "@/lib/merge";
import { schemaDefaults, validateValue, type SchemaIssue } from "@/lib/schema";
import { sectionSchemas } from "@/features/components";
import { t } from "@/i18n";

export const RECORDER_MODES = ["off", "summary", "detailed", "trace"] as const;
export type RecorderMode = (typeof RECORDER_MODES)[number];
export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;

/** mode 只改變量測，不改模型精度、batch、compile 或步數。 */
export const MODE_INFO: Record<RecorderMode, { label: string; hint: string }> = {
  off: { label: "off", hint: t("只留基本結果、錯誤、設定快照與 wall time（量紀錄成本用）") },
  summary: { label: "summary", hint: t("生命週期、phase、copy 計數、記憶體峰值、每 step 摘要；無原始 span") },
  detailed: { label: t("detailed（預設）"), hint: t("summary＋每 step／part 聚合、copy 事件、CUDA event 時間") },
  trace: { label: "trace", hint: t("detailed＋指定 step 的 torch.profiler trace；成本高，手動開啟") },
};

export type ToggleKey = "gpu_event_timing" | "capture_prompt";

/**
 * 表格內可直接切換的開關（其他欄位在右側檢視器）。capture_stderr 不在這裡：Node 一律擷取 stderr，
 * 這個欄位目前不影響行為（見 lib/recorderSupport.ts）。
 */
export const TOGGLE_FIELDS: ReadonlyArray<{ key: ToggleKey; short: string; label: string }> = [
  { key: "gpu_event_timing", short: "GPU", label: t("GPU event 計時") },
  { key: "capture_prompt", short: "prompt", label: t("記錄 prompt") },
];

/** 契約 RecorderConfig 的預設值；mode 未保存時 Node 以 detailed 補齊（phasyn_components.settings.normalize_recording）。 */
export const RECORDER_DEFAULTS: Readonly<JsonObject> = { mode: "detailed", ...schemaDefaults(RECORDER_CONFIG_SCHEMA, CONTRACT_ROOT) };

/** 表格會用到的 recorder 值（已保存值補上預設值）。mode 保留原字串：不在允許清單時照實顯示。 */
export interface RecorderValues {
  mode: string;
  gpu_event_timing: boolean;
  capture_prompt: boolean;
  log_level: string;
  trace_steps: unknown[];
  trace_parts: unknown[];
  record_shapes: boolean;
  with_stack: boolean;
}

function bool(record: JsonObject, key: string): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  return RECORDER_DEFAULTS[key] === true;
}

function list(record: JsonObject, key: string): unknown[] {
  const value = record[key];
  if (Array.isArray(value)) return value;
  const fallback = RECORDER_DEFAULTS[key];
  return Array.isArray(fallback) ? fallback : [];
}

function text(record: JsonObject, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  const fallback = RECORDER_DEFAULTS[key];
  return typeof fallback === "string" ? fallback : "";
}

export function recorderValues(recording: unknown): RecorderValues {
  const record = isRecord(recording) ? recording : {};
  return {
    mode: text(record, "mode"),
    gpu_event_timing: bool(record, "gpu_event_timing"),
    capture_prompt: bool(record, "capture_prompt"),
    log_level: text(record, "log_level"),
    trace_steps: list(record, "trace_steps"),
    trace_parts: list(record, "trace_parts"),
    record_shapes: bool(record, "record_shapes"),
    with_stack: bool(record, "with_stack"),
  };
}

export interface TrackingRow {
  key: string;
  nodeId: string;
  nodeLabel: string;
  liveness: NodeLiveness;
  /** Node 非 online：資料可能過時、寫入無法送達。 */
  stale: boolean;
  componentId: string;
  label: string;
  providerId: string;
  runtimeId: string;
  state: ComponentDescriptor["state"];
  recorderState: ComponentDescriptor["recorder_state"];
  /** test.* provider：測試元件／合成示例。 */
  test: boolean;
  revision: number;
  /** 目錄快照與本頁最近讀到／寫回的設定中，stored_revision 較新的那份。 */
  view: SettingsView;
  /** 已保存的 recording（原樣）。 */
  stored: JsonObject;
  values: RecorderValues;
  descriptor: ComponentDescriptor;
}

/** 目錄快照可能比本頁剛寫入的結果舊（Node 每數秒才上報）：以 stored_revision 較新者為準，同 revision 時用本頁讀到的那份。 */
export function newestView(catalogView: SettingsView, local: SettingsView | undefined): SettingsView {
  if (!local) return catalogView;
  return local.stored_revision >= catalogView.stored_revision ? local : catalogView;
}

export function buildRows(entries: readonly ComponentEntry[], local: ReadonlyMap<string, SettingsView>): TrackingRow[] {
  return entries.map((entry) => {
    const d = entry.descriptor;
    const view = newestView(d.settings, local.get(entry.key));
    const stored = isRecord(view.stored.recording) ? (view.stored.recording as unknown as JsonObject) : {};
    return {
      key: entry.key,
      nodeId: entry.node.node_id,
      nodeLabel: entry.node.label,
      liveness: entry.node.liveness,
      stale: entry.node.stale,
      componentId: d.component_id,
      label: d.label || d.component_id,
      providerId: d.provider_id,
      runtimeId: d.runtime_id,
      state: d.state,
      recorderState: d.recorder_state,
      test: d.provider_id.startsWith("test."),
      revision: view.stored_revision,
      view,
      stored,
      values: recorderValues(stored),
      descriptor: d,
    };
  });
}

/** 每列穩定的焦點錨點（元件名稱按鈕）：儲存／還原後按鈕消失時把焦點移回這裡。 */
export function rowAnchorId(key: string): string {
  return domId("tracking-row", key);
}

/** 檢視器的「儲存」按鈕：從檢視器重新讀取後（按鈕所在的提示消失時）焦點的穩定落點。 */
export const RECORDER_SAVE_ID = "recorder-inspector-save";

// ------------------------------------------------------------------ 篩選與分組

export interface TrackingFilters {
  q: string;
  node: string;
  mode: string;
}

// URL state: filters are q, in (Node, same as the Components page) and mode; the inspector selection is node + component
// (same as /admin/components).
const FILTER_PARAM: Record<keyof TrackingFilters, string> = { q: "q", node: "in", mode: "mode" };

export function filtersFromParams(params: URLSearchParams): TrackingFilters {
  return { q: params.get("q") ?? "", node: params.get("in") ?? "", mode: params.get("mode") ?? "" };
}

export interface TrackingSelection {
  nodeId: string;
  componentId: string;
}

export function selectionFromParams(params: URLSearchParams): TrackingSelection | null {
  const nodeId = params.get("node");
  const componentId = params.get("component");
  return nodeId && componentId ? { nodeId, componentId } : null;
}

/** 修改篩選（空字串＝移除；未列出的鍵不變），保留選取。 */
export function withFilterParams(params: URLSearchParams, changes: Partial<TrackingFilters>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Object.keys(FILTER_PARAM) as Array<keyof TrackingFilters>) {
    const value = changes[key];
    if (value === undefined) continue;
    if (value) next.set(FILTER_PARAM[key], value);
    else next.delete(FILTER_PARAM[key]);
  }
  return next;
}

/** 檢視器選取的元件（null＝清除），保留篩選。 */
export function withSelectionParams(params: URLSearchParams, selection: TrackingSelection | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (selection) {
    next.set("node", selection.nodeId);
    next.set("component", selection.componentId);
  } else {
    next.delete("node");
    next.delete("component");
  }
  return next;
}

/** 以已保存（伺服器）值篩選，不用草稿值：編輯中的列不會因篩選條件而消失。 */
export function rowMatches(row: TrackingRow, filters: TrackingFilters): boolean {
  if (filters.node && row.nodeId !== filters.node) return false;
  if (filters.mode && row.values.mode !== filters.mode) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  return [row.componentId, row.label, row.providerId, row.runtimeId, row.nodeLabel].some((value) => value.toLowerCase().includes(q));
}

export interface TrackingGroup {
  node: NodeView;
  rows: TrackingRow[];
  /** 篩選前該 Node 的元件數。 */
  total: number;
}

export function groupRows(nodes: readonly NodeView[], rows: readonly TrackingRow[], filters: TrackingFilters): TrackingGroup[] {
  return nodes
    .filter((node) => !filters.node || node.node_id === filters.node)
    .map((node) => {
      const all = rows.filter((row) => row.nodeId === node.node_id);
      return { node, rows: all.filter((row) => rowMatches(row, filters)), total: all.length };
    })
    .sort((a, b) => Number(a.node.stale) - Number(b.node.stale) || a.node.label.localeCompare(b.node.label, "zh-Hant"));
}

// ------------------------------------------------------------------ 選取

export type SelectionState = "none" | "some" | "all";

export function selectionState(selected: ReadonlySet<string>, keys: readonly string[]): SelectionState {
  if (keys.length === 0) return "none";
  const count = keys.filter((key) => selected.has(key)).length;
  return count === 0 ? "none" : count === keys.length ? "all" : "some";
}

export function setSelected(selected: ReadonlySet<string>, keys: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

// ------------------------------------------------------------------ 草稿

/** 單列草稿：base／baseRevision 是開始編輯時的已保存值（儲存時 expected_revision 用它）。 */
export interface RowDraft {
  baseRevision: number;
  base: JsonObject;
  value: JsonObject;
}

export type Drafts = Readonly<Record<string, RowDraft>>;

/** 草稿的最小 recording patch（只含變更欄位）與 merge patch 無法表達的「移除欄位」。 */
export function draftPatch(draft: RowDraft): { patch: JsonObject | undefined; removedPaths: string[] } {
  return diffToPatch(draft.base, draft.value, "recording");
}

/** 變更的頂層欄位（例如 mode、trace_steps）。 */
export function changedKeys(draft: RowDraft | undefined): string[] {
  if (!draft) return [];
  return Object.keys(draftPatch(draft).patch ?? {});
}

function finalize(baseRevision: number, base: JsonObject, value: JsonObject): RowDraft | undefined {
  const diff = diffToPatch(base, value);
  if (!diff.patch && diff.removedPaths.length === 0) return undefined;
  return { baseRevision, base, value };
}

/**
 * 修改單一欄位：已保存值沒有這個欄位、而新值等於契約預設時移除該欄位（避免「改回預設」也產生 patch）。
 * 沒有任何差異時回傳 undefined（草稿消失）。
 */
export function setDraftField(row: TrackingRow, draft: RowDraft | undefined, key: string, next: unknown): RowDraft | undefined {
  const base = draft?.base ?? row.stored;
  const value: JsonObject = { ...(draft?.value ?? row.stored) };
  if (!Object.hasOwn(base, key) && Object.hasOwn(RECORDER_DEFAULTS, key) && valuesEqual(next, RECORDER_DEFAULTS[key])) delete value[key];
  else value[key] = next;
  return finalize(draft?.baseRevision ?? row.revision, base, value);
}

/** 以整份 recording 取代草稿（檢視器的表單／JSON）。 */
export function replaceDraftValue(row: TrackingRow, draft: RowDraft | undefined, value: JsonObject): RowDraft | undefined {
  return finalize(draft?.baseRevision ?? row.revision, draft?.base ?? row.stored, value);
}

/** 重新讀取後把「我的變更」套到最新版上；與最新版相同時草稿消失。 */
export function rebaseDraft(draft: RowDraft, latest: SettingsView): RowDraft | undefined {
  const base = isRecord(latest.stored.recording) ? (latest.stored.recording as unknown as JsonObject) : {};
  const mine = draftPatch(draft).patch;
  const value = mine ? (applyMergePatch(base, mine) as JsonObject) : base;
  return finalize(latest.stored_revision, base, value);
}

/** 草稿目前值補上預設值（表格顯示用）。 */
export function draftValues(row: TrackingRow, draft: RowDraft | undefined): RecorderValues {
  return draft ? recorderValues(draft.value) : row.values;
}

/** 以 provider（或契約 RecorderConfig）schema 檢查 recording；路徑以 recording. 開頭。 */
export function recordingIssues(view: Pick<SettingsView, "settings_schema">, value: unknown): SchemaIssue[] {
  const section = sectionSchemas(view).recording;
  return validateValue(section.schema, value, section.root, "recording");
}

/** 有問題的頂層 recording 欄位（例如 recording.trace_steps[2] → trace_steps）：檢視器據此展開對應區段。 */
export function issueFieldKeys(issues: readonly SchemaIssue[]): Set<string> {
  const keys = new Set<string>();
  for (const issue of issues) {
    if (!issue.path.startsWith("recording.")) continue;
    const key = issue.path.slice("recording.".length).split(/[.[]/)[0];
    if (key) keys.add(key);
  }
  return keys;
}

// ------------------------------------------------------------------ 批次規劃

export interface BulkValues {
  mode?: string;
  gpu_event_timing?: boolean;
  capture_prompt?: boolean;
  log_level?: string;
}

export const BULK_KEYS = ["mode", "gpu_event_timing", "capture_prompt", "log_level"] as const;

export function hasBulkValues(values: BulkValues): boolean {
  return BULK_KEYS.some((key) => values[key] !== undefined);
}

export interface PatchItem {
  key: string;
  nodeId: string;
  componentId: string;
  label: string;
  expectedRevision: number;
  /** 只含變更欄位的 recording patch。 */
  recording: JsonObject;
  fields: string[];
}

export interface PlanSkip {
  key: string;
  label: string;
  /** 短標籤（表格內）與完整原因（title／說明）。 */
  short: string;
  reason: string;
}

export interface PatchPlan {
  send: PatchItem[];
  skipped: PlanSkip[];
}

/**
 * 「套用到選取的 N 個元件」：每個元件一個 PATCH（依表格順序、依序送出），只送和目前已保存值不同的欄位。
 * 略過：Node 離線、該列有未儲存的草稿（避免把草稿一起送出）、沒有任何變更。
 */
export function planBulk(rows: readonly TrackingRow[], keys: readonly string[], values: BulkValues, drafts: Drafts): PatchPlan {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const plan: PatchPlan = { send: [], skipped: [] };
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) continue;
    if (row.stale) {
      plan.skipped.push({ key, label: row.label, short: t("Node 離線"), reason: t("Node 離線或資料過時：寫入無法送達，未送出") });
      continue;
    }
    if (drafts[key]) {
      plan.skipped.push({ key, label: row.label, short: t("有未儲存變更"), reason: t("此列有未儲存的變更：請先儲存或還原，批次套用不會一併送出草稿") });
      continue;
    }
    const recording: JsonObject = {};
    for (const field of BULK_KEYS) {
      const next = values[field];
      if (next === undefined || valuesEqual(row.values[field], next)) continue;
      recording[field] = next;
    }
    const fields = Object.keys(recording);
    if (fields.length === 0) {
      plan.skipped.push({ key, label: row.label, short: t("無變更"), reason: t("已是指定的值，未送出") });
      continue;
    }
    plan.send.push({ key, nodeId: row.nodeId, componentId: row.componentId, label: row.label, expectedRevision: row.revision, recording, fields });
  }
  return plan;
}

/** 儲存草稿：expected_revision 用草稿開始時的 revision；有前端檢查問題或 Node 離線時不送。 */
export function planDraftSaves(rows: readonly TrackingRow[], drafts: Drafts, keys: readonly string[]): PatchPlan {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const plan: PatchPlan = { send: [], skipped: [] };
  for (const key of keys) {
    const row = byKey.get(key);
    const draft = drafts[key];
    if (!row || !draft) continue;
    if (row.stale) {
      plan.skipped.push({ key, label: row.label, short: t("Node 離線"), reason: t("Node 離線或資料過時：寫入無法送達，草稿保留") });
      continue;
    }
    const issues = recordingIssues(row.view, draft.value);
    if (issues.length > 0) {
      plan.skipped.push({ key, label: row.label, short: t("{issuesCount} 個問題", { issuesCount: issues.length }), reason: t("有 {issuesCount} 個欄位問題（伺服器會以 422 拒絕）：先在右側檢視器修正", { issuesCount: issues.length }) });
      continue;
    }
    const patch = draftPatch(draft).patch;
    if (!patch) {
      plan.skipped.push({ key, label: row.label, short: t("無法表達"), reason: t("草稿只有移除欄位：PATCH 不會刪除欄位（伺服器保留原值）") });
      continue;
    }
    plan.send.push({
      key,
      nodeId: row.nodeId,
      componentId: row.componentId,
      label: row.label,
      expectedRevision: draft.baseRevision,
      recording: patch,
      fields: Object.keys(patch),
    });
  }
  return plan;
}

// ------------------------------------------------------------------ 逐列結果

export type RowResult =
  | { status: "queued" }
  | { status: "pending" }
  | { status: "saved"; revision: number; fields: string[] }
  | { status: "skipped"; short: string; reason: string }
  | { status: "conflict"; message: string }
  | { status: "failed"; code: string; message: string; hint: string | null; outcomeUnknown: boolean }
  | { status: "stopped" }
  | { status: "reloading" };

export type ResultStatus = RowResult["status"];

export function initialResults(plan: PatchPlan): Record<string, RowResult> {
  const out: Record<string, RowResult> = {};
  for (const item of plan.send) out[item.key] = { status: "queued" };
  for (const skip of plan.skipped) out[skip.key] = { status: "skipped", short: skip.short, reason: skip.reason };
  return out;
}

/** 409 REVISION_CONFLICT → 已被更新（請重新讀取）；連線中斷或 504 → 遠端結果未知；其他照錯誤碼顯示。不自動重送。 */
export function resultFromError(error: unknown): RowResult {
  const info = toErrorInfo(error);
  if (info.code === "REVISION_CONFLICT") return { status: "conflict", message: info.message };
  return { status: "failed", code: info.code, message: info.message, hint: info.hint, outcomeUnknown: writeOutcomeUnknown(error) };
}

export function resultCounts(results: Readonly<Record<string, RowResult>>): Record<ResultStatus, number> {
  const counts: Record<ResultStatus, number> = { queued: 0, pending: 0, saved: 0, skipped: 0, conflict: 0, failed: 0, stopped: 0, reloading: 0 };
  for (const result of Object.values(results)) counts[result.status] += 1;
  return counts;
}

/** 批次摘要（aria-live）：「已儲存 3 · 已被更新 1 · 失敗 1 · 略過 2」。 */
export function resultSummary(counts: Record<ResultStatus, number>): string {
  const parts: string[] = [];
  if (counts.saved) parts.push(t("已儲存 {saved}", { saved: counts.saved }));
  if (counts.conflict) parts.push(t("已被更新 {conflict}", { conflict: counts.conflict }));
  if (counts.failed) parts.push(t("失敗 {failed}", { failed: counts.failed }));
  if (counts.stopped) parts.push(t("未送出 {stopped}", { stopped: counts.stopped }));
  if (counts.skipped) parts.push(t("略過 {skipped}", { skipped: counts.skipped }));
  return parts.join(" · ");
}

// ------------------------------------------------------------------ 顯示

function compactList(values: readonly unknown[], max = 4): string {
  const shown = values.slice(0, max).map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)));
  return values.length > max ? t("{shown}…（共 {valuesCount}）", { shown: shown.join(","), valuesCount: values.length }) : shown.join(",");
}

/** trace 設定摘要；mode≠trace 時標為不生效（profiler 只在 trace 模式啟動）。 */
export function traceSummary(values: RecorderValues): { text: string; active: boolean; title: string } {
  const steps = values.trace_steps.length === 0 ? t("全部 step") : `step ${compactList(values.trace_steps)}`;
  const flags = [values.record_shapes ? "shapes" : null, values.with_stack ? "stack" : null].filter(Boolean);
  const text = [steps, ...flags].join(" · ");
  const active = values.mode === "trace";
  const detail = [
    t("trace_steps：{value}", { value: values.trace_steps.length === 0 ? t("全部") : compactList(values.trace_steps, 32) }),
    t("trace_parts：{value}（尚未實作：不影響 trace）", { value: values.trace_parts.length === 0 ? t("全部") : compactList(values.trace_parts, 32) }),
    t("record_shapes：{record_shapes}", { record_shapes: String(values.record_shapes) }),
    t("with_stack：{with_stack}", { with_stack: String(values.with_stack) }),
  ].join("\n");
  return { text, active, title: active ? detail : t("{detail}\n目前不是 trace 模式：這些設定不生效", { detail }) };
}
