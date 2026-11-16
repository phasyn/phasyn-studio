// 「修正與建議」與範本說給人聽的名稱（純資料）：H3 段落與生成方式在介面上的叫法。段落用使用者在畫面上看得懂的意思
// 命名（角色與參考圖、一句話摘要、要保留的外觀、畫面與分鏡、環境聲、配樂）；正式的段落名稱只放在括號裡，方便在
// prompt 裡找到它，或放在依據與提示文字裡。
import type { FieldName } from "./parse";
import type { PromptMode } from "./types";
import { t } from "@/i18n";

export const FIELD_LABEL: Record<FieldName, string> = {
  subject_definitions: t("角色與參考圖"),
  summary: t("一句話摘要"),
  retention_analysis: t("要保留的外觀"),
  detailed_description: t("畫面與分鏡"),
  integrated_multimodal_description: t("畫面描述"),
  overall_soundscape: t("環境聲"),
  non_diegetic_music: t("配樂"),
};

/** 句子裡的段落：「環境聲」。 */
export function fieldName(name: FieldName): string {
  return t("「{label}」", { label: FIELD_LABEL[name] });
}

/** 要在 prompt 裡找到它的時候：「環境聲」段（overall_soundscape）。 */
export function fieldWithKey(name: FieldName): string {
  return t("「{label}」段（{name}）", { label: FIELD_LABEL[name], name });
}

/** 範本適合哪種鏡頭。 */
export const MODE_FIT: Record<PromptMode, string> = {
  t2va: t("適合只用文字的鏡頭"),
  fl2va: t("適合有首幀的鏡頭"),
  ref2va: t("適合用參考素材的鏡頭"),
};
