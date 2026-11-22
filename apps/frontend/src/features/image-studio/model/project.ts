// Image Studio 對專案文件的編輯（reducer，純函式）。專案與影片 Studio 共用：image_shots 由這裡改；影片的部分
// （鏡頭、名稱）交給影片 Studio 的 projectReducer（{ type: "video" }），兩邊都以展開保留對方的欄位。
// 每個動作都是增量的（加一個素材、改一張圖、加一個參考），所以版本衝突時可以把本機的動作依序重新套在伺服器的
// 最新版上（使用者選擇「保留兩邊」時；見 hooks/useImageDocument）。不合法或沒有效果的動作回傳原物件。
import type { StudioShot } from "@/api/generated/contracts";
import { firstFrameItemId, IMAGE_MASK_NOTE, projectReducer, type ProjectAction } from "@/features/studio";
import { fieldValue, changedItems, valuesEqual } from "@/lib/json";
import type { ImageLibraryItem, ImageStudioProject, StudioImageShot, StudioImageTake } from "../types";
import { LIMITS } from "./constants";
import { addReference } from "./references";
import { attachFirstFrame, attachReference, firstFrameBlockedReason, type VideoUse } from "./sendToVideo";
import { activeImageTake, imageShots, type ImageShotPatch } from "./shots";

/**
 * Image Studio 繪製並保存的遮罩在素材庫的備註（只有帶這個備註、且沒有任何地方引用的遮罩，換新遮罩時才會從素材庫移除）。
 * 與影片 Studio 共用同一個常數：影片 Studio 的素材選擇器不列出遮罩。
 */
export const MASK_NOTE = IMAGE_MASK_NOTE;

export type ImageProjectAction =
  /** 影片 Studio 的動作（改名、新增影片鏡頭…）。 */
  | { type: "video"; action: ProjectAction }
  | { type: "addImageShot"; shot: StudioImageShot; afterShotId?: string | null }
  | { type: "updateImageShot"; shotId: string; patch: ImageShotPatch }
  | { type: "removeImageShot"; shotId: string }
  /** 複製設定（不複製 takes）；patch 覆寫部分欄位（例如「用這組參數新增一張圖片」）。 */
  | { type: "duplicateImageShot"; shotId: string; newShotId: string; title: string; patch?: ImageShotPatch }
  | { type: "moveImageShot"; shotId: string; toIndex: number }
  /** 加一張參考圖（以套用當下的參考清單判斷上限與底圖；上傳完成時用）。 */
  | { type: "addImageReference"; shotId: string; itemId: string }
  | { type: "addImageTakes"; shotId: string; takes: StudioImageTake[] }
  /** activateOnSuccess：這個 take 變成成功時，若圖片還沒有使用中的 take，就選用這次先完成的候選。 */
  | { type: "updateImageTake"; runId: string; takeId: string; patch: Partial<StudioImageTake>; activateOnSuccess?: boolean }
  | { type: "setActiveImageTake"; shotId: string; takeId: string | null }
  /** 永久刪除 run 之後移除專案中引用它們的 take（主控沒有處理 image_shots 時的本機補齊；已移除時沒有效果）。 */
  | { type: "removeImageTakes"; runIds: string[] }
  | { type: "addLibraryItems"; items: ImageLibraryItem[] }
  /** 換遮罩（item＝null：停用遮罩）；舊的遮罩若沒有任何地方引用就從素材庫移除（檔案仍在主控）。 */
  | { type: "setMask"; shotId: string; item: ImageLibraryItem | null }
  /** 白底版（item）加進素材庫（還沒有時）並用在影片鏡頭；route 非 null 時一併改影片鏡頭的運算路由（使用者選的）。 */
  | { type: "attachToVideoShot"; videoShotId: string; use: VideoUse; item: ImageLibraryItem; refId: string; route: string | null }
  /** 新增一個影片鏡頭（呼叫端已把參考或首幀放進 shot），白底版一併加進素材庫。 */
  | { type: "addVideoShotWith"; shot: StudioShot; item: ImageLibraryItem; afterShotId: string | null };

function withShots(project: ImageStudioProject, shots: StudioImageShot[]): ImageStudioProject {
  return { ...project, image_shots: shots };
}

function mapImageShot(project: ImageStudioProject, shotId: string, fn: (shot: StudioImageShot) => StudioImageShot): ImageStudioProject {
  const shots = changedItems(imageShots(project), (shot) => {
    if (shot.image_shot_id !== shotId) return shot;
    return fn(shot);
  });
  return shots !== null ? withShots(project, shots) : project;
}

