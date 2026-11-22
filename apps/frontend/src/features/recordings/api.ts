// 紀錄頁的資料存取（唯讀查詢＋一個明確的補抓寫入）。所有讀取只走 Controller 的本地副本；
// 寫入（fetch-history）不自動重送：逾時或斷線顯示「遠端結果未知」，由使用者重新讀取狀態。
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { FetchHistoryRequest, Recording, RecordingPage, RecordingStream } from "@/api/generated/contracts";
import { fetchCatalog } from "@/api/catalog";
import { apiFetch, exportUrl, isApiError } from "@/api/http";
import { qk } from "@/api/keys";
import { fetchRecording, fetchRecordingEvents, fetchRecordingHistory, fetchRecordingPage, recordingStreams, retryRead } from "@/api/recordings";
import { filtersKey, type RecordingFilters } from "./model/filters";
import { parseChromeTrace, type TraceModel } from "./model/trace";

export const LIST_PAGE_SIZE = 50;
/** The largest page GET /api/recordings returns (the store's MAX_PAGE). */
const MAX_LIST_PAGE_SIZE = 200;
export const EVENT_PAGE_SIZE = 1000;
/** 超過此大小的 trace 不在頁面內解析／暫存，改用瀏覽器直接下載。 */
export const TRACE_INLINE_LIMIT_BYTES = 64 * 1024 * 1024;

const ROOT = qk.recordings();

export const recordingKeys = {
  all: ROOT,
  lists: () => [...ROOT, "list"] as const,
  list: (filters: RecordingFilters) => [...ROOT, "list", filtersKey(filters)] as const,
  detail: (id: string) => [...ROOT, "detail", id] as const,
  streams: (id: string) => [...ROOT, "streams", id] as const,
  /** Every event query of one recording (the activity log's event tails extend the same key). */
  eventsOf: qk.recordingEvents,
  events: (id: string, streamId: string) => [...qk.recordingEvents(id), streamId] as const,
  loadFor: (id: string) => [...ROOT, "load-for", id] as const,
  trace: (id: string) => [...ROOT, "trace", id] as const,
  nodeLabels: () => [...ROOT, "node-labels"] as const,
  /** The ids the Controller index lists for each run (refreshed with any recording change under ROOT). */
  runIndexes: () => [...ROOT, "run-index"] as const,
  runIndex: (runId: string) => [...ROOT, "run-index", runId] as const,
};

/** Pages read for one run's index before giving up (200 per page): far beyond any pipeline, and never an endless loop. */
const RUN_INDEX_MAX_PAGES = 20;

/**
 * The recording ids the Controller index holds for a run (GET /api/recordings?run_id=…, every page). It answers what the
 * Controller has now: deleting a recording leaves its id in the run document. Throws when the pages do not end, so a
 * partial list is never taken for the whole.
 */
export async function fetchRunRecordingIds(runId: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < RUN_INDEX_MAX_PAGES; page += 1) {
    const result = await fetchRecordingPage({ run_id: runId, cursor, limit: MAX_LIST_PAGE_SIZE }, signal);
    for (const item of result.items) ids.add(item.context.recording_id);
    const next = result.next_cursor ?? null;
    if (next === null) return ids;
    if (seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  throw new Error(`recording index of run ${runId} did not end after ${String(RUN_INDEX_MAX_PAGES)} pages`);
}

/**
 * The Controller index's recording ids of one run. `data` stays undefined until a read succeeds (while pending, or when
 * the first read failed): callers then treat the index as unknown and report nothing as missing. Only active when
 * `enabled`.
 */
export function useRunRecordingIndex(runId: string, enabled: boolean) {
  return useQuery({
    queryKey: recordingKeys.runIndex(runId),
    queryFn: ({ signal }) => fetchRunRecordingIds(runId, signal),
    enabled: enabled && runId.length > 0,
    staleTime: 10_000,
    retry: retryRead,
  });
}

export function useRecordingList(filters: RecordingFilters) {
  return useInfiniteQuery({
    queryKey: recordingKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      fetchRecordingPage({ ...filtersKey(filters), cursor: pageParam, limit: LIST_PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchOnWindowFocus: false,
    retry: retryRead,
  });
}

function findInLists(client: QueryClient, id: string): Recording | undefined {
  for (const [, data] of client.getQueriesData<InfiniteData<RecordingPage>>({ queryKey: recordingKeys.lists() })) {
    for (const page of data?.pages ?? []) {
      const found = page.items.find((item) => item.context.recording_id === id);
      if (found) return found;
    }
  }
  return undefined;
}

/** 單筆紀錄；先以列表中的同筆資料當佔位，執行中（running）每 3 秒更新 summary。 */
export function useRecording(id: string | undefined) {
  const client = useQueryClient();
  return useQuery<Recording>({
    queryKey: recordingKeys.detail(id ?? ""),
    queryFn: ({ signal }) => fetchRecording(id ?? "", signal),
    enabled: Boolean(id),
    placeholderData: (): Recording | undefined => ((id != null && id !== "") ? findInLists(client, id) : undefined),
    refetchInterval: (query) => (query.state.data?.summary.state === "running" ? 3000 : false),
    retry: retryRead,
  });
}

export interface StreamDiscovery {
  streams: RecordingStream[];
  /** 有多個 stream（seq 各自從 1 開始，彼此沒有全序）。 */
  ambiguous: boolean;
}

/** 這筆 recording 有哪些 event stream（主控的 GET /api/recordings/{id} 直接列出）。 */
export async function fetchStreamDiscovery(id: string, signal?: AbortSignal): Promise<StreamDiscovery> {
  const streams = recordingStreams(await fetchRecording(id, signal));
  return { streams, ambiguous: streams.length > 1 };
}

/** 探索 stream（見 fetchStreamDiscovery）；enabled=false 時只讀已載入的資料。 */
export function useEventStreams(id: string, enabled = true) {
  return useQuery({
    queryKey: recordingKeys.streams(id),
    enabled: enabled && Boolean(id),
    staleTime: 30_000,
    retry: retryRead,
    queryFn: ({ signal }) => fetchStreamDiscovery(id, signal),
  });
}

/**
 * 單一 stream 的事件分頁（after_seq → next_seq）。時間軸、記憶體曲線、原始事件與右側檢視器共用同一份快取；
 * enabled=false 時只讀已載入的資料，不發請求。
 */
export function useStreamEvents(id: string, streamId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: recordingKeys.events(id, streamId ?? ""),
    queryFn: ({ pageParam, signal }) => fetchRecordingEvents(id, { stream_id: streamId ?? "", after_seq: pageParam, limit: EVENT_PAGE_SIZE }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastParam) => {
      if (!last.has_more || last.next_seq === null) return undefined;
      // 伺服器若回報 has_more 卻沒有前進，停止翻頁（避免無限迴圈）。
      if (last.events.length === 0 && last.next_seq <= lastParam) return undefined;
      return last.next_seq;
    },
    enabled: enabled && Boolean(id) && Boolean(streamId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: retryRead,
  });
}

/** 明確從 Node 補抓 log／事件到主控索引；不執行、不派送、不恢復任何工作。不自動重送。 */
export function useFetchHistory(recordingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: FetchHistoryRequest) => fetchRecordingHistory(recordingId, body),
    retry: false,
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: recordingKeys.detail(recordingId) }),
        client.invalidateQueries({ queryKey: recordingKeys.streams(recordingId) }),
        client.invalidateQueries({ queryKey: recordingKeys.eventsOf(recordingId) }),
        // A recording fetched back after it was deleted is in the index again: lists and run pages follow
        client.invalidateQueries({ queryKey: recordingKeys.lists() }),
        client.invalidateQueries({ queryKey: recordingKeys.runIndexes() }),
      ]),
  });
}

