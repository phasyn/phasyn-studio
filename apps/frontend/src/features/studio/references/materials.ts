// 鏡頭參考素材（H3 ref2va）：@ 名稱分配、限制檢查與官方建議，以及 h3.materials.v1 的組成。
//
// 共用的 H3 素材規則（送出順序、TE 標籤、限制、原聲佔用的 <Audio n>）在 @/lib/h3Materials（推理頁、執行紀錄與這裡用同一份）。
// 送出順序＝H3 TE 標籤的編號順序：圖片 → 聲音 → 影片，各自依 alias 序號。H3 依同類素材在請求中的出現順序編號
// （<Picture n>／<Audio n>／<Video n>），而有原聲的參考影片會額外佔一個 <Audio n>（在它自己的 <Video n> 之前）。聲音排在影片
// 前面，@Audio1… 才會固定對到 <Audio 1>…，不會被影片原聲（是否存在要等 runtime probe 才確定）擠到後面。alias 可以有缺號
// （移除後不重新編號），標籤用同類中的名次。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { CLIP_GUIDANCE, guidanceSeconds, H3_TAG, HELD_WINDOW_MIN_SECONDS, KIND_ROLE, labelsInOrder, REF2VA_LIMITS, SEND_ORDER, type LabelInput, type MaterialEntry, type OrderedLabel } from "@/lib/h3Materials";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export type ReferenceKind = StudioReference["kind"];

/**
 * Image Studio 畫的遮罩在專案素材庫的備註（features/image-studio 寫入）。遮罩是 Image Studio 局部重繪用的灰階圖，不是參考素材，
 * 也不能當首幀：Video Studio 的素材選擇器與素材庫清單不列出它（檔案仍在素材庫，Image Studio 照常使用）。
 */
export const IMAGE_MASK_NOTE = "Image Studio 遮罩";

/** 素材是不是 Image Studio 的遮罩（只在 Image Studio 使用）。 */
export function isImageStudioMask(item: Pick<StudioLibraryItem, "note">): boolean {
  return item.note === IMAGE_MASK_NOTE;
}

/** Video Studio 可以選用的素材（參考素材、首幀、一鍵換角）：去掉 Image Studio 的遮罩，順序不變。 */
export function videoLibrary<T extends Pick<StudioLibraryItem, "note">>(library: readonly T[]): T[] {
  return library.filter((item) => !isImageStudioMask(item));
}

export const KIND_LABEL: Record<ReferenceKind, string> = { image: t("圖片"), video: t("影片"), audio: t("聲音") };
export const ALIAS_PREFIX: Record<ReferenceKind, string> = { image: "Image", video: "Video", audio: "Audio" };
const ALIAS_RE = /^(Image|Video|Audio)([1-9][0-9]?)$/;
const PREFIX_KIND: Record<string, ReferenceKind> = { Image: "image", Video: "video", Audio: "audio" };
const MAX_ORDINAL = 99;
const EPSILON = 1e-6;

/** alias 的序號（Image12 → 12）；格式不符 → null。 */
export function aliasOrdinal(alias: string): number | null {
  const match = ALIAS_RE.exec(alias);
  return match ? Number(match[2]) : null;
}

/** alias 前綴代表的類型（Video2 → video）；格式不符 → null。 */
export function aliasKind(alias: string): ReferenceKind | null {
  const match = ALIAS_RE.exec(alias);
  return match ? (PREFIX_KIND[match[1] ?? ""] ?? null) : null;
}

/** 依送出順序排列（圖片 → 聲音 → 影片，各自依 alias 序號；同序號保持原順序）。 */
export function orderedReferences(references: readonly StudioReference[]): StudioReference[] {
  const rank = (ref: StudioReference) => aliasOrdinal(ref.alias) ?? Number.MAX_SAFE_INTEGER;
  return [...references].sort((a, b) => SEND_ORDER[a.kind] - SEND_ORDER[b.kind] || rank(a) - rank(b));
}

/** 數量徽章只在接近上限時出現：剩下不到上限的 20%（至少剩 1 個）、已達上限或超過時。 */
const NEAR_LIMIT_SHARE = 0.2;

