// 設定草稿：區段 schema（provider 宣告，必要時退回契約）、patch 計算、精度欄位與前端檢查。
import type { InstanceSettings, Part, SettingsView } from "@/api/generated/contracts";
import { CONTRACT_ROOT, RECORDER_CONFIG_SCHEMA } from "@/lib/contractSchemas";
import { isRecord, type JsonObject } from "@/lib/json";
import { diffToPatch } from "@/lib/merge";
import { hasDeclaredProperties, objectProperties, propertySchema, describeField, validateValue, type JsonSchema, type SchemaIssue } from "@/lib/schema";
import { analyzeRules, ruleBlockingErrors } from "./partsModel";
import { t, tServer } from "@/i18n";

export const SETTINGS_ROOTS = ["load", "invoke", "recording"] as const;
export type SettingsRoot = (typeof SETTINGS_ROOTS)[number];

export interface SectionSchema {
  schema: unknown;
  root: JsonSchema | undefined;
  /** provider 自己宣告（false＝退回契約或沒有欄位）。 */
  fromProvider: boolean;
}

function asSchema(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

/** 三個設定區的 schema：load／invoke 用 provider 宣告；recording 由 Recorder 管理，provider 未宣告欄位時用契約 RecorderConfig。 */
export function sectionSchemas(view: Pick<SettingsView, "settings_schema">): Record<SettingsRoot, SectionSchema> {
  const providerRoot = asSchema(view.settings_schema);
  const load = providerRoot ? propertySchema(providerRoot, "load", providerRoot) : null;
  const invoke = providerRoot ? propertySchema(providerRoot, "invoke", providerRoot) : null;
  const recording = providerRoot ? propertySchema(providerRoot, "recording", providerRoot) : null;
  return {
    load: isRecord(load) || load === true
      ? { schema: load, root: providerRoot, fromProvider: true }
      : { schema: { $ref: "#/$defs/LoadSettings" }, root: CONTRACT_ROOT, fromProvider: false },
    invoke: isRecord(invoke) || invoke === true ? { schema: invoke, root: providerRoot, fromProvider: true } : { schema: { type: "object" }, root: undefined, fromProvider: false },
    recording:
      (isRecord(recording) || recording === true) && hasDeclaredProperties(recording, providerRoot) && objectProperties(recording, providerRoot).length > 0
        ? { schema: recording, root: providerRoot, fromProvider: true }
        : { schema: RECORDER_CONFIG_SCHEMA, root: CONTRACT_ROOT, fromProvider: false },
  };
}

export interface PrecisionFieldSpec {
  key: string;
  label: string;
  meaning: string;
}

/** 精度不是一個 dtype：各欄位獨立。 */
export const PRECISION_FIELDS: readonly PrecisionFieldSpec[] = [
  { key: "weight_format", label: t("權重格式"), meaning: t("checkpoint 形式（原 dtype 或量化 packing），不代表 compute dtype") },
  { key: "weight_dtype", label: t("權重 dtype"), meaning: t("裝置上保存的 tensor dtype；packed 量化另記 scheme／group_size／scale dtype") },
  { key: "compute_dtype", label: t("運算 dtype"), meaning: t("運算輸入／autocast 選擇") },
  { key: "autocast_dtype", label: "autocast", meaning: t("null＝關閉；不代表所有 operator 都是同一精度") },
  { key: "accumulation_dtype", label: t("累加精度"), meaning: t("null＝未知或由 provider native 處理；backend 無法控制時只讀") },
  { key: "matmul_tf32", label: "matmul TF32", meaning: t("matmul 的 TF32；與 cuDNN TF32 分開控制與記錄") },
  { key: "cudnn_tf32", label: "cuDNN TF32", meaning: t("conv／cuDNN 的 TF32") },
  { key: "reduced_precision_reduction", label: t("低精度 reduction"), meaning: t("FP16／BF16 reduction（backend 支援時）") },
  { key: "output_dtype", label: t("輸出 dtype"), meaning: t("實際 wire 輸出；不能為省空間而改原始 final latent") },
  { key: "quantization", label: t("量化"), meaning: t("量化 scheme、group size、scale dtype 等") },
];

/** provider 未宣告某精度欄位時的原因（provider 可在 precision schema 以 x-unavailable／x-unsupported 標註；固定文字經 tServer 翻譯）。 */
export function precisionUnavailableReason(precisionSchema: unknown, root: JsonSchema | undefined, field: string): string {
  if (precisionSchema === null || precisionSchema === undefined) return t("provider schema 沒有宣告 load.precision");
  const info = describeField(precisionSchema, root);
  for (const key of ["x-unavailable", "x-unsupported", "x-unsupported-reasons"]) {
    const map = info.schema[key];
    if (isRecord(map) && typeof map[field] === "string" && map[field]) return tServer(map[field]);
  }
  return t("provider schema 沒有宣告此欄位：此 provider 沒有實作，送出會被 422 拒絕");
}

export interface SettingsPatchPlan {
  patch: JsonObject | undefined;
  removedPaths: string[];
}

/** 只送 load／invoke／recording 三根的最小 merge patch。 */
export function settingsPatch(base: InstanceSettings, draft: InstanceSettings): SettingsPatchPlan {
  const patch: JsonObject = {};
  const removedPaths: string[] = [];
  for (const root of SETTINGS_ROOTS) {
    const diff = diffToPatch(base[root], draft[root], root);
    if (diff.patch) patch[root] = diff.patch;
    removedPaths.push(...diff.removedPaths);
  }
  return { patch: Object.keys(patch).length > 0 ? patch : undefined, removedPaths };
}

/** 草稿的前端檢查：各區 schema + 子部件規則（0 命中、不被接受的欄位）。 */
export function settingsIssues(view: Pick<SettingsView, "settings_schema">, parts: readonly Part[], draft: InstanceSettings): SchemaIssue[] {
  const sections = sectionSchemas(view);
  const issues: SchemaIssue[] = [];
  for (const root of SETTINGS_ROOTS) {
    const section = sections[root];
    issues.push(...validateValue(section.schema, draft[root], section.root, root));
  }
  const rules = draft.load.part_overrides ?? [];
  analyzeRules(parts, rules).forEach((analysis) => {
    for (const message of ruleBlockingErrors(analysis)) issues.push({ path: `load.part_overrides[${String(analysis.index)}]`, message });
    // 與 Node 端 validate_part_values 一致：命中 part 可接受的欄位，其值也要符合該 part 的 schema（enum／型別）。
    const settings = rules[analysis.index]?.settings;
    if (analysis.matched.length > 0 && isRecord(settings)) {
      const schema = { type: "object", properties: analysis.fieldSchemas };
      issues.push(...validateValue(schema, settings, undefined, `load.part_overrides[${String(analysis.index)}].settings`));
    }
  });
  return issues;
}

/** observed 的精度值：provider 可放在 observed.load.precision、observed.precision 或 observed 頂層。 */
export function observedPrecision(observed: unknown, field: string): { present: boolean; value: unknown; reason: string | null } {
  if (!isRecord(observed)) return { present: false, value: undefined, reason: null };
  const candidates: unknown[] = [
    isRecord(observed["load"]) && isRecord(observed["load"]["precision"]) ? observed["load"]["precision"] : undefined,
    isRecord(observed["precision"]) ? observed["precision"] : undefined,
    observed,
  ];
  let reason: string | null = null;
  const reasonKeys = [`${field}_reason`];
  for (const source of candidates) {
    if (!isRecord(source)) continue;
    for (const key of reasonKeys) if (typeof source[key] === "string") reason = source[key];
    if (isRecord(source["reasons"]) && typeof source["reasons"][field] === "string") reason = source["reasons"][field];
  }
  if (reason === null && typeof observed["reason"] === "string") reason = observed["reason"];
  for (const source of candidates) {
    if (isRecord(source) && Object.hasOwn(source, field)) return { present: true, value: source[field], reason };
  }
  return { present: false, value: undefined, reason };
}
