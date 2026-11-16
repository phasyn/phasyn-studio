// 場景編修（純函式）：8 區段的文字、說明、證據、鎖定與「有意修改」標記；資料檢查；修訂結果的鎖定核對。
// 規則（與 phasyn_qimg.prompting.scene 相同）：有意修改的區段一定是鎖定區段——標記有意修改時一併鎖定，
// 解除鎖定時一併取消有意修改；自動修訂（qimg.vision revise）必須逐字保留鎖定區段與它引用的觀察（由元件執行，
// 這裡只核對並照實顯示）。
import { stableStringify, valuesEqual } from "@/lib/json";
import type { PromptScene, PromptSceneSection, PromptStudyVersion, SectionKey } from "../types";
import { LIMITS, SECTION_KEYS, sectionLabel, sectionText } from "./sections";
import { t } from "@/i18n";

export interface EditorDraft {
  /** 編修的起點版本。 */
  versionId: string;
  scene: PromptScene;
  intentional: SectionKey[];
  note: string;
  /** 起點版本的 (scene, intentional) 指紋：判斷有沒有修改。 */
  baseFingerprint: string;
}

export interface SceneIssue {
  /** 屬於哪個區段；null＝整份場景。 */
  section: SectionKey | null;
  message: string;
}

function sortedSections(keys: readonly SectionKey[]): SectionKey[] {
  return SECTION_KEYS.filter((key) => keys.includes(key));
}

export function sceneFingerprint(scene: PromptScene, intentional: readonly SectionKey[]): string {
  return stableStringify([scene, sortedSections(intentional)]);
}

export function draftFromVersion(version: PromptStudyVersion): EditorDraft {
  return {
    versionId: version.version_id,
    scene: structuredClone(version.scene),
    intentional: sortedSections(version.intentional_changes),
    note: "",
    baseFingerprint: sceneFingerprint(version.scene, version.intentional_changes),
  };
}

/** 場景或有意修改有變動（不含備註）。 */
export function draftChanged(draft: EditorDraft | null): boolean {
  return draft !== null && sceneFingerprint(draft.scene, draft.intentional) !== draft.baseFingerprint;
}

/** 有未儲存的內容（場景、有意修改或備註）。 */
export function draftDirty(draft: EditorDraft | null): boolean {
  return draft !== null && (draftChanged(draft) || draft.note.trim() !== "");
}

function withSection(draft: EditorDraft, key: SectionKey, change: (section: PromptSceneSection) => PromptSceneSection): EditorDraft {
  const section = draft.scene.sections[key];
  const next = change(section);
  if (next === section) return draft;
  return { ...draft, scene: { ...draft.scene, sections: { ...draft.scene.sections, [key]: next } } };
}

/** 生成用文字：研究語言為 zh-TW 時改 text_zh_tw，否則改 text_en。 */
export function setSectionText(draft: EditorDraft, key: SectionKey, text: string): EditorDraft {
  const field = draft.scene.prompt_language === "zh-TW" ? "text_zh_tw" : "text_en";
  return withSection(draft, key, (section) => (section[field] === text ? section : { ...section, [field]: text }));
}

export function setExplanation(draft: EditorDraft, key: SectionKey, text: string): EditorDraft {
  return withSection(draft, key, (section) => (section.explanation_zh_tw === text ? section : { ...section, explanation_zh_tw: text }));
}

/** 鎖定／解除鎖定；解除時一併取消這個區段的有意修改（有意修改必須鎖定）。 */
export function setLocked(draft: EditorDraft, key: SectionKey, locked: boolean): EditorDraft {
  const next = withSection(draft, key, (section) => (section.locked === locked ? section : { ...section, locked }));
  if (locked || !next.intentional.includes(key)) return next;
  return { ...next, intentional: next.intentional.filter((item) => item !== key) };
}

/** 標記／取消有意修改；標記時一併鎖定（之後的自動修訂會逐字保留它，比較時以它為目標）。 */
export function setIntentional(draft: EditorDraft, key: SectionKey, on: boolean): EditorDraft {
  if (!on) return draft.intentional.includes(key) ? { ...draft, intentional: draft.intentional.filter((item) => item !== key) } : draft;
  const locked = withSection(draft, key, (section) => (section.locked ? section : { ...section, locked: true }));
  return locked.intentional.includes(key) ? locked : { ...locked, intentional: sortedSections([...locked.intentional, key]) };
}