/** count／limit 是否接近上限（圖片 9 張：7 張起；影片、聲音 3 段：2 段起；合計 12 個：10 個起）。 */
export function nearLimit(count: number, limit: number): boolean {
  return count >= limit - Math.max(1, Math.round(limit * NEAR_LIMIT_SHARE));
}

/** 這個類型下一個可用的 alias：最小的未使用序號（移除 Image2 後，下一張圖片會用 Image2）；用完 → null。 */
export function nextAlias(kind: ReferenceKind, references: readonly StudioReference[]): string | null {
  const used = new Set(references.filter((ref) => ref.kind === kind).map((ref) => aliasOrdinal(ref.alias)));
  for (let n = 1; n <= MAX_ORDINAL; n += 1) if (!used.has(n)) return `${ALIAS_PREFIX[kind]}${String(n)}`;
  return null;
}

/** 再加一個這種類型的參考是否違反 H3 限制；可以加 → null，否則回傳繁中原因。 */
export function addBlockedReason(kind: ReferenceKind, references: readonly StudioReference[]): string | null {
  if (references.length >= REF2VA_LIMITS.maxTotal) return t("參考素材合計最多 {total} 個", { total: REF2VA_LIMITS.maxTotal });
  const count = references.filter((ref) => ref.kind === kind).length;
  if (count >= REF2VA_LIMITS[kind]) return t("參考{kind}最多 {kind2} 個", { kind: KIND_LABEL[kind], kind2: REF2VA_LIMITS[kind] });
  return null;
}

/**
 * 新的參考（alias＝這個類型下一個可用名稱；裁切未設定）。超出限制 → null。新的影片參考不送原聲（use_embedded_audio＝false）：
 * 原片的台詞是原角色的嘴型與聲線，生成的人聲要照 prompt 來；要用時在參考的片段設定打開。舊鏡頭存的 null 維持 runtime 預設（使用）。
 */
export function newReference(item: Pick<StudioLibraryItem, "item_id" | "kind">, references: readonly StudioReference[], refId: string): StudioReference | null {
  if ((addBlockedReason(item.kind, references) ?? "") !== "") return null;
  const alias = nextAlias(item.kind, references);
  if (!(alias != null && alias !== "")) return null;
  const ref: StudioReference = { ref_id: refId, kind: item.kind, alias, item_id: item.item_id, start_seconds: null, end_seconds: null };
  if (item.kind === "video") ref.use_embedded_audio = false;
  return ref;
}

/** alias → H3 TE 標籤（<Picture n>／<Audio n>／<Video n>，n＝同類參考依 alias 序號的名次）。 */
export function aliasLabels(references: readonly StudioReference[]): Map<string, string> {
  const counters: Record<ReferenceKind, number> = { image: 0, video: 0, audio: 0 };
  const labels = new Map<string, string>();
  for (const ref of orderedReferences(references)) {
    counters[ref.kind] += 1;
    if (!labels.has(ref.alias)) labels.set(ref.alias, `<${H3_TAG[ref.kind]} ${String(counters[ref.kind])}>`);
  }
  return labels;
}

export interface PresentationLabel {
  /** 這個參考自己的標籤。 */
  label: string;
  /** 影片原聲：used＝會以 <Audio n> 送出、off＝已關閉、none＝沒有音軌、unknown＝瀏覽器無法判斷（由 runtime probe）。 */
  soundtrack: OrderedLabel["soundtrack"];
}

/**
 * 每個參考（ref_id）在 H3 TE 看到的標籤（送出順序：圖片 → 聲音 → 影片）。影片原聲在 runtime 預設會使用
 * （use_embedded_audio 未設定＝使用）；前面有原聲未知的影片時，後面影片原聲的編號也無法確定（label＝null）。
 */
