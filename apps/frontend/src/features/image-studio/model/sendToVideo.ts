// 「加入素材庫」與「用在影片鏡頭」（同一個專案的影片 Studio）：一律使用 take 的白底版（H3 讀透明 PNG 時也是鋪白底，所以畫面與模型看到的一致）。
// - 加入素材庫：白底版成為專案素材庫的一張圖片（source＝image_take），同一個 take 只加一次。
// - 當 ref2va 參考圖：加到影片鏡頭的參考素材（下一個可用的 @ImageN），影片鏡頭的 prompt 用 @ImageN 引用。
// - 當 fl2va 首幀：影片鏡頭的首幀改成這張圖（StudioShot.continuity = { mode: "image", item_id }；影片 Studio 的渲染規劃把
//   素材檔直接接到元件組合的首幀輸入）。H3 會把首幀拉伸到專案畫面，所以比例必須與專案相同（firstFrameImageProblem）。
// 純函式；畫面與 reducer 共用。
import type { StudioProject, StudioShot } from "@/api/generated/contracts";
import { addBlockedReason, findRoute, firstFrameImageProblem, firstFrameItemId, newReference, type StudioRoute } from "@/features/studio";
import type { ImageLibraryItem, ImageStudioProject, StudioImageShot, StudioImageTake } from "../types";
import { LIMITS } from "./constants";
import { takeNumber } from "./shots";
import { t } from "@/i18n";

/**
 * 影片 Studio 是否支援「素材庫圖片當 fl2va 首幀」：已整合（契約 StudioShot.continuity = { mode: "image", item_id }，
 * renderPlan.ts 把素材檔接到元件組合的首幀輸入）。
 */
export const VIDEO_FIRST_FRAME_IMAGE = true;

/** VIDEO_FIRST_FRAME_IMAGE＝false 時的停用原因（保留給回退用）。 */
export const FIRST_FRAME_PENDING = t("Video Studio 還不支援以素材庫圖片當 fl2va 首幀（契約與渲染規劃尚未整合；目前的首幀只能「從前一個鏡頭接續」）");

export type VideoUse = "ref2va" | "fl2va";

/** 這張圖（白底版素材）能不能當這個專案影片鏡頭的首幀：比例與專案畫面不同時回傳原因（H3 會拉伸變形）；可以時 null。 */
export function firstFrameBlockedReason(project: Pick<StudioProject, "format">, item: Pick<ImageLibraryItem, "kind" | "width" | "height"> | null): string | null {
  if (!VIDEO_FIRST_FRAME_IMAGE) return FIRST_FRAME_PENDING;
  return item ? firstFrameImageProblem(item, project.format) : null;
}

/** take 的白底版在素材庫中的項目（同一個 take 只會有一個）；沒有時 null。 */
export function takeLibraryItem(library: readonly ImageLibraryItem[], shotId: string, take: Pick<StudioImageTake, "take_id" | "library_item_id">): ImageLibraryItem | null {
  if (take.library_item_id) {
    const linked = library.find((item) => item.item_id === take.library_item_id);
    if (linked) return linked;
  }
  return library.find((item) => item.source?.kind === "image_take" && item.source.image_shot_id === shotId && item.source.take_id === take.take_id) ?? null;
}

export type WhiteItemResult = { item: ImageLibraryItem; existing: boolean; problem: null } | { item: null; existing: false; problem: string };

/** 白底版的素材庫項目：已加過就回傳既有的；新的項目由 itemId、now 決定（純函式）。 */
export function whiteLibraryItem(
  project: Pick<ImageStudioProject, "library">,
  shot: StudioImageShot,
  take: StudioImageTake,
  itemId: string,
  now: string,
): WhiteItemResult {
  const library = project.library ?? [];
  const existing = takeLibraryItem(library, shot.image_shot_id, take);
  if (existing) return { item: existing, existing: true, problem: null };
  if (take.state !== "succeeded" || !take.image) return { item: null, existing: false, problem: t("這個 take 還沒有成功完成") };
  const white = take.image_white;
  if (!white) return { item: null, existing: false, problem: t("這個 take 沒有白底版（元件組合沒有 image_white 輸出）") };
  if (library.length >= LIMITS.library) return { item: null, existing: false, problem: t("專案素材庫最多 {library} 個檔案", { library: LIMITS.library }) };
  const side = (value: number) => (Number.isInteger(value) && value >= 1 && value <= 16384 ? value : null);
  const number = takeNumber(shot, take.take_id);
  const item: ImageLibraryItem = {
    item_id: itemId,
    kind: "image",
    name: t("{value}・take {value2}（白底）.png", { value: shot.title || t("圖片"), value2: number > 0 ? number : "?" }).slice(0, 200),
    file: white.file,
    created_at: now,
    duration_seconds: null,
    width: side(white.width),
    height: side(white.height),
    has_audio: false,
    note: t("Image Studio・seed {seed}", { seed: take.seed }),
    source: { kind: "image_take", image_shot_id: shot.image_shot_id, take_id: take.take_id },
  };
  return { item, existing: false, problem: null };
}

