// 8 區段的名稱、權重與「生成用文字」：與 phasyn_qimg.prompting（scene.section_text、evaluation.WEIGHTS）一致。純資料與純函式。
import { SECTION_KEYS, type MetricLabel, type PromptLanguage, type PromptSceneSection, type PromptVariant, type SectionKey } from "../types";
import { t } from "@/i18n";

export { SECTION_KEYS };

export const SECTION_LABELS: Record<SectionKey, string> = {
  subject: t("主體"),
  // 場景區段「動作」＝畫面裡的動作（motion），不是介面上的「動作」選單：用 context 區分譯文
  action: t("動作", undefined, { context: "motion" }),
  composition: t("構圖"),
  environment: t("環境"),
  lighting: t("光線"),
  appearance: t("外觀與材質"),
  style: t("風格"),
  visible_text: t("可見文字"),
};

/** 評分權重（evaluation.py WEIGHTS）。 */
export const SECTION_WEIGHTS: Record<SectionKey, number> = {
  subject: 3,
  action: 2,
  composition: 3,
  environment: 1,
  lighting: 1,
  appearance: 2,
  style: 2,
  visible_text: 3,
};

/** 判斷 → 扣分（evaluation.py PENALTIES）；uncertain／not_applicable 不可判斷，不計入。 */
export const LABEL_PENALTY: Partial<Record<MetricLabel, number>> = { match: 0, minor: 1, major: 2, missing: 3 };

export const METRIC_LABELS: Record<MetricLabel, string> = {
  match: t("符合"),
  minor: t("小差異"),
  major: t("明顯差異"),
  missing: t("缺少"),
  uncertain: t("不確定"),
  not_applicable: t("不適用"),
};

export const VARIANT_LABELS: Record<PromptVariant, string> = { core: t("核心 core"), detailed: t("詳細 detailed") };

export const LANGUAGE_LABELS: Record<PromptLanguage, string> = { "zh-TW": t("繁體中文"), en: t("英文") };

/** 區段文字上限（與主控的研究文件檢查相同）。 */
export const LIMITS = {
  text: 2400,
  explanation: 1200,
  note: 1000,
  instruction: 2000,
  acceptNote: 1000,
  title: 120,
  /** 編譯後的 prompt（Unicode 字元）。 */
  prompt: 12000,
} as const;

/** 只回傳研究語言的生成文字（不拿說明或另一種語言補）。 */
export function sectionText(section: PromptSceneSection, language: PromptLanguage): string {
  return language === "zh-TW" ? section.text_zh_tw : section.text_en;
}

export function sectionLabel(key: SectionKey): string {
  return t("{key}（{key2}）", { key: SECTION_LABELS[key], key2: key });
}

export function isSectionKey(value: unknown): value is SectionKey {
  return typeof value === "string" && (SECTION_KEYS as readonly string[]).includes(value);
}
