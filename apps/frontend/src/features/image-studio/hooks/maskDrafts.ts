// 還沒保存的遮罩（這個分頁的記憶體）：繪製中的遮罩以圖片為單位保存，切到別的分頁或別張圖片再回來不會遺失；
// 按「保存遮罩」或「生成」時才上傳成專案素材庫的一張 PNG（白＝新內容、黑＝保留底圖）並寫進圖片的 mask_item_id。
// 重新整理頁面會遺失（離開前瀏覽器會提醒）。
import { useSyncExternalStore } from "react";
import { uploadBlob } from "@/api/files";
import { newLocalId } from "@/features/studio";
import { maskExportPixels } from "../model/mask";
import { MASK_NOTE, type ImageProjectAction } from "../model/project";
import type { ImageLibraryItem, StudioImageShot } from "../types";
import { t } from "@/i18n";

export interface MaskDraft {
  width: number;
  height: number;
  /** 編輯中的遮罩像素（RGBA，白色＋alpha）。 */
  data: Uint8ClampedArray;
}

const drafts = new Map<string, MaskDraft>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export const maskDrafts = {
  get: (shotId: string): MaskDraft | null => drafts.get(shotId) ?? null,
  has: (shotId: string): boolean => drafts.has(shotId),
  set: (shotId: string, draft: MaskDraft): void => {
    drafts.set(shotId, draft);
    emit();
  },
  clear: (shotId: string): void => {
    if (drafts.delete(shotId)) emit();
  },
  count: (): number => drafts.size,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** 這張圖片有沒有還沒保存的遮罩（變動時重新 render）。 */
export function useMaskDraftDirty(shotId: string | null): boolean {
  useSyncExternalStore(maskDrafts.subscribe, () => version, () => 0);
  return shotId !== null && maskDrafts.has(shotId);
}

let warning = false;

/** 有未保存的遮罩時，關閉或重新整理頁面前提醒（只註冊一次）。 */
export function warnUnsavedMasks(): void {
  if (warning) return;
  warning = true;
  window.addEventListener("beforeunload", (event) => {
    if (maskDrafts.count() > 0) event.preventDefault();
  });
}

/** 遮罩 → 灰階 PNG（疊在黑底上；白＝新內容、黑＝保留底圖）。 */
export async function maskPng(draft: MaskDraft): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = draft.width;
  canvas.height = draft.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("瀏覽器無法建立遮罩畫布"));
  const pixels = maskExportPixels(draft.data);
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), draft.width, draft.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, "image/png"); });
  if (!blob) throw new Error(t("瀏覽器無法匯出遮罩 PNG"));
  return blob;
}

/**
 * 上傳還沒保存的遮罩並回傳要套用的動作（setMask）；沒有草稿時 null。上傳只送一次，失敗丟出錯誤（不重送，
 * 草稿保留，由使用者再按一次）。成功後清掉草稿。
 */
export async function uploadMaskDraft(shot: Pick<StudioImageShot, "image_shot_id" | "title">): Promise<ImageProjectAction | null> {
  const draft = maskDrafts.get(shot.image_shot_id);
  if (!draft) return null;
  const blob = await maskPng(draft);
  const file = await uploadBlob(blob, "image/png");
  const item: ImageLibraryItem = {
    item_id: newLocalId("mask"),
    kind: "image",
    name: t("遮罩・{value}.png", { value: shot.title || t("圖片") }).slice(0, 200),
    file,
    created_at: new Date().toISOString(),
    duration_seconds: null,
    width: draft.width,
    height: draft.height,
    has_audio: false,
    note: MASK_NOTE,
    source: { kind: "upload" },
  };
  // 上傳期間又畫了新的筆觸：保留新的草稿（下次再保存），這次只寫入已上傳的版本
  if (maskDrafts.get(shot.image_shot_id) === draft) maskDrafts.clear(shot.image_shot_id);
  return { type: "setMask", shotId: shot.image_shot_id, item };
}
