// 把編輯器裡的 prompt（含 @Image1／@Video1／@Audio1）轉成 H3 TE 看得懂的文字：<Picture n>、<Video n>、<Audio n>。
// 純函式：不改 seed、不補字；找不到的 @ 名稱列為問題，由呼叫端擋下渲染。
// n 是這個參考在 materials（materialsFor 的順序：圖片 → 聲音 → 影片，各自依 alias 序號）中同類的名次：
// alias 連號時 n＝alias 序號；移除 Image2 後 @Image3 會變成 <Picture 2>，與實際送出的第 2 張圖片一致。
// 直接寫的 H3 標籤（<Picture 1>、<Video 1>、<Audio 1>）照原樣送出，也算用到對應的參考（同一套編號）；
// 有素材庫資訊時，影片原聲佔的 <Audio n> 算用到那段影片。
// 編輯器沒有額外語法（區塊標題、時間軸標記都是 prompt 原文的一部分，照原樣送出）。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { aliasLabels, orderedReferences, presentationLabels } from "../references/materials";
import { t } from "@/i18n";

export interface CompiledPrompt {
  /** 送給 h3.conditioning 的 prompt。 */
  text: string;
  /** 無法渲染的原因（繁中）；空陣列＝可以送出。 */
  problems: string[];
  /** prompt 內實際用到的 alias（例如 Image1；@ 名稱或直接寫的 H3 標籤），依出現順序、不重複。 */
  usedAliases: string[];
  /**
   * 只以 @ 名稱用到的 alias（依出現順序、不重複）。fl2va 的 prompt 也會直接寫 <Picture 1>（首幀），所以「這個運算路由
   * 不支援參考素材」只看 @ 名稱。
   */
  mentionedAliases: string[];
}

/** StudioShot.prompt 的契約上限（字元）。 */
export const PROMPT_MAX_LENGTH = 16384;
/** 空 prompt 的問題訊息：呼叫端以這個常數辨識（不比對字面文字），翻譯時只改這裡。 */
export const EMPTY_PROMPT_PROBLEM = t("prompt 是空的");

/** prompt 裡的參考名稱：@ 後接 Image／Video／Audio 與 1–99，後面不能緊接英數字。 */
export const MENTION_SOURCE = "@((?:Image|Video|Audio)[1-9][0-9]?)\\b";

export function mentionPattern(): RegExp {
  return new RegExp(MENTION_SOURCE, "g");
}

/** prompt 裡直接寫的 H3 參考標籤。 */
export const H3_TAG_SOURCE = "<(?:Picture|Video|Audio) [1-9][0-9]?>";

/**
 * H3 標籤 → 參考 alias（依實際送出順序的編號）。提供素材庫時，確定有音軌、使用原聲的影片所佔的 <Audio n> 也對到那段影片
 * （獨立聲音的標籤優先：送出順序中聲音在影片前，兩者不會重號）。
 */
export function tagAliases(references: readonly StudioReference[], library?: readonly StudioLibraryItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [alias, label] of aliasLabels(references)) if (!out.has(label)) out.set(label, alias);
  if (library) {
    const labels = presentationLabels(references, library);
    for (const ref of orderedReferences(references)) {
      const soundtrack = labels.get(ref.ref_id)?.soundtrack?.label;
      if (soundtrack && !out.has(soundtrack)) out.set(soundtrack, ref.alias);
    }
  }
  return out;
}

/** prompt 中 @alias 出現的次數（後面緊接英數字的不算，例如 @Image1x）。 */
export function mentionCount(prompt: string, alias: string): number {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prompt.match(new RegExp(`@${escaped}\\b`, "g"))?.length ?? 0;
}

/** prompt 中直接寫這些 H3 標籤（參考自己的標籤、影片原聲的標籤）的次數；null／重複的標籤略過。 */
export function tagUseCount(prompt: string, tags: readonly (string | null | undefined)[]): number {
  let count = 0;
  for (const tag of new Set(tags)) if (tag) count += prompt.split(tag).length - 1;
  return count;
}

export function compilePrompt(source: string, references: readonly StudioReference[], library?: readonly StudioLibraryItem[]): CompiledPrompt {
  const labels = aliasLabels(references);
  const byTag = tagAliases(references, library);
  const problems: string[] = [];
  const used: string[] = [];
  const mentioned: string[] = [];
  const add = (list: string[], alias: string | undefined) => {
    if (alias && !list.includes(alias)) list.push(alias);
  };
  // 依出現順序記錄用到的參考：@ 名稱與直接寫的 H3 標籤一起掃描
  for (const match of source.matchAll(new RegExp(`${MENTION_SOURCE}|${H3_TAG_SOURCE}`, "g"))) {
    const alias = match[1];
    if (alias === undefined) {
      add(used, byTag.get(match[0]));
    } else if (labels.has(alias)) {
      add(used, alias);
      add(mentioned, alias);
    }
  }
  const text = source.replace(mentionPattern(), (match, alias: string) => {
    const label = labels.get(alias);
    if (!label) {
      problems.push(t("prompt 用到 @{alias}，但這個鏡頭沒有這個參考素材", { alias }));
      return match;
    }
    return label;
  });
  if (text.trim().length === 0) problems.push(EMPTY_PROMPT_PROBLEM);
  return { text, problems: [...new Set(problems)], usedAliases: used, mentionedAliases: mentioned };
}
