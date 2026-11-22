import { stringifyJson } from "../json";
// Checking a value against a JSON Schema (2020-12 subset) before it is sent: each issue has the field path and a
// zh-Hant message. Only errors the browser can see early; the server stays the authority (a pattern the browser
// cannot parse is left to it).
import { formatList } from "@/i18n/format";
import { isRecord, joinPath, valuesEqual } from "@/lib/json";
import { t } from "@/i18n";
import { isNullSchema, num, resolveSchema, typeList, variantsOf, type JsonSchema } from "./describe";

export interface SchemaIssue {
  path: string;
  message: string;
}

const MAX_DEPTH = 48;

const TYPE_LABEL: Record<string, string> = {
  string: t("字串"),
  integer: t("整數"),
  number: t("數字"),
  boolean: t("布林值"),
  object: t("物件"),
  array: t("陣列"),
  null: "null",
};

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

function shortJson(value: unknown): string {
  const text = stringifyJson(value) ?? "undefined";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function validateInto(node: unknown, value: unknown, root: JsonSchema | undefined, path: string, issues: SchemaIssue[], depth: number): void {
  if (depth > MAX_DEPTH || node === true || node === undefined || node === null) return;
  if (node === false) {
    issues.push({ path, message: t("schema 不允許此值") });
    return;
  }
  const schema = resolveSchema(node, root);
  if (!schema) return;
  const variants = variantsOf(schema);
  if (variants) {
    const resolved = variants.map((variant) => resolveSchema(variant, root)).filter((v): v is JsonSchema => v !== null);
    const passing = resolved.some((variant) => {
      const sub: SchemaIssue[] = [];
      validateInto(variant, value, root, path, sub, depth + 1);
      return sub.length === 0;
    });
    if (!passing) {
      const nonNull = resolved.filter((variant) => !isNullSchema(variant));
      const only = nonNull.length === 1 ? nonNull[0] : undefined;
      if (value === null) issues.push({ path, message: t("此欄位不允許 null") });
      else if (only) validateInto(only, value, root, path, issues, depth + 1);
      else issues.push({ path, message: t("不符合任何允許的型別") });
      return;
    }
  }
  if (Object.hasOwn(schema, "const") && !valuesEqual(schema["const"], value)) {
    issues.push({ path, message: t("必須是 {const}", { const: shortJson(schema["const"]) }) });
    return;
  }
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).some((option) => valuesEqual(option, value))) {
    const options = formatList((schema["enum"] as unknown[]).map(shortJson));
    issues.push({ path, message: t("不在 provider 允許的選項中（{options}）", { options }) });
    return;
  }
  const types = typeList(schema);
  if (types && types.length > 0 && !types.some((type) => matchesType(type, value))) {
    issues.push({ path, message: t("型別應為{map}", { map: types.map((type) => TYPE_LABEL[type] ?? type).join(t("或")) }) });
    return;
  }
  if (typeof value === "number") {
    const minimum = num(schema["minimum"]);
    const maximum = num(schema["maximum"]);
    const exclusiveMinimum = num(schema["exclusiveMinimum"]);
    const exclusiveMaximum = num(schema["exclusiveMaximum"]);
    if (minimum !== null && value < minimum) issues.push({ path, message: t("不可小於 {minimum}", { minimum }) });
    if (maximum !== null && value > maximum) issues.push({ path, message: t("不可大於 {maximum}", { maximum }) });
    if (exclusiveMinimum !== null && value <= exclusiveMinimum) issues.push({ path, message: t("必須大於 {exclusiveMinimum}", { exclusiveMinimum }) });
    if (exclusiveMaximum !== null && value >= exclusiveMaximum) issues.push({ path, message: t("必須小於 {exclusiveMaximum}", { exclusiveMaximum }) });
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    const minLength = num(schema["minLength"]);
    const maxLength = num(schema["maxLength"]);
    if (minLength !== null && length < minLength) issues.push({ path, message: minLength === 1 ? t("不可為空") : t("至少 {minLength} 個字元", { minLength }) });
    if (maxLength !== null && length > maxLength) issues.push({ path, message: t("最多 {maxLength} 個字元", { maxLength }) });
    if (typeof schema["pattern"] === "string") {
      try {
        if (!new RegExp(schema["pattern"], "u").test(value)) issues.push({ path, message: t("格式不符（{pattern}）", { pattern: schema["pattern"] }) });
      } catch {
        // The browser cannot parse the provider's pattern: the server checks it
      }
    }
  }
  if (Array.isArray(value)) {
    const minItems = num(schema["minItems"]);
    const maxItems = num(schema["maxItems"]);
    if (minItems !== null && value.length < minItems) issues.push({ path, message: t("至少 {minItems} 項", { minItems }) });
    if (maxItems !== null && value.length > maxItems) issues.push({ path, message: t("最多 {maxItems} 項", { maxItems }) });
    if (schema["uniqueItems"] === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = stringifyJson(item) ?? "";
        if (seen.has(key)) {
          issues.push({ path, message: t("項目不可重複") });
          break;
        }
        seen.add(key);
      }
    }
    if (schema["items"] !== undefined) {
      value.forEach((item: unknown, index) => { validateInto(schema["items"], item, root, joinPath(path, index), issues, depth + 1); });
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"].filter((key): key is string => typeof key === "string") : [];
    for (const key of required) {
      if (value[key] === undefined) issues.push({ path: joinPath(path, key), message: t("必填欄位") });
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (Object.hasOwn(properties, key)) validateInto(properties[key], child, root, joinPath(path, key), issues, depth + 1);
      else if (schema["additionalProperties"] === false) {
        issues.push({ path: joinPath(path, key), message: t("schema 未宣告此欄位（伺服器會以 422 拒絕）") });
      } else if (isRecord(schema["additionalProperties"])) {
        validateInto(schema["additionalProperties"], child, root, joinPath(path, key), issues, depth + 1);
      }
    }
  }
}

/** Checks a value against a schema; each issue has its field path (below basePath) and a zh-Hant message. */
export function validateValue(schema: unknown, value: unknown, root?: JsonSchema, basePath = ""): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateInto(schema, value, root, basePath, issues, 0);
  return issues;
}

/** The issues of a path itself and of everything below it. */
export function issuesUnder(issues: readonly SchemaIssue[], path: string): SchemaIssue[] {
  if (path === "") return [...issues];
  return issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`));
}