export function presentationLabels(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): Map<string, PresentationLabel> {
  const items = new Map(library.map((item) => [item.item_id, item]));
  const ordered = orderedReferences(references);
  const labels = labelsInOrder(
    ordered.map((ref): LabelInput => {
      if (ref.kind !== "video") return { kind: ref.kind };
      const hasAudio = items.get(ref.item_id)?.has_audio ?? null;
      return { kind: "video", soundtrack: ref.use_embedded_audio === false ? "off" : hasAudio === false ? "none" : hasAudio === true ? "present" : "unknown" };
    }),
  );
  const out = new Map<string, PresentationLabel>();
  ordered.forEach((ref, index) => {
    const label = labels[index];
    // 送出順序中聲音排在所有影片之前，自己的標籤一定確定；保險起見未知時顯示 ?
    out.set(ref.ref_id, { label: label?.label ?? `<${H3_TAG[ref.kind]} ?>`, soundtrack: label?.soundtrack ?? null });
  });
  return out;
}

/** A reference video whose last frame is held after its end up to the shot's generated length (hold_last_frame). */
export function heldReference(ref: Pick<StudioReference, "kind" | "hold_last_frame">): boolean {
  return ref.kind === "video" && ref.hold_last_frame === true;
}

export function materialsFor(references: readonly StudioReference[], library: readonly StudioLibraryItem[]): MaterialEntry[] {
  const items = new Map(library.map((item) => [item.item_id, item]));
  return orderedReferences(references).flatMap((ref) => {
    const item = items.get(ref.item_id);
    if (!item) return [];
    const entry: MaterialEntry = { file: item.file, role: KIND_ROLE[ref.kind] };
    if (ref.kind !== "image") {
      if (ref.start_seconds !== null) entry.start_seconds = ref.start_seconds;
      if (ref.end_seconds !== null) entry.end_seconds = ref.end_seconds;
    }
    if (ref.kind === "video" && ref.use_embedded_audio !== undefined && ref.use_embedded_audio !== null) entry.use_embedded_audio = ref.use_embedded_audio;
    // Only when on: a request without the hold stays as it was
    if (heldReference(ref)) entry.hold_last_frame = true;
    return [entry];
  });
}

function seconds(value: number): string {
  return t("{Number} 秒", { Number: Number(value.toFixed(3)) });
}

/** How far a kept clip window may run past the new file's end (seconds; it is cut back to the end): a re-encode of the same footage can end a frame earlier. */
const CLIP_END_SLACK_SECONDS = 0.1;

/**
 * Whether a video or sound reference's clip window fits in a file of `duration` seconds (unknown = null). No window (the
 * whole file) always fits; a window needs a known length that holds its start and, within the slack, its end.
 */
export function clipFits(ref: StudioReference, duration: number | null): boolean {
  if (ref.start_seconds === null && ref.end_seconds === null) return true;
  if (duration === null) return false;
  const start = ref.start_seconds ?? 0;
  return start < duration && (ref.end_seconds === null || ref.end_seconds <= duration + CLIP_END_SLACK_SECONDS);
}

/**
 * A reference pointing at another file of the same kind: its @ name, order and sound setting stay. A video or sound clip
 * window stays when the new file (`duration` seconds, null = unknown) holds it, as Premiere's Replace Footage keeps the
 * in and out points (an end just past the new file's end is cut back to it); otherwise it goes back to the whole file.
 */
export function replacedReference(ref: StudioReference, itemId: string, duration: number | null): StudioReference {
  if (ref.kind === "image") return { ...ref, item_id: itemId };
  if (!clipFits(ref, duration)) return { ...ref, item_id: itemId, start_seconds: null, end_seconds: null };
  const end = ref.end_seconds !== null && duration !== null && ref.end_seconds > duration ? duration : ref.end_seconds;
  return { ...ref, item_id: itemId, end_seconds: end };
}

/** 實際使用的片段長度（與 phasyn_h3.recipe.adapter 相同：有終點用終點－起點，否則素材長度－起點）；未知 → null。 */
export function clipSeconds(ref: StudioReference, item: StudioLibraryItem | undefined): number | null {
  if (ref.kind === "image") return null;
  const start = ref.start_seconds ?? 0;
  if (ref.end_seconds !== null) return ref.end_seconds - start;
  const duration = item?.duration_seconds ?? null;
  return duration === null ? null : duration - start;
}

