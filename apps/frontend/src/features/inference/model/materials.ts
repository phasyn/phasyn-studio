// h3.materials.v1（H3 ref2va 參考素材）的編輯模型：上傳的檔案 → 角色、時間範圍、影片內聲音、終點之後凍結最後一格 →
// 送出的 materials 陣列。
// 規則（共用的 @/lib/h3Materials，對齊 H3 adapter 的 material diagnostics）：角色與媒體類型一致、圖片沒有時間範圍、end > start、
// 圖片 ≤ 9、影片 ≤ 3、聲音 ≤ 3、合計 1–12、不能只有聲音。伺服器／元件仍是權威（會以錯誤拒絕）。純函式。
import type { FileRef } from "@/api/generated/contracts";
import {
  compareRoles,
  KIND_ROLE,
  kindOfMediaType,
  labelsInOrder,
  REF2VA_LIMITS,
  ROLE_KIND,
  ROLE_LABEL,
  type LabelInput,
  type MaterialEntry,
  type MaterialRole,
  type OrderedLabel,
} from "@/lib/h3Materials";
import { t } from "@/i18n";

export interface MaterialDraft {
  /** 本機識別（清單 key）；不送出。 */
  key: string;
  /** 上傳時的檔名（顯示用）。 */
  name: string;
  file: FileRef;
  role: MaterialRole;
  /** 秒；null＝不指定（從頭）。圖片不適用。 */
  start: number | null;
  /** 秒；null＝不指定（到結尾或生成長度）。圖片不適用。 */
  end: number | null;
  /** 只對參考影片：null＝依預設（使用影片內的聲音）。 */
  useEmbeddedAudio: boolean | null;
  /** 只對參考影片：結束秒數之後凍結最後一格、聲音補靜音，補滿生成長度（送出 hold_last_frame=true）。 */
  holdLastFrame: boolean;
}

/** 新加入素材的預設角色：依檔案 MIME；無法判斷時先放「參考圖片」並由檢查提示使用者改角色。 */
export function defaultRole(mediaType: string): MaterialRole {
  const kind = kindOfMediaType(mediaType);
  return kind ? KIND_ROLE[kind] : "reference_image";
}

export function newMaterial(key: string, name: string, file: FileRef): MaterialDraft {
  return { key, name, file, role: defaultRole(file.media_type), start: null, end: null, useEmbeddedAudio: null, holdLastFrame: false };
}

/**
 * 送出順序：圖片 → 聲音 → 影片（與 Studio 相同，共用 compareRoles）；同類保留加入順序。
 * H3 依同類出現順序編號：獨立聲音固定是 <Audio 1>…，有音軌的參考影片原聲接在後面。
 */
export function orderedMaterials(drafts: readonly MaterialDraft[]): MaterialDraft[] {
  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort((a, b) => compareRoles(a.draft.role, b.draft.role) || a.index - b.index)
    .map((entry) => entry.draft);
}

/** 送出的 h3.materials.v1 值：沒有指定的欄位不送（不補預設值）；圖片不送時間範圍。 */
export function materialsValue(drafts: readonly MaterialDraft[]): MaterialEntry[] {
  return orderedMaterials(drafts).map((draft) => {
    const entry: MaterialEntry = { file: draft.file, role: draft.role };
    if (draft.role !== "reference_image") {
      if (draft.start !== null) entry.start_seconds = draft.start;
      if (draft.end !== null) entry.end_seconds = draft.end;
    }
    if (draft.role === "reference_video" && draft.useEmbeddedAudio !== null) entry.use_embedded_audio = draft.useEmbeddedAudio;
    if (draft.role === "reference_video" && draft.holdLastFrame) entry.hold_last_frame = true;
    return entry;
  });
}

export interface MaterialCounts {
  image: number;
  video: number;
  audio: number;
  total: number;
}

export function materialCounts(drafts: readonly MaterialDraft[]): MaterialCounts {
  const counts: MaterialCounts = { image: 0, video: 0, audio: 0, total: drafts.length };
  for (const draft of drafts) counts[ROLE_KIND[draft.role]] += 1;
  return counts;
}

function finite(value: number | null): boolean {
  return value === null || Number.isFinite(value);
}