export interface VideoShotOption {
  shot: StudioShot;
  index: number;
  route: StudioRoute | null;
  /** 不能這樣用的原因；可以時 null。 */
  blocked: string | null;
  /** 可以，但要注意的事（例如運算路由不是 ref2va）。 */
  note: string | null;
  /** 這張圖已經是這個鏡頭的參考時的 @ 名稱。 */
  alias: string | null;
}

/** 每個影片鏡頭能不能用這張圖（itemId＝null：白底版還沒加進素材庫，只檢查限制）。 */
export function videoShotOptions(project: Pick<StudioProject, "shots">, use: VideoUse, itemId: string | null, routes: readonly StudioRoute[]): VideoShotOption[] {
  return project.shots.map((shot, index) => {
    const route = findRoute(routes, shot.route);
    const references = shot.references ?? [];
    const alias = itemId ? (references.find((ref) => ref.item_id === itemId)?.alias ?? null) : null;
    if (use === "ref2va") {
      const blocked = alias ? t("已經是這個鏡頭的 @{alias}", { alias }) : addBlockedReason("image", references);
      const note = route && route.capability !== "ref2va" ? t("運算路由「{label}」是 {capability}：參考圖只在 ref2va 元件組合有效", { label: route.label, capability: route.capability }) : route ? null : t("運算路由不存在：參考圖只在 ref2va 元件組合有效");
      return { shot, index, route, blocked, note, alias };
    }
    const current = firstFrameItemId(shot);
    const blocked = !VIDEO_FIRST_FRAME_IMAGE ? FIRST_FRAME_PENDING : itemId !== null && current === itemId ? t("已經是這個鏡頭的首幀") : null;
    const note =
      shot.continuity?.mode === "previous_last"
        ? t("會取代「從前一個鏡頭接續」")
        : current
          ? t("會取代目前的首幀圖片")
          : route && route.capability !== "fl2va"
            ? t("運算路由「{label}」是 {capability}：首幀只在 fl2va 元件組合有效", { label: route.label, capability: route.capability })
            : null;
    return { shot, index, route, blocked, note, alias };
  });
}

/** 某種用途可選的影片元件組合（ref2va／fl2va）。 */
export function routesFor(use: VideoUse, routes: readonly StudioRoute[]): StudioRoute[] {
  return routes.filter((route) => route.capability === use);
}

/** 把素材加成影片鏡頭的 ref2va 參考（下一個 @ImageN）；已經有了或超過 H3 限制時回傳原因。 */
export function attachReference(shot: StudioShot, item: Pick<ImageLibraryItem, "item_id" | "kind">, refId: string): { shot: StudioShot; alias: string; problem: null } | { shot: null; alias: null; problem: string } {
  const references = shot.references ?? [];
  const existing = references.find((ref) => ref.item_id === item.item_id);
  if (existing) return { shot: null, alias: null, problem: t("已經是這個鏡頭的 @{alias}", { alias: existing.alias }) };
  const created = newReference(item, references, refId);
  if (!created) return { shot: null, alias: null, problem: addBlockedReason(item.kind, references) ?? t("參考名稱已用完") };
  return { shot: { ...shot, references: [...references, created] }, alias: created.alias, problem: null };
}

/** 影片鏡頭以素材庫圖片當首幀（取代「從前一個鏡頭接續」或原本的首幀圖片）；已經是這張時回傳原物件。 */
export function attachFirstFrame(shot: StudioShot, itemId: string): StudioShot {
  if (firstFrameItemId(shot) === itemId) return shot;
  return { ...shot, continuity: { mode: "image", item_id: itemId } };
}

/** 影片 Studio「鏡頭」工作區中這個鏡頭的網址（同一個專案）。 */
export function videoShotUrl(projectId: string, shotId: string): string {
  return `/studio/generate?project=${encodeURIComponent(projectId)}&shot=${encodeURIComponent(shotId)}`;
}
