import { stringifyJson } from "../json";
// Which control a schema field gets and what it shows: the control kind, select options, the one-line scalar list
// and the short range text. Pure functions, so the form's choices are tested without rendering.
import { isListed, displayText, isRecord, previewValue, valuesEqual } from "@/lib/json";
import { t } from "@/i18n";
import { describeField, type FieldInfo, type JsonSchema } from "./describe";

/** The kind of form control (SchemaField renders by it). */
export type ControlKind = "fixed" | "null-only" | "select" | "switch" | "number" | "text" | "list" | "json";

export interface ControlOptions {
  required: boolean;
  /** The field may be cleared (for example call parameters, part overrides). */
  allowUnset: boolean;
  value: unknown;
}

const SCALAR_ITEM_KINDS = ["string", "integer", "number"] as const;

/**
 * An array of scalars (strings, integers or numbers, possibly an enum) can be edited as one comma-separated line;
 * returns the item kind, else null. A current value with non-scalars or strings containing commas cannot be shown
 * losslessly, so it falls back to JSON.
 */
export function scalarListItemKind(info: FieldInfo, value: unknown, root?: JsonSchema): "string" | "integer" | "number" | null {
  if (info.kind !== "array" || !isRecord(info.schema["items"])) return null;
  const item = describeField(info.schema["items"], root);
  let kind: "string" | "integer" | "number" | null = null;
  if (item.nullable) return null;
  if (isListed(item.kind, SCALAR_ITEM_KINDS)) kind = item.kind;
  else if (item.kind === "enum" && item.enumValues.every((option) => typeof option === "string")) kind = "string";
  if (kind === null) return null;
  if (value === undefined || value === null) return kind;
  if (!Array.isArray(value)) return null;
  const token = (entry: string) => entry.length > 0 && entry.trim() === entry && !entry.includes(",");
  const representable = value.every((entry) =>
    kind === "string" ? typeof entry === "string" && token(entry) : typeof entry === "number" || (typeof entry === "string" && token(entry)),
  );
  return representable ? kind : null;
}

/** Picks the control for a field description; only a genuinely complex shape falls back to JSON. */
export function controlKind(info: FieldInfo, options: ControlOptions, root?: JsonSchema): ControlKind {
  switch (info.kind) {
    case "const":
      return "fixed";
    case "null":
      return "null-only";
    case "enum":
      return "select";
    case "boolean":
      // A boolean that is not required always gets the three-way select (unset / true / false): replacing the control
      // after the first choice would lose the focus.
      return info.nullable || options.allowUnset || !options.required || options.value === undefined ? "select" : "switch";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "text";
    case "array":
      return scalarListItemKind(info, options.value, root) ? "list" : "json";
    case "json":
    case "object":
    default:
      return "json";
  }
}

export const UNSET_OPTION = "__phasyn_unset__";
export const CURRENT_OPTION = "__phasyn_current__";

export interface SelectOption {
  key: string;
  label: string;
  kind: "unset" | "null" | "current" | "value";
  value: unknown;
}

function optionKey(value: unknown): string {
  return stringifyJson(value) ?? "null";
}

/**
 * A select's options: "unset" (the field is absent and the provider default applies), "not set (null)" when nullable,
 * a current value outside the allowed list (kept and shown, never silently changed), then the schema's options.
 */
export function selectModel(info: FieldInfo, value: unknown, options: { canUnset: boolean }): { options: SelectOption[]; selected: string } {
  const values: unknown[] = info.kind === "boolean" ? [true, false] : info.enumValues;
  const inOptions = values.some((option) => valuesEqual(option, value));
  const selected =
    value === undefined ? UNSET_OPTION : value === null && info.nullable ? optionKey(null) : inOptions ? optionKey(value) : CURRENT_OPTION;
  const out: SelectOption[] = [];
  if (value === undefined || options.canUnset) {
    out.push({
      key: UNSET_OPTION,
      kind: "unset",
      value: undefined,
      label: info.hasDefault ? t("不指定（provider 預設：{defaultValue}）", { defaultValue: displayText(info.defaultValue) }) : t("不指定"),
    });
  }
  if (info.nullable) out.push({ key: optionKey(null), kind: "null", value: null, label: t("未設定（null）") });
  if (selected === CURRENT_OPTION) {
    out.push({ key: CURRENT_OPTION, kind: "current", value, label: t("目前值 {previewValue}（不在 schema 允許清單）", { previewValue: previewValue(value, 40) }) });
  }
  for (const option of values) {
    out.push({
      key: optionKey(option),
      kind: "value",
      value: option,
      label: info.kind === "boolean" ? (option === true ? t("true（啟用）") : t("false（停用）")) : displayText(option),
    });
  }
  return { options: out, selected };
}

/** 2^53−1: the integer upper bound the contracts use for "no actual limit"; not shown. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/** A short range and format text (for example "範圍 0–20", "最小 100"); null without limits. */
export function rangeSummary(info: FieldInfo): string | null {
  const parts: string[] = [];
  const maximum = info.maximum !== null && info.maximum < NO_LIMIT ? info.maximum : null;
  if (info.minimum !== null && maximum !== null) parts.push(t("範圍 {minimum}–{maximum}", { minimum: info.minimum, maximum }));
  else if (info.minimum !== null) parts.push(t("最小 {minimum}", { minimum: info.minimum }));
  else if (maximum !== null) parts.push(t("最大 {maximum}", { maximum }));
  if (info.exclusiveMinimum !== null) parts.push(t("須 > {exclusiveMinimum}", { exclusiveMinimum: info.exclusiveMinimum }));
  if (info.exclusiveMaximum !== null) parts.push(t("須 < {exclusiveMaximum}", { exclusiveMaximum: info.exclusiveMaximum }));
  if (info.maxLength !== null && info.maxLength < 1000) parts.push(t("最多 {maxLength} 字元", { maxLength: info.maxLength }));
  if (info.pattern != null && info.pattern !== "") parts.push(t("格式 {pattern}", { pattern: info.pattern }));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Comma-separated text → array; a number item that does not parse stays a string (the schema check flags it, nothing is silently changed). */
export function parseScalarList(text: string, kind: "string" | "integer" | "number"): unknown[] {
  return text
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      if (kind === "string") return token;
      const parsed = Number(token);
      return Number.isFinite(parsed) ? parsed : token;
    });
}

export function formatScalarList(value: unknown): string {
  return Array.isArray(value) ? value.map((entry) => displayText(entry)).join(", ") : "";
}
