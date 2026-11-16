// DiT 去噪的即時進度：找出 run 中 DiT 步驟對應的 recording（執行中以 call_id 對到 recording context），
// 增量讀取 runtime stream 事件（after_seq＝已讀到的最大 seq），交給 model/progress.ts 推算。
// 只發 GET；DiT 步驟執行中且 poll=true 才輪詢（約 1.5 秒）；離開頁面時 React Query 以 signal 中止進行中的請求。
// 同一個 recording 的事件快取由所有使用者共用：佇列與渲染詳情同時顯示時，只讓其中一個 poll，另一個只讀快取。
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { EventPage } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { fetchRecordingEvents, fetchRecordingPage } from "@/api/recordings";
import { studioKeys } from "@/api/studioProjects";
import type { WireRun } from "@/api/types";
import { buildBranchViews, ditBranches, emptyStepLog, findBranchRecording, foldEvents, type BranchView, type ProviderLookup, type StepLog } from "../model/progress";
import { t } from "@/i18n";

export const PROGRESS_POLL_MS = 1500;
const EVENT_PAGE_LIMIT = 1000;
const MAX_PAGES_PER_FETCH = 8;

export const progressKeys = {
  stepLog: (recordingId: string) => ["studio", "dit-step-log", recordingId] as const,
};

/** 這個 run 的 invoke 紀錄（與「實測指標」面板共用同一個 query key 與查詢）。 */
export function runRecordingsOptions(runId: string, running: boolean) {
  return queryOptions({
    queryKey: studioKeys.runRecordings(runId),
    queryFn: ({ signal }) => fetchRecordingPage({ run_id: runId, operation: "invoke", limit: 50 }, signal),
    refetchInterval: running ? 3000 : false,
    staleTime: 2000,
  });
}

export type FetchEventPage = (recordingId: string, afterSeq: number, signal?: AbortSignal) => Promise<EventPage>;

export const fetchRuntimeEvents: FetchEventPage = (recordingId, afterSeq, signal) =>
  fetchRecordingEvents(recordingId, { stream_id: "runtime", ...(afterSeq > 0 ? { after_seq: afterSeq } : {}), limit: EVENT_PAGE_LIMIT }, signal);

/** recording 還沒上報到主控、stream 尚未建立：暫時狀態，保留目前紀錄，下一輪再讀。 */
function transient(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.code === "AMBIGUOUS_STREAM" || error.code === "RECORDING_NOT_FOUND");
}

/** 從 base.lastSeq 之後增量讀取（has_more 時接著讀，最多 maxPages 頁）並併入逐步紀錄；沒有新事件時回傳 base 本身。 */
export async function fetchStepLog(fetchPage: FetchEventPage, recordingId: string, base: StepLog, signal?: AbortSignal, maxPages = MAX_PAGES_PER_FETCH): Promise<StepLog> {
  let log = base;
  for (let page = 0; page < maxPages; page += 1) {
    let result: EventPage;
    try {
      result = await fetchPage(recordingId, log.lastSeq, signal);
    } catch (error) {
      if (transient(error)) return log;
      throw error;
    }
    const before = log.lastSeq;
    log = foldEvents(log, result.events, { gap: result.gap });
    if (!result.has_more || log.lastSeq <= before) break;
  }
  return log;
}

/** 一個 DiT recording 的逐步紀錄：每次查詢從快取中的紀錄接著讀（增量），live 時才輪詢。 */
export function stepLogOptions(recordingId: string, live: boolean) {
  return queryOptions({
    queryKey: progressKeys.stepLog(recordingId),
    queryFn: ({ client, queryKey, signal }) => fetchStepLog(fetchRuntimeEvents, recordingId, client.getQueryData<StepLog>(queryKey) ?? emptyStepLog(), signal),
    enabled: live,
    refetchInterval: live ? PROGRESS_POLL_MS : false,
    staleTime: 1000,
    retry: false,
    structuralSharing: false,
    refetchOnWindowFocus: false,
  });
}

export interface RunProgress {
  /** 每個 DiT 分支（單一分支或 _0、_1…）的進度。 */
  views: BranchView[];
  /** 讀取逐步事件失敗（網路等）；下一輪輪詢會再讀，不影響 run 本身。 */
  error: string | null;
}

/**
 * run 的 DiT 進度。run 由呼叫端提供（渲染詳情的 useRun、或 render tracker 已在輪詢的快取），這裡不另外輪詢 run。
 * poll=false 時只讀快取（另一個畫面正在輪詢同一個 run）。lookup：步驟元件 → provider（DiT 步驟依 provider 找，不依 id）。
 */
export function useRunProgress(run: WireRun | undefined, options: { poll: boolean; lookup?: ProviderLookup }): RunProgress {
  const runId = run?.run_id ?? "";
  const running = run?.state === "running";
  const branches = ditBranches(run, options.lookup);
  const recordings = useQuery({
    ...runRecordingsOptions(runId, running),
    // 只在「DiT 執行中但還找不到它的 recording」時查；找到後交給實測指標面板的輪詢（若有開著）。
    enabled: (query) =>
      options.poll && running && runId !== "" && branches.some((branch) => branch.step.state === "running" && !branch.step.recording_id && !findBranchRecording(branch.step, query.state.data?.items ?? [])),
  });
  const items = recordings.data?.items ?? [];
  const known = buildBranchViews(run, items, new Map(), options.lookup).flatMap((view) => (view.recordingId ? [{ recordingId: view.recordingId, live: view.phase === "live" }] : []));
  const logs = useQueries({
    queries: known.map(({ recordingId, live }) => stepLogOptions(recordingId, options.poll && live)),
  });
  const byId = new Map<string, StepLog>();
  known.forEach(({ recordingId }, index) => {
    const data = logs[index]?.data;
    if (data) byId.set(recordingId, data);
  });
  const failed = logs.find((result) => result.isError)?.error;
  return {
    views: buildBranchViews(run, items, byId, options.lookup),
    error: failed ? (isApiError(failed) ? t("{code}：{message}", { code: failed.code, message: failed.message }) : failed.message) : null,
  };
}