/** 引用／取消引用一筆觀察作為這個區段的證據。 */
export function setEvidence(draft: EditorDraft, key: SectionKey, observationId: string, on: boolean): EditorDraft {
  return withSection(draft, key, (section) => {
    const has = section.observation_ids.includes(observationId);
    if (has === on) return section;
    return { ...section, observation_ids: on ? [...section.observation_ids, observationId] : section.observation_ids.filter((id) => id !== observationId) };
  });
}

export function setNote(draft: EditorDraft, note: string): EditorDraft {
  return draft.note === note ? draft : { ...draft, note };
}

/** 與起點版本不同的區段（文字、說明、證據或鎖定）。 */
export function changedSections(draft: EditorDraft, base: PromptScene): SectionKey[] {
  return SECTION_KEYS.filter((key) => !valuesEqual(draft.scene.sections[key], base.sections[key]));
}

/** 資料檢查（人工版本的規則，與 prompt.scene_compile 的檢查一致）：主體不可空白、長度上限、證據引用存在且屬於同一區段、有意修改必須鎖定。 */
export function sceneIssues(scene: PromptScene, intentional: readonly SectionKey[], note = ""): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const language = scene.prompt_language;
  if (!sectionText(scene.sections.subject, language).trim()) {
    issues.push({ section: "subject", message: t("{text}不可空白：需要{value}生成文字", { text: sectionLabel("subject"), value: language === "zh-TW" ? t("繁體中文") : t("英文") }) });
  }
  if (scene.observations.length === 0) issues.push({ section: null, message: t("場景至少要有一筆觀察") });
  const observations = new Map(scene.observations.map((item) => [item.id, item]));
  if (observations.size !== scene.observations.length) issues.push({ section: null, message: t("觀察的 id 重複") });
  for (const key of SECTION_KEYS) {
    const section = scene.sections[key];
    const label = sectionLabel(key);
    if (section.text_en.length > LIMITS.text || section.text_zh_tw.length > LIMITS.text) issues.push({ section: key, message: t("{label}的文字超過 {text} 字", { label, text: LIMITS.text }) });
    if (section.explanation_zh_tw.length > LIMITS.explanation) issues.push({ section: key, message: t("{label}的說明超過 {explanation} 字", { label, explanation: LIMITS.explanation }) });
    for (const id of section.observation_ids) {
      const observation = observations.get(id);
      if (!observation) issues.push({ section: key, message: t("{label}引用不存在的觀察 {id}", { label, id }) });
      else if (observation.section !== key) issues.push({ section: key, message: t("{label}引用了屬於{section}的觀察 {id}", { label, section: sectionLabel(observation.section), id }) });
    }
  }
  for (const key of intentional) {
    if (!scene.sections[key].locked) issues.push({ section: key, message: t("{key}標記為有意修改，但沒有鎖定", { key: sectionLabel(key) }) });
  }
  if (note.length > LIMITS.note) issues.push({ section: null, message: t("版本備註超過 {note} 字", { note: LIMITS.note }) });
  return issues;
}

function sameContent(a: PromptSceneSection, b: PromptSceneSection): boolean {
  return a.text_en === b.text_en && a.text_zh_tw === b.text_zh_tw && a.explanation_zh_tw === b.explanation_zh_tw && valuesEqual(a.observation_ids, b.observation_ids);
}

/**
 * 修訂結果的鎖定核對：前一版鎖定的區段（與它引用的觀察）在修訂後是否逐字相同。
 * 元件（qimg.vision revise）負責保留；這裡只核對，不一致時列出區段讓使用者知道（不修改已編譯的場景）。
 */
export function lockViolations(previous: PromptScene, next: PromptScene): SectionKey[] {
  const before = new Map(previous.observations.map((item) => [item.id, item]));
  const after = new Map(next.observations.map((item) => [item.id, item]));
  return SECTION_KEYS.filter((key) => {
    const old = previous.sections[key];
    if (!old.locked) return false;
    if (!sameContent(old, next.sections[key]) || !next.sections[key].locked) return true;
    return old.observation_ids.some((id) => !valuesEqual(before.get(id), after.get(id)));
  });
}

/** 依比較修訂時給視覺模型的固定指示（與 phasyn_qimg.prompting.evaluation.REFINE_FROM_COMPARISON_INSTRUCTION 相同）。 */
export const REVISION_INSTRUCTION = "只優先修正比較中前三個可見差異，遵循凍結意圖並逐字保留所有鎖定區段及其證據。";
