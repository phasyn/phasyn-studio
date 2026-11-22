// 區塊在大綱上的顯示文字（純函式）。
import { formatClock, type BlockKind, type H3Section, type PromptBlock } from "./blocks";
import { excerpt } from "./snippets";
import { t } from "@/i18n";

export const KIND_LABELS: Record<BlockKind, string> = {
  section: t("H3 區段"),
  shot: t("H3 分鏡"),
  time: t("時間標題"),
  heading: t("標題"),
  paragraph: t("段落"),
};

/** 官方 H3 區段的用途（編輯區塊時的說明文字）。 */
export const SECTION_HINTS: Record<H3Section, string> = {
  subject_definitions: t("定義每個主體並綁定參考素材，例如 <Subject 1> is the woman shown in @Image1, preserving her face and outfit."),
  summary: t("一兩句話說明整段影片；官方 Ref2VA 範例以 [reference generation] 開頭。"),
  retention_analysis: t("逐一說明每個主體要保留哪些特徵（官方範例：fully_preserved - retain the same face…）。"),
  detailed_description: t("畫風、構圖、運鏡與限制，接著逐鏡描述：[Shot 1]（第一鏡不加時間），之後每次切鏡寫 [Shot 2] At 00:02.500,（時間遞增且小於片長）。"),
  overall_soundscape: t("整體環境音與音效。"),
  non_diegetic_music: t("配樂（非劇情內的音樂）。"),
};

export interface BlockDescription {
  kind: string;
  title: string;
  /** 時間範圍等機器資訊（mono 顯示）。 */
  detail: string | null;
  excerpt: string;
}

export function describeBlock(block: PromptBlock): BlockDescription {
  const body = excerpt(block.body, 60);
  switch (block.kind) {
    case "paragraph":
      return { kind: KIND_LABELS.paragraph, title: excerpt(block.body, 24), detail: null, excerpt: "" };
    case "shot":
      return {
        kind: KIND_LABELS.shot,
        title: block.title,
        detail: block.range
          ? `${formatClock(block.range.start)}–${formatClock(block.range.end)}`
          : block.cue !== null
            ? t("{cue} 切入", { cue: formatClock(block.cue) })
            : block.shot === 1
              ? t("開場")
              : t("未標切鏡時間"),
        excerpt: body,
      };
    case "heading":
    case "section":
    case "time":
    default:
      return { kind: KIND_LABELS[block.kind], title: block.title, detail: null, excerpt: body };
  }
}
