// 元件組合清單頁的一次性提醒，經由導覽 state 帶過去。刪除時伺服器回 NOT_FOUND（已在其他視窗或分頁刪除）：
// useDeletePipeline 立刻從快取移除它，開著的編輯器隨後就會卸載——說明要顯示在清單上，不能放在編輯器的確認框裡。
import { isNotFound } from "@/api/pipelines";
import { isRecord } from "@/lib/json";

export interface PipelineListNotice {
  kind: "already-deleted";
  pipelineId: string;
}

/** 刪除失敗後要不要直接回到清單：NOT_FOUND＝回到清單並帶著說明（導覽 state）；其他錯誤留在確認框（null）。 */
export function leaveAfterDeleteError(error: unknown, pipelineId: string): { notice: PipelineListNotice } | null {
  return isNotFound(error) ? { notice: { kind: "already-deleted", pipelineId } } : null;
}

export function readListNotice(state: unknown): PipelineListNotice | null {
  if (!isRecord(state) || !isRecord(state.notice)) return null;
  const { kind, pipelineId } = state.notice;
  return kind === "already-deleted" && typeof pipelineId === "string" ? { kind, pipelineId } : null;
}
