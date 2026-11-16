// 候選預覽與差異（純函式）：與 prompt.scene_compile（prompt-compiler/1）同一套規則——
// core＝subject、action、composition、style、visible_text ∪ 有意修改 ∪ 鎖定區段；detailed＝全部 8 區段；
// 依固定區段順序取研究語言的生成文字（去頭尾空白、略過空白區段），以換行連接。
// 正式候選由元件編譯並原樣存進版本（scene_sha256 必須相符）；這裡只做編修中的即時預覽與版本間的逐區段差異。
import type { PromptCandidate, PromptScene, PromptStudyVersion, PromptVariant, SectionKey } from "../types";
import { LIMITS, SECTION_KEYS, sectionText } from "./sections";

export const CORE_SECTIONS: ReadonlySet<SectionKey> = new Set<SectionKey>(["subject", "action", "composition", "style", "visible_text"]);

export interface CompileInput {
  scene: PromptScene;
  intentional: readonly SectionKey[];
}

/** 這個候選會包含、而且有文字的區段（依固定順序）。 */
export function variantSections(input: CompileInput, variant: PromptVariant): SectionKey[] {
  const { scene, intentional } = input;
  return SECTION_KEYS.filter((key) => {
    const included = variant === "detailed" || CORE_SECTIONS.has(key) || intentional.includes(key) || scene.sections[key].locked;
    return included && sectionText(scene.sections[key], scene.prompt_language).trim().length > 0;
  });
}

export function compileVariant(input: CompileInput, variant: PromptVariant): string {
  return variantSections(input, variant)
    .map((key) => sectionText(input.scene.sections[key], input.scene.prompt_language).trim())
    .join("\n");
}

export interface PreviewCandidate {
  variant: PromptVariant;
  prompt: string;
  sections: SectionKey[];
  /** 超過 12,000 字（元件會回 PROMPT_TOO_LONG）。 */
  tooLong: boolean;
}

export function compilePreview(input: CompileInput): Record<PromptVariant, PreviewCandidate> {
  const make = (variant: PromptVariant): PreviewCandidate => {
    const prompt = compileVariant(input, variant);
    return { variant, prompt, sections: variantSections(input, variant), tooLong: Array.from(prompt).length > LIMITS.prompt };
  };
  return { core: make("core"), detailed: make("detailed") };
}

export type SectionDiffStatus = "same" | "changed" | "added" | "removed";

export interface SectionDiffRow {
  key: SectionKey;
  status: SectionDiffStatus;
  /** 之前這個候選裡的文字（不包含時為 null）。 */
  before: string | null;
  after: string | null;
}

function includedText(input: CompileInput, variant: PromptVariant): Map<SectionKey, string> {
  return new Map(variantSections(input, variant).map((key) => [key, sectionText(input.scene.sections[key], input.scene.prompt_language).trim()]));
}

/**
 * 同一種候選在兩個場景之間的逐區段差異（例如已儲存版本 → 草稿、上一版 → 這一版）。
 * before 為 null（沒有可比的版本）時，所有包含的區段都是 added。兩邊都不包含的區段不列出。
 */
export function candidateDiff(before: CompileInput | null, after: CompileInput, variant: PromptVariant): SectionDiffRow[] {
  const left = before ? includedText(before, variant) : new Map<SectionKey, string>();
  const right = includedText(after, variant);
  const rows: SectionDiffRow[] = [];
  for (const key of SECTION_KEYS) {
    const a = left.get(key) ?? null;
    const b = right.get(key) ?? null;
    if (a === null && b === null) continue;
    const status: SectionDiffStatus = a === b ? "same" : a === null ? "added" : b === null ? "removed" : "changed";
    rows.push({ key, status, before: a, after: b });
  }
  return rows;
}

/** 差異統計（列表與分頁標籤用）。 */
export function diffCounts(rows: readonly SectionDiffRow[]): Record<SectionDiffStatus, number> {
  const counts: Record<SectionDiffStatus, number> = { same: 0, changed: 0, added: 0, removed: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** detailed 比 core 多出來的區段（core 與 detailed 文字相同時為空）。 */
export function detailedOnlySections(input: CompileInput): SectionKey[] {
  const core = new Set(variantSections(input, "core"));
  return variantSections(input, "detailed").filter((key) => !core.has(key));
}

export function candidateOf(version: PromptStudyVersion | null | undefined, variant: PromptVariant): PromptCandidate | null {
  return version?.candidates.items.find((candidate) => candidate.variant === variant) ?? null;
}

/** 依 prompt_sha256 去重（core 優先）：兩個候選文字相同時只生成一次（與 phasyn_qimg.prompting.compiler.unique_candidates 相同）。 */
export function uniqueCandidates(candidates: readonly PromptCandidate[]): PromptCandidate[] {
  const seen = new Set<string>();
  const ordered = [...candidates].sort((a, b) => (a.variant === b.variant ? 0 : a.variant === "core" ? -1 : 1));
  return ordered.filter((candidate) => {
    if (seen.has(candidate.prompt_sha256)) return false;
    seen.add(candidate.prompt_sha256);
    return true;
  });
}

/** 版本中存的候選是否與本頁的預覽規則一致（元件用了不同的編譯器時要讓使用者知道，預覽不能當真）。 */
export function previewAgrees(version: PromptStudyVersion): boolean {
  const input = { scene: version.scene, intentional: version.intentional_changes };
  return version.candidates.items.every((candidate) => candidate.prompt === compileVariant(input, candidate.variant));
}
