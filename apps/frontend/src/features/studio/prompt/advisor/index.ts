// 「Prompt 修正與建議」的對外介面：純分析引擎（analyzePrompt）、規則目錄、範本、改寫指令與兩個元件
// （PromptAdvisorPanel：專業 Prompt 編輯器的側欄分頁；PromptAdvisorBadge：行內編輯器工具列的徽章與它的浮層）。
// 設計與依據：。
export { analyzePrompt, countBySeverity, findingKey, keyFindings, sortFindings, type KeyedFinding } from "./analyze";
export { RULE_IDS, RULES, type RuleId, type RuleMeta } from "./catalog";
export { copyText } from "./clipboard";
export { diffHunks, diffLines, diffStats, type DiffHunk, type DiffLine } from "@/lib/textDiff";
export { EXAMPLE_LABEL, EXAMPLE_NOTE, GUIDE_EXAMPLES, type GuideExample } from "./examples";
export { labelPlan, type LabelPlan, type ReferenceLabel } from "./labels";
export { scanPrompt, type FieldName, type PromptScan, type Section, type Segment, type ShotMarker, type TimeHeading } from "./parse";
export { PromptAdvisorBadge, type PromptAdvisorBadgeProps } from "./PromptAdvisorBadge";
export { PromptAdvisorPanel, type PromptAdvisorPanelProps } from "./PromptAdvisorPanel";
export { buildRewriteRequest, OFFICIAL_GUIDE_URLS, REWRITE_INSTRUCTION } from "./rewrite";
export { baseTemplate, I2VA_ALIGNMENT_LINE, promptTemplates, ref2vaTemplate, templateHint, timelineSkeleton, type PromptTemplate } from "./templates";
export { alignFrames, clipTiming, formatCueTime, H3_FPS, parseCueTime, type ClipTiming } from "./timing";
export * as advisorTransforms from "./transforms";
export {
  BASIS_DESCRIPTION,
  BASIS_LABEL,
  MODE_LABEL,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type AnalyzeInput,
  type Basis,
  type Finding,
  type FindingFix,
  type PromptMode,
  type Severity,
  type TextRange,
} from "./types";