/**
 * H3 ref2va 的官方限制與資料錯誤（會被 runtime 拒絕或送錯素材）；回傳繁中問題清單，空＝可以送出。
 * generatedSeconds：鏡頭的生成長度。終點之後凍結最後一格的影片以它計算 2–15 秒與合計（片段可以短於 2 秒）；
 * 沒給時這種影片的長度算未知（不檢查，由 runtime 檢查），合計只加長度已知的片段。
 */
export function validateReferences(references: readonly StudioReference[], library: readonly StudioLibraryItem[], options: { generatedSeconds?: number | null } = {}): string[] {
  const problems: string[] = [];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const generated = options.generatedSeconds ?? null;
  const count = (kind: ReferenceKind) => references.filter((ref) => ref.kind === kind).length;
  if (references.length === 0) problems.push(t("ref2va 至少需要 1 個參考素材"));
  if (references.length > REF2VA_LIMITS.maxTotal) problems.push(t("參考素材合計最多 {total} 個（目前 {referencesCount}）", { total: REF2VA_LIMITS.maxTotal, referencesCount: references.length }));
  if (count("image") > REF2VA_LIMITS.image) problems.push(t("參考圖片最多 {image} 張（目前 {text}）", { image: REF2VA_LIMITS.image, text: count("image") }));
  if (count("video") > REF2VA_LIMITS.video) problems.push(t("參考影片最多 {video} 段（目前 {text}）", { video: REF2VA_LIMITS.video, text: count("video") }));
  if (count("audio") > REF2VA_LIMITS.audio) problems.push(t("參考聲音最多 {audio} 段（目前 {text}）", { audio: REF2VA_LIMITS.audio, text: count("audio") }));
  if (references.length > 0 && count("image") + count("video") === 0) problems.push(t("不能只有聲音參考：至少要 1 張圖片或 1 段影片"));
  const totals: Partial<Record<ReferenceKind, number>> = {};
  const seen = new Set<string>();
  for (const ref of references) {
    const name = `@${ref.alias}`;
    if (aliasKind(ref.alias) !== ref.kind) problems.push(t("{name} 的名稱與類型不符：{kind}應命名為 {kind2}1、{kind3}2…", { name, kind: KIND_LABEL[ref.kind], kind2: ALIAS_PREFIX[ref.kind], kind3: ALIAS_PREFIX[ref.kind] }));
    if (seen.has(ref.alias)) problems.push(t("{name} 重複：同一個鏡頭的參考名稱不能重複", { name }));
    seen.add(ref.alias);
    const item = items.get(ref.item_id);
    if (!item) {
      problems.push(t("{name} 的檔案已不在素材庫", { name }));
      continue;
    }
    if (item.kind !== ref.kind) problems.push(t("{name} 指向的檔案是{kind}，不是{kind2}", { name, kind: KIND_LABEL[item.kind], kind2: KIND_LABEL[ref.kind] }));
    if (ref.kind === "image") {
      if (ref.start_seconds !== null || ref.end_seconds !== null) problems.push(t("{name} 是圖片，不能設定起點／終點", { name }));
      continue;
    }
    const start = ref.start_seconds ?? 0;
    if (start < 0) problems.push(t("{name} 的起點不可小於 0", { name }));
    if (ref.end_seconds !== null && ref.end_seconds <= start) problems.push(t("{name} 的終點必須大於起點", { name }));
    const duration = item.duration_seconds;
    if (duration !== null) {
      if (start >= duration) problems.push(t("{name} 的起點 {start}不在素材長度 {duration}內", { name, start: seconds(start), duration: seconds(duration) }));
      if (ref.end_seconds !== null && ref.end_seconds > duration + EPSILON) problems.push(t("{name} 的終點 {end_seconds}超過素材長度 {duration}", { name, end_seconds: seconds(ref.end_seconds), duration: seconds(duration) }));
    }
    const window = clipSeconds(ref, item);
    const held = heldReference(ref);
    // A held window repeats its last frame, so it needs one
    if (held && window !== null && window > 0 && window < HELD_WINDOW_MIN_SECONDS - EPSILON) problems.push(t("{name} 的片段不到 1 格：終點之後凍結最後一格，至少要有 1 格畫面", { name }));
    // The runtime refuses a clip outside the official range (an unknown length is only a warning, see referenceWarnings);
    // a held video counts as the generated length
    const clip = guidanceSeconds(window, held, generated);
    if (clip !== null && clip > 0) {
      if (clip < CLIP_GUIDANCE.min - EPSILON)
        problems.push(
          ref.kind === "video" && !held
            ? t("{name} 只有 {clip}：H3 的參考片段每段要 {min}–{max} 秒；把片段拉長到至少 {min} 秒，或在「片段與原聲」打開「終點之後凍結最後一格」", { name, clip: seconds(clip), min: CLIP_GUIDANCE.min, max: CLIP_GUIDANCE.max })
            : t("{name} 只有 {clip}：H3 的參考片段每段要 {min}–{max} 秒；把片段拉長到至少 {min} 秒（鏡頭太短時，改用延長最後一格的片段）", { name, clip: seconds(clip), min: CLIP_GUIDANCE.min, max: CLIP_GUIDANCE.max }),
        );
      else if (clip > CLIP_GUIDANCE.max + EPSILON)
        problems.push(t("{name} 有 {clip}：H3 的參考片段每段要 {min}–{max} 秒；把起點／終點縮到 {max} 秒以內", { name, clip: seconds(clip), min: CLIP_GUIDANCE.min, max: CLIP_GUIDANCE.max }));
      totals[ref.kind] = (totals[ref.kind] ?? 0) + clip;
    }
  }
  for (const kind of ["video", "audio"] as const) {
    const total = totals[kind];
    if (total !== undefined && total > CLIP_GUIDANCE.total + EPSILON) {
      problems.push(t("參考{kind}合計 {total}：H3 每種參考合計最多 {total2} 秒；縮短其中幾段", { kind: KIND_LABEL[kind], total: seconds(total), total2: CLIP_GUIDANCE.total }));
    }
  }
  return problems;
}

