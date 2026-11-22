// 參考素材 → H3 TE 標籤（純函式）。程式行為（SGLang minimax_h3/stages/text_encoding.py、presentation.py；
// phasyn_h3/recipe/adapter/materials.py normalize_materials）：
//  - 標籤依同類素材在請求中的出現順序編號：<Picture i>、<Audio j>、<Video k>，順序有語意（Diffusers 文件：
//    reordering the same references is a different request）。
//  - 參考影片若帶原聲（use_embedded_audio 未關閉且檔案有音軌），在它自己的 <Video k> 前面多一個 <Audio j>；
//    有沒有音軌不確定時由 runtime probe 決定，之後的 <Audio> 編號也跟著不確定。
// 送出順序、TE 標籤與種類名稱都用 Studio 參考素材模組與 @/lib/h3Materials 的同一份（圖片 → 聲音 → 影片，各自依 alias 序號；
// 聲音排在影片前面，@Audio1… 才會固定對到 <Audio 1>…）。這裡只多了建議需要的「最可能的標籤」與 <Audio n> 數量範圍。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { H3_TAG, type SoundtrackState } from "@/lib/h3Materials";
import { orderedReferences } from "../../references/materials";
import type { RefKind } from "./parse";
import { t } from "@/i18n";


export interface ReferenceLabel {
  ref: StudioReference;
  item: StudioLibraryItem | null;
  /** @ 名稱編譯後的標籤（<Picture 1>）。 */
  label: string;
  /** 影片原聲：used＝會以 <Audio n> 送出；off＝已關閉；none＝沒有音軌；unknown＝要等 runtime probe。 */
  soundtrack: { state: SoundtrackState; label: string | null } | null;
}

export interface LabelPlan {
  /** 依送出順序。 */
  entries: ReferenceLabel[];
  byAlias: Map<string, ReferenceLabel>;
  counts: Record<RefKind, number>;
  /** <Audio n> 標籤總數的可能範圍（影片原聲是否存在要等 runtime probe）。 */
  audioLabels: { min: number; max: number };
}

export function labelPlan(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): LabelPlan {
  const items = new Map(library.map((item) => [item.item_id, item]));
  const counters: Record<RefKind, number> = { image: 0, video: 0, audio: 0 };
  const entries: ReferenceLabel[] = [];
  let audioUncertain = false;
  let unknownSoundtracks = 0;
  for (const ref of orderedReferences(references)) {
    const item = items.get(ref.item_id) ?? null;
    let soundtrack: ReferenceLabel["soundtrack"] = null;
    if (ref.kind === "video") {
      const hasAudio = item?.has_audio ?? null;
      if (ref.use_embedded_audio === false) soundtrack = { state: "off", label: null };
      else if (hasAudio === false) soundtrack = { state: "none", label: null };
      else if (hasAudio === true) {
        counters.audio += 1;
        soundtrack = { state: "used", label: audioUncertain ? null : `<Audio ${String(counters.audio)}>` };
      } else {
        audioUncertain = true;
        unknownSoundtracks += 1;
        soundtrack = { state: "unknown", label: null };
      }
    }
    counters[ref.kind] += 1;
    entries.push({ ref, item, label: `<${H3_TAG[ref.kind]} ${String(counters[ref.kind])}>`, soundtrack });
  }
  const counts: Record<RefKind, number> = {
    image: references.filter((ref) => ref.kind === "image").length,
    video: references.filter((ref) => ref.kind === "video").length,
    audio: references.filter((ref) => ref.kind === "audio").length,
  };
  return {
    entries,
    byAlias: new Map(entries.map((entry) => [entry.ref.alias, entry])),
    counts,
    audioLabels: { min: counters.audio, max: counters.audio + unknownSoundtracks },
  };
}

/** 素材的片段文字（影片／聲音）：「0–5 秒」「從 2 秒到結尾」；整段或圖片 → null。 */
export function clipText(ref: StudioReference): string | null {
  if (ref.kind === "image") return null;
  const start = ref.start_seconds;
  const end = ref.end_seconds;
  if (start === null && end === null) return null;
  return t("{value}–{value2} 秒", { value: start ?? 0, value2: end ?? t("結尾") });
}
