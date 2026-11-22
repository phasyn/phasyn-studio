// 推理頁的輸入草稿：依 pipeline_id 分開保存在記憶體（這個瀏覽器分頁的工作階段內）。
// 切換元件組合、去看 run 明細再回來都保留；重新整理頁面後清空（已上傳的檔仍在主控上）。
// 進行中的上傳也依 pipeline_id 計數：上傳完成前不能建立 run（否則會送出舊檔或不完整的素材清單）。
import { useSyncExternalStore } from "react";
import { EMPTY_DRAFT, type InferenceDraft } from "./model/inputs";

const drafts = new Map<string, InferenceDraft>();
const uploading = new Map<string, number>();
const listeners = new Set<() => void>();
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function getDraft(pipelineId: string): InferenceDraft {
  return drafts.get(pipelineId) ?? EMPTY_DRAFT;
}

export function updateDraft(pipelineId: string, update: (draft: InferenceDraft) => InferenceDraft): void {
  drafts.set(pipelineId, update(getDraft(pipelineId)));
  emit();
}

export function clearDraft(pipelineId: string): void {
  if (!drafts.delete(pipelineId)) return;
  emit();
}

/** 開始一批上傳（這個元件組合的草稿）；回傳結束函式，在 finally 呼叫（重複呼叫無效）。 */
export function beginUpload(pipelineId: string): () => void {
  uploading.set(pipelineId, uploadsInFlight(pipelineId) + 1);
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = uploadsInFlight(pipelineId) - 1;
    if (left > 0) uploading.set(pipelineId, left);
    else uploading.delete(pipelineId);
    emit();
  };
}

export function uploadsInFlight(pipelineId: string): number {
  return uploading.get(pipelineId) ?? 0;
}

export function useUploadsInFlight(pipelineId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => uploadsInFlight(pipelineId),
    () => 0,
  );
}

export function useDraft(pipelineId: string): InferenceDraft {
  return useSyncExternalStore(
    subscribe,
    () => getDraft(pipelineId),
    () => EMPTY_DRAFT,
  );
}

const fileNames = new Map<string, string>();

/** 上傳時的原始檔名（FileRef 不帶檔名）；只用於顯示。 */
export function rememberFileName(fileId: string, name: string): void {
  fileNames.set(fileId, name);
}

export function fileNameOf(fileId: string): string | null {
  return fileNames.get(fileId) ?? null;
}

/** 素材清單的本機 key（非安全來源的內網 HTTP 沒有 crypto.randomUUID）。 */
export function nextMaterialKey(fileId: string): string {
  sequence += 1;
  return `${fileId}:${String(sequence)}`;
}