/** 送出前的檢查（繁中）；空清單不檢查（是否必填由 run 輸入檢查負責）。 */
export function materialIssues(drafts: readonly MaterialDraft[]): string[] {
  if (drafts.length === 0) return [];
  const problems: string[] = [];
  const counts = materialCounts(drafts);
  if (counts.total > REF2VA_LIMITS.maxTotal) problems.push(t("參考素材合計最多 {maxTotal} 個（目前 {total}）", { maxTotal: REF2VA_LIMITS.maxTotal, total: counts.total }));
  if (counts.image > REF2VA_LIMITS.image) problems.push(t("參考圖片最多 {image} 張（目前 {image2}）", { image: REF2VA_LIMITS.image, image2: counts.image }));
  if (counts.video > REF2VA_LIMITS.video) problems.push(t("參考影片最多 {video} 段（目前 {video2}）", { video: REF2VA_LIMITS.video, video2: counts.video }));
  if (counts.audio > REF2VA_LIMITS.audio) problems.push(t("參考聲音最多 {audio} 段（目前 {audio2}）", { audio: REF2VA_LIMITS.audio, audio2: counts.audio }));
  if (counts.image + counts.video === 0) problems.push(t("不能只有聲音參考：至少要 1 張圖片或 1 段影片"));
  for (const draft of drafts) {
    const kind = kindOfMediaType(draft.file.media_type);
    if (kind !== ROLE_KIND[draft.role]) {
      problems.push(t("「{name}」是 {value}，與角色「{role}」不符", { name: draft.name, value: draft.file.media_type || t("未知類型"), role: ROLE_LABEL[draft.role] }));
    }
    if (!finite(draft.start) || !finite(draft.end)) {
      problems.push(t("「{name}」的秒數不是有效數字", { name: draft.name }));
      continue;
    }
    if (draft.role === "reference_image") {
      if (draft.start !== null || draft.end !== null) problems.push(t("圖片「{name}」不支援開始／結束秒數", { name: draft.name }));
      continue;
    }
    if (draft.start !== null && draft.start < 0) problems.push(t("「{name}」的開始秒數不能小於 0", { name: draft.name }));
    if (draft.end !== null && draft.end <= (draft.start ?? 0)) problems.push(t("「{name}」的結束秒數必須大於開始秒數", { name: draft.name }));
  }
  return problems;
}

export interface MaterialTag {
  /** 這個素材在 prompt 中的 H3 標籤（<Picture n>／<Audio n>／<Video n>）。 */
  tag: string | null;
  /**
   * 只有參考影片：影片原聲。這裡不知道影片有沒有音軌（由元件 probe），使用原聲時 state＝unknown；
   * 有音軌時原聲會排在所有獨立聲音之後佔一個 <Audio n>。
   */
  soundtrack: OrderedLabel["soundtrack"];
}

/** 每個素材在 prompt 中的 H3 標籤（依送出順序計數，與 Studio 的標籤規則相同）。 */
export function materialTags(drafts: readonly MaterialDraft[]): Map<string, MaterialTag> {
  const ordered = orderedMaterials(drafts);
  const labels = labelsInOrder(
    ordered.map((draft): LabelInput =>
      draft.role === "reference_video" ? { kind: "video", soundtrack: draft.useEmbeddedAudio === false ? "off" : "unknown" } : { kind: ROLE_KIND[draft.role] },
    ),
  );
  const tags = new Map<string, MaterialTag>();
  ordered.forEach((draft, index) => tags.set(draft.key, { tag: labels[index]?.label ?? null, soundtrack: labels[index]?.soundtrack ?? null }));
  return tags;
}

/** 已到上限的類別（UI 停用對應的加入方式並說明原因）。 */
export function roleFull(drafts: readonly MaterialDraft[], role: MaterialRole): boolean {
  const counts = materialCounts(drafts);
  return counts[ROLE_KIND[role]] >= REF2VA_LIMITS[ROLE_KIND[role]] || counts.total >= REF2VA_LIMITS.maxTotal;
}

/** 秒數輸入：空字串＝不指定；其他非數字保留為 NaN，交給檢查顯示錯誤（不默默改值）。 */
export function parseSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return Number(trimmed);
}

/** 送出順序中同角色的前一個（-1）／後一個（1）；沒有時 null。 */
function neighbour(ordered: readonly MaterialDraft[], index: number, direction: -1 | 1): number | null {
  const current = ordered[index];
  const target = ordered[index + direction];
  return current && target && target.role === current.role ? index + direction : null;
}

export function canMoveMaterial(drafts: readonly MaterialDraft[], key: string, direction: -1 | 1): boolean {
  const ordered = orderedMaterials(drafts);
  return neighbour(ordered, ordered.findIndex((draft) => draft.key === key), direction) !== null;
}

/** 與同角色的前一個／後一個交換（改變同類編號，例如 <Picture 1> ↔ <Picture 2>）；回傳依送出順序排列的清單。 */
export function moveMaterial(drafts: readonly MaterialDraft[], key: string, direction: -1 | 1): MaterialDraft[] {
  const ordered = orderedMaterials(drafts);
  const index = ordered.findIndex((draft) => draft.key === key);
  const target = neighbour(ordered, index, direction);
  const current = ordered[index];
  const other = target === null ? undefined : ordered[target];
  if (target === null || !current || !other) return ordered;
  const next = [...ordered];
  next[index] = other;
  next[target] = current;
  return next;
}
