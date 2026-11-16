// 全域活動：run（建立、步驟開始／結束、run 結束）＋近期 recording（invoke／load／unload／controller）。
// run 列表與 AppShell、資源樹共用同一份快取（有 running 才輪詢）；「即時」只控制近期 recording 的輪詢，
// 並在 recording 指到列表還沒有的新 run 時觸發一次 run 列表重新讀取（不額外輪詢整份 run 列表）。
// 指定 runId 時只看這個 run：run 明細（與 run 頁共用快取）＋伺服器依 run_id 篩選的 recording。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useCatalog } from "@/api/catalog";
import type { Recording } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { useRun, useRunList } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { retryRead } from "@/api/recordings";
import { ACTIVITY_RECORDING_LIMIT, activityKeys, fetchRecentRecordings, fetchRunRecordings, LIVE_POLL_MS } from "./api";
import {
  activeCallIds,
  activeRunIds,
  lineFromRecording,
  linesFromRun,
  mergeLines,
  nodeLabelEntries,
  providerEntries,
  unseenRunIds,
  type LogLine,
} from "./model";
import { sourceStatus, type SourceStatus } from "./status";
import { t } from "@/i18n";

/** useRunList() 的預設筆數：與 AppShell 共用同一個 query key，不重複請求。 */
const RUN_LIST_LIMIT = 50;

export interface ActivityFeed {
  /** 由舊到新。 */
  lines: LogLine[];
  status: { runs: SourceStatus; recordings: SourceStatus };
  /** 任一來源正在讀取。 */
  fetching: boolean;
  refetch: () => void;
}

const EMPTY_RUNS: WireRun[] = [];
const EMPTY_RECORDINGS: Recording[] = [];

// 以資料物件為單位快取紀錄列：React Query 的 structural sharing 會保留沒變的 run／recording 物件，
// 所以輪詢時只有真的變動的列會產生新物件（表格列以 memo 跳過其餘重繪）。
const runLineCache = new WeakMap<WireRun, { providers: ReadonlyMap<string, string>; lines: LogLine[] }>();
const recordingLineCache = new WeakMap<Recording, { nodeLabels: ReadonlyMap<string, string>; activeCalls: ReadonlySet<string>; activeRuns: ReadonlySet<string>; line: LogLine }>();

function cachedRunLines(runs: readonly WireRun[], providers: ReadonlyMap<string, string>): LogLine[] {
  return runs.flatMap((run) => {
    const hit = runLineCache.get(run);
    if (hit?.providers === providers) return hit.lines;
    const lines = linesFromRun(run, { providers });
    runLineCache.set(run, { providers, lines });
    return lines;
  });
}

function cachedRecordingLines(items: readonly Recording[], nodeLabels: ReadonlyMap<string, string>, activeCalls: ReadonlySet<string>, activeRuns: ReadonlySet<string>): LogLine[] {
  return items.map((item) => {
    const hit = recordingLineCache.get(item);
    if (hit?.nodeLabels === nodeLabels && hit.activeCalls === activeCalls && hit.activeRuns === activeRuns) return hit.line;
    const line = lineFromRecording(item, { nodeLabels, activeCalls, activeRuns });
    recordingLineCache.set(item, { nodeLabels, activeCalls, activeRuns, line });
    return line;
  });
}

/** 由 [key, value] 清單的 JSON 字串建立 Map：內容不變時（目錄每 3 秒輪詢）保持同一個 Map。 */
function useStableMap(entriesJson: string): ReadonlyMap<string, string> {
  return useMemo(() => new Map(JSON.parse(entriesJson) as [string, string][]), [entriesJson]);
}

export function useActivityFeed({ live, runId = null }: { live: boolean; runId?: string | null }): ActivityFeed {
  const client = useQueryClient();
  const catalog = useCatalog();
  const scoped = runId !== null;
  // 全域的 run 列表與 AppShell 共用（本來就掛著）；只看一個 run 時改用 run 明細
  const runs = useRunList(RUN_LIST_LIMIT);
  const run = useRun(runId);
  const recordings = useQuery({
    queryKey: scoped ? activityKeys.ofRun(runId) : activityKeys.recent(ACTIVITY_RECORDING_LIMIT),
    queryFn: ({ signal }) => (scoped ? fetchRunRecordings(runId, signal) : fetchRecentRecordings(ACTIVITY_RECORDING_LIMIT, signal)),
    // 只看一個已結束的 run：不再輪詢（手動重新讀取仍可用）
    refetchInterval: live && (!scoped || run.data?.state === "running") ? LIVE_POLL_MS.recentRecordings : false,
    refetchOnWindowFocus: live,
    staleTime: 2000,
    retry: retryRead,
  });

  const runItems = useMemo(
    () => (scoped ? (run.data ? [run.data] : EMPTY_RUNS) : (runs.data?.pages.flatMap((page) => page.items) ?? EMPTY_RUNS)),
    [scoped, run.data, runs.data],
  );
  const recordingItems = recordings.data?.items ?? EMPTY_RECORDINGS;

  const providersJson = useMemo(() => JSON.stringify(providerEntries(catalog.data, recordingItems)), [catalog.data, recordingItems]);
  const nodeLabelsJson = useMemo(() => JSON.stringify(nodeLabelEntries(catalog.data)), [catalog.data]);
  const providers = useStableMap(providersJson);
  const nodeLabels = useStableMap(nodeLabelsJson);
  // 進行中的呼叫：內容不變時保持同一個 Set（目錄每 3 秒輪詢），recording 列不必重算
  const activeJson = useMemo(() => JSON.stringify(activeCallIds(catalog.data, runItems)), [catalog.data, runItems]);
  const activeCalls = useMemo(() => new Set(JSON.parse(activeJson) as string[]) as ReadonlySet<string>, [activeJson]);
  // Running runs (the Controller's own recording of one has no call): the same Set while they stay the same
  const runningJson = useMemo(() => JSON.stringify(activeRunIds(runItems)), [runItems]);
  const activeRuns = useMemo(() => new Set(JSON.parse(runningJson) as string[]) as ReadonlySet<string>, [runningJson]);

  const lines = useMemo(
    () => mergeLines(cachedRunLines(runItems, providers), cachedRecordingLines(recordingItems, nodeLabels, activeCalls, activeRuns)),
    [runItems, providers, recordingItems, nodeLabels, activeCalls, activeRuns],
  );

  // 近期 recording 指到 run 列表還沒有的新 run：重新讀取一次 run 列表（新 run 出現後清單即為空，不會循環）。
  const unseenKey = useMemo(() => unseenRunIds(runItems, recordingItems).join(","), [runItems, recordingItems]);
  const runsReady = runs.status === "success";
  useEffect(() => {
    if (scoped || !live || !runsReady || unseenKey === "") return;
    void client.invalidateQueries({ queryKey: qk.runList(RUN_LIST_LIMIT) }, { cancelRefetch: false });
  }, [client, scoped, live, runsReady, unseenKey]);

  const runSource = scoped ? run : runs;
  const { refetch: refetchRuns } = runSource;
  const { refetch: refetchRecordings } = recordings;
  return {
    lines,
    status: {
      runs: sourceStatus(scoped ? t("這個 run") : t("執行紀錄"), runSource),
      recordings: sourceStatus(t("效能紀錄"), recordings),
    },
    fetching: runSource.isFetching || recordings.isFetching,
    refetch: () => {
      void refetchRuns();
      void refetchRecordings();
    },
  };
}