function video(project: ImageStudioProject, action: ProjectAction): ImageStudioProject {
  // 影片 reducer 以展開保留 image_shots 與素材的 source（結構上是同一份文件）
  return projectReducer(project, action);
}

/** 素材庫加入還沒有的項目（以 item_id 判斷）；超過上限時不變。 */
function addLibrary(project: ImageStudioProject, items: readonly ImageLibraryItem[]): ImageStudioProject {
  const library = project.library ?? [];
  const known = new Set(library.map((item) => item.item_id));
  const fresh = items.filter((item) => !known.has(item.item_id));
  if (fresh.length === 0 || library.length + fresh.length > LIMITS.library) return project;
  return { ...project, library: [...library, ...fresh] };
}

/** 素材來自某個 take 時，把 take.library_item_id 指向它。 */
function linkTake(project: ImageStudioProject, item: ImageLibraryItem): ImageStudioProject {
  const source = item.source;
  if (source?.kind !== "image_take") return project;
  return mapImageShot(project, source.image_shot_id, (shot) => {
    const takes = changedItems(shot.takes, (take) => {
      if (take.take_id !== source.take_id || take.library_item_id === item.item_id) return take;
      return { ...take, library_item_id: item.item_id };
    });
    return takes !== null ? { ...shot, takes } : shot;
  });
}

/** 素材是否還被任何地方引用（圖片的參考與遮罩、take、影片鏡頭的參考與首幀）。 */
export function libraryItemInUse(project: ImageStudioProject, itemId: string, ignoreMaskOf?: string): boolean {
  for (const shot of imageShots(project)) {
    if (shot.references.some((ref) => ref.item_id === itemId)) return true;
    if (shot.mask_item_id === itemId && shot.image_shot_id !== ignoreMaskOf) return true;
    if (shot.takes.some((take) => take.library_item_id === itemId)) return true;
  }
  for (const shot of project.shots) {
    if ((shot.references ?? []).some((ref) => ref.item_id === itemId)) return true;
    if (firstFrameItemId(shot) === itemId) return true;
  }
  return false;
}

function shallowSame(shot: StudioImageShot, patch: ImageShotPatch): boolean {
  return Object.entries(patch).every(([key, value]) => valuesEqual(fieldValue(shot, key), value));
}

