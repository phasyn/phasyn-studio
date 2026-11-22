// 比較頁資料：GET /api/comparisons（2–8 筆）、各 recording 的 context（欄標題用），以及挑選用的最近紀錄。
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Recording } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { fetchRecording, fetchRecordingPage, retryRead } from "@/api/recordings";
import { recordingKeys } from "../api";
import { MAX_COMPARE } from "../model/compareStore";

export const comparisonKeys = {
  one: (ids: readonly string[]) => ["comparisons", ids.join(",")] as const,
  recent: (componentId: string) => ["comparisons", "recent", componentId] as const,
};

export function useComparison(ids: readonly string[]) {
  return useQuery({
    queryKey: comparisonKeys.one(ids),
    queryFn: ({ signal }) => contractJson("Comparison", "/api/comparisons", { query: { recording_ids: ids.join(",") }, signal }),
    enabled: ids.length >= 2 && ids.length <= MAX_COMPARE,
    staleTime: 30_000,
    retry: retryRead,
  });
}

export interface RecordingQueryState {
  data: Recording | undefined;
  error: unknown;
  isPending: boolean;
}

function combineStates(results: readonly { data: Recording | undefined; error: unknown; isPending: boolean }[]): RecordingQueryState[] {
  return results.map((result) => ({ data: result.data, error: result.error, isPending: result.isPending }));
}

/** 每個 recording 的 context／summary（與紀錄頁共用快取）；回傳順序與 ids 相同。 */
export function useRecordingsByIds(ids: readonly string[]): RecordingQueryState[] {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: recordingKeys.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRecording(id, signal),
      staleTime: 30_000,
      retry: retryRead,
    })),
    combine: combineStates,
  });
}

export function useRecentRecordings(componentId: string, enabled: boolean) {
  return useQuery({
    queryKey: comparisonKeys.recent(componentId),
    queryFn: ({ signal }) => fetchRecordingPage({ ...(componentId ? { component_id: componentId } : {}), limit: 20 }, signal),
    enabled,
    staleTime: 15_000,
    retry: retryRead,
  });
}