/**
 * 不擋渲染的提醒：長度未知（無法事先檢查 2–15 秒的限制）、超過生成長度會被截斷、同一個檔案重複使用。超出 2–15 秒或
 * 合計超過 15 秒會被 runtime 拒絕，所以在 validateReferences 擋下，不在這裡。
 */
export function referenceWarnings(
  references: readonly StudioReference[],
  library: readonly StudioLibraryItem[],
  options: { durationSeconds?: number | null } = {},
): string[] {
  const warnings: string[] = [];
  const items = new Map(library.map((item) => [item.item_id, item]));
  const byItem = new Map<string, string[]>();
  for (const ref of orderedReferences(references)) {
    byItem.set(ref.item_id, [...(byItem.get(ref.item_id) ?? []), `@${ref.alias}`]);
    if (ref.kind === "image") continue;
    const item = items.get(ref.item_id);
    if (!item) continue;
    const clip = clipSeconds(ref, item);
    if (clip === null) {
      // A held video counts as the generated length, whatever its window
      if (!heldReference(ref)) warnings.push(t("@{alias} 的長度未知（瀏覽器無法讀取）：無法事先檢查 H3 每段 {min}–{max} 秒的限制，渲染時才會知道", { alias: ref.alias, min: CLIP_GUIDANCE.min, max: CLIP_GUIDANCE.max }));
      continue;
    }
    if (clip <= 0) continue;
    const duration = options.durationSeconds ?? null;
    if (duration !== null && clip > duration + 0.05) {
      warnings.push(t("@{alias} 使用 {clip}，比生成長度 {duration}長；超過的部分不會被使用（runtime 截斷）", { alias: ref.alias, clip: seconds(clip), duration: seconds(duration) }));
    }
  }
  for (const aliases of byItem.values()) if (aliases.length > 1) warnings.push(t("{aliases} 是同一個檔案", { aliases: formatList(aliases) }));
  return warnings;
}
