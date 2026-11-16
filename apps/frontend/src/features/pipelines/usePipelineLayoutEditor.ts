// 元件組合分類與排序的編輯狀態（左欄與清單頁共用）：清單＋分類（已正規化）、能不能調整、保存中、
// 套用變更（樂觀更新後依序保存）、給輔助技術的宣告與看得到的錯誤訊息。
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { qk } from "@/api/keys";
import { layoutSaveEpoch, usePipelineLayout, usePipelines, useSavePipelineLayout } from "@/api/pipelines";
import { normalizeLayout, type LayoutContent } from "./layoutModel";
import { layoutBlockedReason, layoutSaveErrorMessage } from "./layoutMessages";

const NBSP = String.fromCharCode(0xa0);

export function usePipelineLayoutEditor() {
  const client = useQueryClient();
  const pipelines = usePipelines();
  const layout = usePipelineLayout();
  const save = useSavePipelineLayout();
  const saving = useIsMutating({ mutationKey: qk.pipelineLayoutSave() }) > 0;
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const items = pipelines.data?.items;
  const content: LayoutContent | null = items && layout.data ? normalizeLayout(layout.data, items.map((item) => item.pipeline_id)) : null;
  const blockedReason = layoutBlockedReason({
    pipelinesReady: Boolean(items),
    layoutPending: layout.isPending,
    layoutError: layout.data ? null : layout.error,
  });

  /** polite live region；同一句話連續出現時加不換行空白，讓螢幕閱讀器再唸一次。 */
  const announce = (message: string) => setAnnouncement((previous) => (previous === message ? `${message}${NBSP}` : message));

  /** 套用新的分類與排序：畫面立即更新，保存成功後宣告 message；失敗時還原並說明。 */
  const commit = (next: LayoutContent, message: string) => {
    if (!content) return;
    setError(null);
    save.mutate(
      { content: next, epoch: layoutSaveEpoch(client) },
      {
        onSuccess: () => announce(message),
        onError: (failure) => {
          const text = layoutSaveErrorMessage(failure);
          setError(text);
          announce(text);
        },
      },
    );
  };

  return {
    pipelines,
    layout,
    /** 正規化後的分類與排序；清單或分類尚未讀到（或讀取失敗）時為 null。 */
    content,
    /** 不能調整分類與排序的原因；null＝可以。 */
    blockedReason,
    saving,
    commit,
    announcement,
    announce,
    /** 最近一次保存失敗的說明（看得到的訊息）。 */
    error,
    dismissError: () => setError(null),
  };
}

export type PipelineLayoutEditor = ReturnType<typeof usePipelineLayoutEditor>;
