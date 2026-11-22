// 規則共用的分析脈絡與建立 finding 的小工具（嚴重度、依據與出處一律取自 catalog.ts）。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { RULES, type RuleId } from "../catalog";
import type { LabelPlan } from "../labels";
import type { LabelHit, PromptScan, Section } from "../parse";
import type { PromptRules } from "../../../model/providerTraits";
import type { ClipTiming } from "../timing";
import type { Finding, FindingFix, PromptMode, TextRange } from "../types";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface RuleContext {
  text: string;
  scan: PromptScan;
  /** null＝未知。 */
  mode: PromptMode | null;
  /** 有首幀（I2VA）。 */
  firstFrame: boolean;
  /** null＝鏡頭長度未知。 */
  timing: ClipTiming | null;
  plan: LabelPlan;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 路線的 prompt 規則（H3 路線才會跑到規則模組）。 */
  rules: PromptRules;
}

export function finding(
  id: RuleId,
  fields: { title: string; detail: string; range?: TextRange | null; fix?: FindingFix | null; action?: FindingFix | null },
): Finding {
  const meta = RULES[id];
  const out: Finding = { id, severity: meta.severity, basis: meta.basis, source: meta.source, title: fields.title, detail: fields.detail };
  if (fields.range) out.range = { start: fields.range.start, end: fields.range.end };
  if (fields.fix) out.fix = fields.fix;
  if (fields.action) out.action = fields.action;
  return out;
}

/** 列出前幾個（「A、B、C 等 5 處」）。 */
export function listSome(items: readonly string[], max = 4): string {
  const unique = [...new Set(items)];
  const shown = formatList(unique.slice(0, max));
  return unique.length > max ? t("{shown} 等 {uniqueCount} 項", { shown, uniqueCount: unique.length }) : shown;
}

/** 文字片段（截斷到 n 個字，單行）。 */
export function excerpt(text: string, max = 24): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** H3 標籤的寫法：<Picture 1>。 */
export function labelText(label: LabelHit): string {
  return `<${label.tag} ${String(label.ordinal)}>`;
}

/** offset 在這個欄位的內容裡。 */
export function inSection(section: Section | undefined, offset: number): boolean {
  return section !== undefined && offset >= section.bodyStart && offset < section.end;
}
