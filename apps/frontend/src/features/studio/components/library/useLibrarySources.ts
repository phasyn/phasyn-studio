// 「從其他專案加入」讀其他專案的素材庫。專案列表沒有素材數，所以每個專案讀一次文件，快取只留下可以加入的素材（不把整份
// 文件留在記憶體）。正在看的專案立刻讀；清單上的數量依序補上，一次最多 CONCURRENCY 個（由畫面上的順序開始），免得一打開
// 就對主控送出幾十個文件讀取。專案改版（revision）後換一個快取 key，下次就讀新的。
// 讀取失敗不在背景重試：按「重試」，或再選一次那個專案時才再讀。對話框關上時沒有人再看這些查詢，還在讀的會被取消
// （signal 交給 fetchProject）。
import { queryOptions, useQueries, useQueryClient } from "@tanstack/react-query";
import type { StudioLibraryItem, StudioProjectSummary } from "@/api/generated/contracts";
import { fetchProject } from "@/api/studioProjects";
import { sourceItems } from "./libraryImport";

const CONCURRENCY = 3;

export interface LibrarySource {
  /** 可以加入的素材（sourceItems）；還沒讀到時 null。 */
  items: StudioLibraryItem[] | null;
  /** 還沒有結果：正在讀、重試中，或排著等讀。 */
  pending: boolean;
  /** 上一次讀取失敗的原因（重試中為 null）。 */
  error: unknown;
  retry: () => void;
}

const sourceKey = (summary: StudioProjectSummary) => ["studio", "library-source", summary.project_id, summary.revision] as const;

function sourceOptions(summary: StudioProjectSummary, enabled: boolean) {
  return queryOptions({
    queryKey: sourceKey(summary),
    queryFn: async ({ signal }) => sourceItems((await fetchProject(summary.project_id, signal)).library ?? []),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * projects＝可以選的專案（目前的專案不在裡面）；order＝畫面上的順序（搜尋後看得到的）；focusId＝正在看的專案。
 * 回傳每個專案（project_id）的讀取狀態。
 */
export function useLibrarySources(projects: readonly StudioProjectSummary[], order: readonly string[], focusId: string | null): ReadonlyMap<string, LibrarySource> {
  const client = useQueryClient();
  const byId = new Map(projects.map((summary) => [summary.project_id, summary]));
  // Whose turn it is, from the cache on each render: a finished read re-renders through the subscription below, and
  // the next project in line starts. The project being looked at never waits in line.
  const settled = (summary: StudioProjectSummary) => {
    const status = client.getQueryState(sourceKey(summary))?.status;
    return status === "success" || status === "error";
  };
  const turn = new Set<string>();
  for (const projectId of [...order, ...byId.keys()]) {
    if (turn.size >= CONCURRENCY) break;
    const summary = byId.get(projectId);
    if (summary && projectId !== focusId && !settled(summary)) turn.add(projectId);
  }
  if (focusId !== null) turn.add(focusId);
  const results = useQueries({ queries: projects.map((summary) => sourceOptions(summary, turn.has(summary.project_id))) });
  const sources = new Map<string, LibrarySource>();
  projects.forEach((summary, index) => {
    const result = results[index];
    if (!result) return;
    // A retried read is pending again: TanStack Query clears the error when a query without data fetches again
    sources.set(summary.project_id, {
      items: result.data ?? null,
      pending: result.isPending,
      error: result.error,
      retry: () => void result.refetch(),
    });
  });
  return sources;
}
