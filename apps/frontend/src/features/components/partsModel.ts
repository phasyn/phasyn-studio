// 子部件：parts 樹、part_overrides 規則分析（命中、重疊、可接受欄位）與展開預覽。
// 與 Node 端 resolve_parts 一致：selector 為 exact 或 fnmatchcase；依序套用、後者覆蓋前者；
// part 的 settings_schema 沒有 properties 時不接受任何覆寫欄位。
import type { Part, PartOverride } from "@/api/generated/contracts";
import { matchSelector } from "@/lib/fnmatch";
import { isRecord, type JsonObject } from "@/lib/json";
import { applyMergePatch } from "@/lib/merge";
import { t } from "@/i18n";

export interface PartNode {
  segment: string;
  path: string;
  part: Part | null;
  children: PartNode[];
}

/** 以 '.' 拆 path 建樹；中間節點不是 part 時 part=null（群組）。 */
export function buildPartTree(parts: readonly Part[]): PartNode[] {
  const roots: PartNode[] = [];
  const index = new Map<string, PartNode>();
  for (const part of parts) {
    const segments = part.path.split(".");
    let siblings = roots;
    let path = "";
    segments.forEach((segment, depth) => {
      path = depth === 0 ? segment : `${path}.${segment}`;
      let node = index.get(path);
      if (!node) {
        node = { segment, path, part: null, children: [] };
        index.set(path, node);
        siblings.push(node);
      }
      if (depth === segments.length - 1) node.part = part;
      siblings = node.children;
    });
  }
  return roots;
}

export function countLeaves(node: PartNode): number {
  return (node.part ? 1 : 0) + node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function acceptedFields(part: Part): Set<string> {
  const properties = isRecord(part.settings_schema) ? part.settings_schema["properties"] : undefined;
  return new Set(isRecord(properties) ? Object.keys(properties) : []);
}

export interface RuleOverlap {
  earlier: number;
  paths: string[];
  /** 兩條規則都設定的欄位（後者覆蓋前者）。 */
  fields: string[];
}

export interface RuleAnalysis {
  index: number;
  selector: string;
  matched: string[];
  selectorError: string | null;
  /** 所有命中 part 都接受的欄位（交集）；命中 0 個時為空。 */
  accepted: string[];
  /** 欄位 → schema（取第一個命中且宣告該欄位的 part）。 */
  fieldSchemas: Record<string, unknown>;
  /** 規則中被至少一個命中 part 拒絕的欄位。 */
  rejected: { field: string; parts: string[] }[];
  overlaps: RuleOverlap[];
}

export function analyzeRules(parts: readonly Part[], rules: readonly PartOverride[]): RuleAnalysis[] {
  const paths = parts.map((part) => part.path);
  const byPath = new Map(parts.map((part) => [part.path, part]));
  const results: RuleAnalysis[] = [];
  rules.forEach((rule, index) => {
    const check = matchSelector(rule.selector, paths);
    const matched = check.matched ?? [];
    const matchedParts = matched.map((path) => byPath.get(path)).filter((part): part is Part => part !== undefined);
    const sets = matchedParts.map(acceptedFields);
    const accepted = sets.length === 0 ? [] : [...(sets[0] ?? new Set<string>())].filter((field) => sets.every((set) => set.has(field)));
    const fieldSchemas: Record<string, unknown> = {};
    for (const field of accepted) {
      for (const part of matchedParts) {
        const properties = isRecord(part.settings_schema) ? part.settings_schema["properties"] : undefined;
        if (isRecord(properties) && Object.hasOwn(properties, field)) {
          fieldSchemas[field] = properties[field];
          break;
        }
      }
    }
    const settings = isRecord(rule.settings) ? rule.settings : {};
    const rejected = Object.keys(settings)
      .filter((field) => settings[field] !== undefined)
      .map((field) => ({ field, parts: matchedParts.filter((part) => !acceptedFields(part).has(field)).map((part) => part.path) }))
      .filter((item) => item.parts.length > 0);
    const overlaps: RuleOverlap[] = [];
    results.forEach((earlier) => {
      const shared = earlier.matched.filter((path) => matched.includes(path));
      if (shared.length === 0) return;
      const earlierSettings = rules[earlier.index]?.settings ?? {};
      const fields = Object.keys(settings).filter((field) => Object.hasOwn(earlierSettings, field));
      overlaps.push({ earlier: earlier.index, paths: shared, fields });
    });
    results.push({ index, selector: rule.selector, matched, selectorError: check.error, accepted, fieldSchemas, rejected, overlaps });
  });
  return results;
}

/** 阻擋儲存的錯誤（伺服器一定會以 422 拒絕）。 */
export function ruleBlockingErrors(analysis: RuleAnalysis): string[] {
  if (analysis.selectorError != null && analysis.selectorError !== "") return [analysis.selectorError];
  const errors: string[] = [];
  if (analysis.matched.length === 0) errors.push(t("selector「{selector}」沒有命中任何子部件", { selector: analysis.selector }));
  for (const item of analysis.rejected) errors.push(t("欄位 {field} 不被 {partsCount} 個命中的 part 接受（例如 {value}）", { field: item.field, partsCount: item.parts.length, value: item.parts[0] ?? "" }));
  return errors;
}

export interface ExpandedPart {
  path: string;
  settings: JsonObject;
  /** 欄位 → 最後設定它的規則 index（null＝來自 instance 共用精度設定）。 */
  sources: Record<string, number | null>;
}

/** 展開預覽：先套 instance 共用 precision（只取該 part 接受的欄位），再依序套規則。 */
export function expandParts(parts: readonly Part[], basePrecision: unknown, rules: readonly PartOverride[]): ExpandedPart[] {
  const base = isRecord(basePrecision) ? basePrecision : {};
  const analyses = analyzeRules(parts, rules);
  return parts.map((part) => {
    const accepted = acceptedFields(part);
    let settings: JsonObject = {};
    const sources: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(base)) {
      if (accepted.has(key) && value !== undefined) {
        settings[key] = value;
        sources[key] = null;
      }
    }
    analyses.forEach((analysis) => {
      if (!analysis.matched.includes(part.path)) return;
      const ruleSettings = rules[analysis.index]?.settings;
      if (!isRecord(ruleSettings)) return;
      settings = applyMergePatch(settings, ruleSettings);
      for (const key of Object.keys(ruleSettings)) sources[key] = analysis.index;
    });
    return { path: part.path, settings, sources };
  });
}
