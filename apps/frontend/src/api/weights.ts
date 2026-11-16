// 模型權重（x-phasyn-extension）：元件的權重計畫與每個檔案的狀態、使用者同意授權後的
// 下載與取消。下載是 Node 的背景工作：開始後以 GET weights 輪詢（下載中每秒一次）；寫入一律不自動重送。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WeightsDownloadJob, WeightsDownloadRequest, WeightsView } from "./generated/contracts";
import { apiJson } from "./http";
import { POLL, qk } from "./keys";

function weightsPath(nodeId: string, componentId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/components/${encodeURIComponent(componentId)}/weights`;
}

export function fetchWeights(nodeId: string, componentId: string, signal?: AbortSignal): Promise<WeightsView> {
  return apiJson<WeightsView>(weightsPath(nodeId, componentId), { signal });
}

/** 權重計畫與狀態（第一次讀取時 Node 會在 runtime 裡列出計畫）；下載進行中每秒重新讀一次。 */
export function useComponentWeights(nodeId: string, componentId: string, enabled = true) {
  return useQuery({
    queryKey: qk.weights(nodeId, componentId),
    queryFn: ({ signal }) => fetchWeights(nodeId, componentId, signal),
    enabled,
    retry: false,
    staleTime: 5000,
    refetchInterval: (query) => (query.state.data?.job?.state === "running" ? POLL.weightsDownload : false),
  });
}

/** 開始下載（本文必須帶 accept_licenses: true）；Node 立即回覆已開始的工作。 */
export function useStartWeightsDownload(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: WeightsDownloadRequest) => apiJson<WeightsDownloadJob>(`${weightsPath(nodeId, componentId)}/download`, { method: "POST", json: body }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.weights(nodeId, componentId) });
    },
  });
}

/** 取消下載（暫存檔保留，下次下載會接著下載）。 */
export function useCancelWeightsDownload(nodeId: string, componentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiJson<WeightsDownloadJob>(`${weightsPath(nodeId, componentId)}/cancel`, { method: "POST" }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.weights(nodeId, componentId) });
    },
  });
}