/** node_id → 顯示名稱（Catalog directory／nodes）；讀不到時頁面改顯示 ID，不阻擋紀錄查詢。 */
export function useNodeLabels() {
  return useQuery({
    queryKey: recordingKeys.nodeLabels(),
    queryFn: async ({ signal }) => {
      const catalog = await fetchCatalog(signal);
      const labels = new Map<string, string>();
      for (const entry of catalog.directory) if (entry.label) labels.set(entry.node_id, entry.label);
      for (const node of catalog.nodes) if (node.label && !labels.has(node.node_id)) labels.set(node.node_id, node.label);
      return labels;
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** 找同一程序（process_instance_id）在此 invoke 之前的 load 紀錄；只查最近 50 筆，找不到就不顯示。 */
export function useLoadRecordingFor(recording: Recording | undefined) {
  const context = recording?.context;
  const enabled = Boolean(context?.operation === "invoke" && context.node_id && context.component_id);
  return useQuery({
    queryKey: recordingKeys.loadFor(context?.recording_id ?? ""),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<Recording | null> => {
      if (!context) return null;
      const page = await fetchRecordingPage({ node_id: context.node_id, component_id: context.component_id, operation: "load", until: context.created_at, limit: 50 }, signal);
      return (
        page.items.find(
          (item) =>
            item.context.operation === "load" &&
            item.context.process_instance_id === context.process_instance_id &&
            item.context.recording_id !== context.recording_id,
        ) ?? null
      );
    },
  });
}

export function isTraceMissing(error: unknown): boolean {
  return isApiError(error) && (error.code === "TRACE_UNAVAILABLE" || error.status === 404);
}

export type TraceDownload = { kind: "blob"; blob: Blob } | { kind: "too-large"; bytes: number };

/** 下載 trace：404／TRACE_UNAVAILABLE 由呼叫端顯示「此 recording 沒有 trace」；過大時改由瀏覽器直接下載。 */
export async function fetchTrace(recordingId: string, signal?: AbortSignal): Promise<TraceDownload> {
  const response = await apiFetch(exportUrl(recordingId, "trace"), { signal, headers: { Accept: "application/json, */*" } });
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length > TRACE_INLINE_LIMIT_BYTES) {
    await response.body?.cancel();
    return { kind: "too-large", bytes: length };
  }
  return { kind: "blob", blob: await response.blob() };
}

/** 載入並解析 trace（只在使用者按下「載入 trace」後啟用）。 */
export function useTraceModel(recordingId: string, requested: boolean) {
  return useQuery({
    queryKey: recordingKeys.trace(recordingId),
    enabled: requested,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async ({ signal }): Promise<TraceModel | { tooLarge: number }> => {
      const download = await fetchTrace(recordingId, signal);
      if (download.kind === "too-large") return { tooLarge: download.bytes };
      const parsed: unknown = JSON.parse(await download.blob.text());
      return parseChromeTrace(parsed);
    },
  });
}