export function imageProjectReducer(project: ImageStudioProject, action: ImageProjectAction): ImageStudioProject {
  switch (action.type) {
    case "video":
      return video(project, action.action);
    case "addImageShot": {
      const shots = imageShots(project);
      if (shots.length >= LIMITS.shots || shots.some((shot) => shot.image_shot_id === action.shot.image_shot_id)) return project;
      const index = (action.afterShotId != null && action.afterShotId !== "") ? shots.findIndex((shot) => shot.image_shot_id === action.afterShotId) : -1;
      const next = [...shots];
      next.splice(index >= 0 ? index + 1 : next.length, 0, action.shot);
      return withShots(project, next);
    }
    case "updateImageShot":
      return mapImageShot(project, action.shotId, (shot) => (shallowSame(shot, action.patch) ? shot : { ...shot, ...action.patch }));
    case "removeImageShot": {
      const shots = imageShots(project);
      return shots.some((shot) => shot.image_shot_id === action.shotId) ? withShots(project, shots.filter((shot) => shot.image_shot_id !== action.shotId)) : project;
    }
    case "duplicateImageShot": {
      const shots = imageShots(project);
      const index = shots.findIndex((shot) => shot.image_shot_id === action.shotId);
      const source = shots[index];
      if (!source || shots.length >= LIMITS.shots || shots.some((shot) => shot.image_shot_id === action.newShotId)) return project;
      const copy: StudioImageShot = { ...source, ...action.patch, image_shot_id: action.newShotId, title: action.title.slice(0, 200), takes: [], active_take_id: null };
      const next = [...shots];
      next.splice(index + 1, 0, copy);
      return withShots(project, next);
    }
    case "moveImageShot": {
      const shots = imageShots(project);
      const from = shots.findIndex((shot) => shot.image_shot_id === action.shotId);
      if (from < 0) return project;
      const to = Math.max(0, Math.min(shots.length - 1, action.toIndex));
      if (from === to) return project;
      const next = [...shots];
      const [moved] = next.splice(from, 1);
      if (!moved) return project;
      next.splice(to, 0, moved);
      return withShots(project, next);
    }
    case "addImageReference":
      return mapImageShot(project, action.shotId, (shot) => {
        const result = addReference(shot, action.itemId);
        return result.patch ? { ...shot, ...result.patch } : shot;
      });
    case "addImageTakes":
      return mapImageShot(project, action.shotId, (shot) => {
        const known = new Set(shot.takes.map((take) => take.take_id));
        const fresh = action.takes.filter((take) => !known.has(take.take_id));
        if (fresh.length === 0 || shot.takes.length + fresh.length > LIMITS.takes) return shot;
        return { ...shot, takes: [...shot.takes, ...fresh] };
      });
    case "updateImageTake": {
      const shots = changedItems(imageShots(project), (shot) => {
        const index = shot.takes.findIndex((take) => take.take_id === action.takeId && take.run_id === action.runId);
        const current = shot.takes[index];
        if (!current) return shot;
        const updated = { ...current, ...action.patch };
        if (valuesEqual(updated, current)) return shot;
        const takes = [...shot.takes];
        takes[index] = updated;
        if (updated.state !== "succeeded" || current.state === "succeeded") return { ...shot, takes };
        const selected = activeImageTake(shot);
        const active = selected?.take_id ?? (action.activateOnSuccess === true ? updated.take_id : shot.active_take_id);
        return { ...shot, takes, active_take_id: active };
      });
      return shots !== null ? withShots(project, shots) : project;
    }
    case "setActiveImageTake":
      return mapImageShot(project, action.shotId, (shot) => {
        if (action.takeId !== null && !shot.takes.some((take) => take.take_id === action.takeId)) return shot;
        return shot.active_take_id === action.takeId ? shot : { ...shot, active_take_id: action.takeId };
      });
    case "removeImageTakes": {
      const runs = new Set(action.runIds);
      const shots = changedItems(imageShots(project), (shot) => {
        const takes = shot.takes.filter((take) => !runs.has(take.run_id));
        if (takes.length === shot.takes.length) return shot;
        const active = takes.some((take) => take.take_id === shot.active_take_id) ? shot.active_take_id : null;
        return { ...shot, takes, active_take_id: active };
      });
      return shots !== null ? withShots(project, shots) : project;
    }
    case "addLibraryItems": {
      let next = addLibrary(project, action.items);
      if (next === project) return project;
      for (const item of action.items) next = linkTake(next, item);
      return next;
    }
    case "setMask": {
      const shot = imageShots(project).find((item) => item.image_shot_id === action.shotId);
      if (!shot) return project;
      const nextId = action.item?.item_id ?? null;
      if (shot.mask_item_id === nextId) return project;
      let next = action.item ? addLibrary(project, [action.item]) : project;
      if (action.item && next === project && !(project.library ?? []).some((item) => item.item_id === nextId)) return project;
      next = mapImageShot(next, action.shotId, (current) => ({ ...current, mask_item_id: nextId, mask_invert: nextId === null ? false : current.mask_invert }));
      const old = shot.mask_item_id;
      const oldItem = (old != null && old !== "") ? (next.library ?? []).find((item) => item.item_id === old) : undefined;
      if (oldItem?.note === MASK_NOTE && !libraryItemInUse(next, oldItem.item_id)) {
        next = { ...next, library: (next.library ?? []).filter((item) => item.item_id !== oldItem.item_id) };
      }
      return next;
    }
    case "attachToVideoShot": {
      const target = project.shots.find((shot) => shot.shot_id === action.videoShotId);
      if (!target) return project;
      // 首幀：比例與專案畫面不同（H3 會拉伸變形）時整個動作不生效（畫面已停用並說明）
      if (action.use === "fl2va" && firstFrameBlockedReason(project, action.item) !== null) return project;
      let shot: StudioShot = target;
      if (action.use === "ref2va") {
        const attached = attachReference(target, action.item, action.refId);
        if (attached.shot) shot = attached.shot;
        // 超過 H3 限制：整個動作不生效（不留下半套）；已經是這個鏡頭的參考時只改路由
        else if (!(target.references ?? []).some((ref) => ref.item_id === action.item.item_id)) return project;
      } else {
        shot = attachFirstFrame(target, action.item.item_id);
      }
      if (action.route !== null && action.route !== shot.route) shot = { ...shot, route: action.route };
      const known = (project.library ?? []).some((item) => item.item_id === action.item.item_id);
      let next = known ? project : addLibrary(project, [action.item]);
      if (!known && next === project) return project;
      next = linkTake(next, action.item);
      if (shot === target) return next;
      return { ...next, shots: next.shots.map((item) => (item.shot_id === target.shot_id ? shot : item)) };
    }
    case "addVideoShotWith": {
      const known = (project.library ?? []).some((item) => item.item_id === action.item.item_id);
      let next = known ? project : addLibrary(project, [action.item]);
      if (!known && next === project) return project;
      next = linkTake(next, action.item);
      return video(next, { type: "addShot", shot: action.shot, afterShotId: action.afterShotId });
    }
  }
}
