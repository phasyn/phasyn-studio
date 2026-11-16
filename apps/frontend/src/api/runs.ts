// Run：POST 建立（202）、列表（cursor）、明細、取消。沒有恢復（resume）；重新執行就是新的 run。
// Every run read and write in the app goes through these functions (one queryFn per key, writes never retried).
import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CancelResult } from "./generated/contracts";
import { apiJson } from "./http";
import { POLL, qk } from "./keys";
import { studioKeys } from "./studioProjects";
import type { RunPage, RunRequestBody, WireRun } from "./types";

/** 列表要不要包含已封存的 run（預設不含）。 */
export type ArchivedFilter = "exclude" | "include" | "only";

export function fetchRunPage(limit: number, cursor: string | null, signal?: AbortSignal, archived: ArchivedFilter = "exclude"): Promise<RunPage> {
  return apiJson<RunPage>("/api/runs", { query: { limit, cursor, archived }, signal });
}

/** 分頁列表；有 running 的 run 時才輪詢。 */
export function useRunList(limit = 50, archived: ArchivedFilter = "exclude") {
  return useInfiniteQuery({
    queryKey: qk.runList(limit, archived),
    queryFn: ({ pageParam, signal }) => fetchRunPage(limit, pageParam, signal, archived),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some((run) => run.state === "running")) ? POLL.runList : false,
    staleTime: 1000,
  });
}

export function fetchRun(runId: string, signal?: AbortSignal): Promise<WireRun> {
  return apiJson<WireRun>(`/api/runs/${encodeURIComponent(runId)}`, { signal });
}

/** POST /api/runs (202). Never retried: a lost response means the run may exist, so the caller re-reads instead. */
export function createRun(body: RunRequestBody): Promise<WireRun> {
  return apiJson<WireRun>("/api/runs", { method: "POST", json: body });
}

export function cancelRun(runId: string): Promise<CancelResult> {
  return apiJson<CancelResult>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/** The single query definition for one run: polls while it is running. An empty id disables the query. */
export function runQueryOptions(runId: string) {
  return queryOptions({
    queryKey: qk.run(runId),
    queryFn: ({ signal }) => fetchRun(runId, signal),
    enabled: runId.length > 0,
    refetchInterval: (query) => (query.state.data?.state === "running" ? POLL.activeRun : false),
    staleTime: 1000,
  });
}

export function useRun(runId: string | null) {
  return useQuery(runQueryOptions(runId ?? ""));
}

/** Read-only view of a run already in the cache (never fetches; updates when another reader refreshes it). */
export function useCachedRun(runId: string | null) {
  return useQuery({ ...runQueryOptions(runId ?? ""), enabled: false });
}

/** Page size of the shared run list behind useActiveRuns (one key app-wide, so one poll). */
export const ACTIVE_RUN_LIST_LIMIT = 50;

const NO_RUNS: readonly WireRun[] = [];

/** The runs executing now (state running; the Controller may run several at once), newest first, from the shared run list. */
export function useActiveRuns(): { runs: readonly WireRun[]; isPending: boolean } {
  const list = useRunList(ACTIVE_RUN_LIST_LIMIT);
  const items = list.data?.pages[0]?.items;
  const runs = useMemo(() => {
    const running = items?.filter((item) => item.state === "running") ?? [];
    return running.length > 0 ? running : NO_RUNS;
  }, [items]);
  return { runs, isPending: list.isPending };
}

export function useCreateRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createRun,
    onSuccess: (run) => {
      client.setQueryData(qk.run(run.run_id), run);
      void client.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

export function useCancelRun(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => cancelRun(runId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.run(runId) });
      void client.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

// ------------------------------------------------------------------ 封存與永久刪除（x-phasyn-extension）

/** 永久刪除的計畫／結果中的一個檔案（run 產生的輸出與其連結檔，例如 latent 的 blob）。 */
export interface PurgeFile {
  node_id: string;
  file_id: string;
  size_bytes: number | null;
  /** planned＝試算；deleted／missing（本來就不在）＝已處理；failed＝刪不到（Node 離線等）。 */
  status: "planned" | "deleted" | "missing" | "failed";
  code?: string;
  message?: string;
}

/** 會被移除引用的 Studio 專案（take 與匯出）。 */
export interface PurgeProject {
  project_id: string;
  title: string;
  takes_removed: string[];
  exports_removed: string[];
  revision: number | null;
}

export interface PurgeResult {
  run_id: string;
  dry_run: boolean;
  deleted: boolean;
  files: PurgeFile[];
  recordings: { planned: number; deleted: number };
  projects: PurgeProject[];
}

/** 試算：列出永久刪除會影響的檔案、效能紀錄與 Studio 專案，不做任何變更（query key：qk.runPurgePlan）。 */
export function fetchPurgePlan(runId: string, signal?: AbortSignal): Promise<PurgeResult> {
  return apiJson<PurgeResult>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE", query: { dry_run: true }, signal });
}

/**
 * 永久刪除：先刪 Node 上的檔案，再刪效能紀錄、移除 Studio 專案中的引用，最後刪 run 紀錄。
 * 任何檔案刪不到時伺服器整筆停下（不刪紀錄、不改專案）並回錯誤；不自動重試。
 */
export function purgeRun(runId: string): Promise<PurgeResult> {
  return apiJson<PurgeResult>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE", query: { dry_run: false } });
}

export function setRunArchived(runId: string, archived: boolean): Promise<WireRun> {
  return apiJson<WireRun>(`/api/runs/${encodeURIComponent(runId)}/archive`, { method: "POST", json: { archived } });
}

/**
 * Data to re-read after runs are archived or purged: run lists and details; after a purge also recordings and the
 * Studio project list and documents (the server removed their references to the purged runs).
 */
export function invalidateAfterRunChange(client: QueryClient, runIds: readonly string[], purged: boolean): void {
  void client.invalidateQueries({ queryKey: qk.runs() });
  for (const runId of runIds) {
    client.removeQueries({ queryKey: qk.runPurgePlan(runId) });
    if (purged) client.removeQueries({ queryKey: qk.run(runId) });
    else void client.invalidateQueries({ queryKey: qk.run(runId) });
  }
  if (purged) {
    void client.invalidateQueries({ queryKey: qk.recordings() });
    void client.invalidateQueries({ queryKey: studioKeys.projects() });
    void client.invalidateQueries({ queryKey: studioKeys.allProjects() });
  }
}

export function useArchiveRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, archived }: { runId: string; archived: boolean }) => setRunArchived(runId, archived),
    onSuccess: (run) => client.setQueryData(qk.run(run.run_id), run),
    onSettled: (_data, _error, variables) => invalidateAfterRunChange(client, [variables.runId], false),
  });
}
