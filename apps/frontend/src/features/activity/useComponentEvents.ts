import { isRecord } from "@/lib/json";
// 選取元件的事件：該 instance 最新一筆 recording（任何 operation），讀取所有 stream 的事件尾端（每個 stream ≤ 500 筆）。
// 「即時」開啟時：每 4 秒確認是否有新的 recording；recording 執行中時每 2.5 秒只抓新增的事件。
// recording 狀態改變（例如執行中→成功）時重新讀一次完整尾端，拿到最後的事件。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { nodeLabel, useCatalog } from "@/api/catalog";
import type { RecorderConfig, RecordingContext, RecordingEvent, RecordingSummary } from "@/api/generated/contracts";
import { retryRead } from "@/api/recordings";
import { activityKeys, fetchEventTails, fetchLatestRecording, LIVE_POLL_MS } from "./api";
import { callInProgress, lineFromEvent, sortLines, type LogLine } from "./model";
import { sourceStatus, type SourceStatus } from "./status";
import { streamCoverage, type StreamCoverage, type TailSnapshot } from "./tail";
import { t } from "@/i18n";

export interface ShownRecording {
  recordingId: string;
  operation: RecordingContext["operation"];
  createdAt: string;
  state: RecordingSummary["state"];
  providerId: string;
  runId: string | null;
  /** 錄製模式（off＝只有結果與摘要，沒有事件）。 */
  recorderMode: RecorderConfig["mode"] | null;
  synthetic: boolean;
}

export interface ComponentEvents {
  /** 目前顯示的 recording；元件沒有任何 recording 時為 null。 */
  recording: ShownRecording | null;
  /** 由舊到新。 */
  lines: LogLine[];
  /** 每個 stream 實際載入的 seq 範圍與總數。 */
  coverage: StreamCoverage[];
  status: { recording: SourceStatus; events: SourceStatus };
  fetching: boolean;
  refetch: () => void;
}

const eventLineCache = new WeakMap<RecordingEvent, { key: string; line: LogLine }>();

function eventLines(snapshot: TailSnapshot | undefined, providerId: string, nodeId: string, nodeName: string): LogLine[] {
  if (!snapshot) return [];
  const key = `${providerId}\u0000${nodeId}\u0000${nodeName}`;
  const nodeLabels = new Map([[nodeId, nodeName]]);
  const lines = snapshot.streams.flatMap((stream) =>
    stream.events.map((event) => {
      const hit = eventLineCache.get(event);
      if (hit?.key === key) return hit.line;
      const line = lineFromEvent(event, { providerId, nodeLabels });
      eventLineCache.set(event, { key, line });
      return line;
    }),
  );
  return sortLines(lines);
}

export function useComponentEvents(nodeId: string, componentId: string, { live }: { live: boolean }): ComponentEvents {
  const client = useQueryClient();
  const catalog = useCatalog();
  const latest = useQuery({
    queryKey: activityKeys.latestOf(nodeId, componentId),
    queryFn: ({ signal }) => fetchLatestRecording(nodeId, componentId, signal),
    enabled: nodeId !== "" && componentId !== "",
    refetchInterval: live ? LIVE_POLL_MS.componentRecording : false,
    refetchOnWindowFocus: live,
    staleTime: 2000,
    retry: retryRead,
  });

  const record = latest.data ?? null;
  const recordingId = record?.context.recording_id ?? "";
  // summary 尚未收到（unknown）但元件回報這個 call 仍在進行：當成執行中（顯示「執行中」並即時追事件）
  const activeCall = catalog.data?.nodes.find((node) => node.node_id === nodeId)?.components.find((item) => item.component_id === componentId)?.active_call_id ?? null;
  const inProgress = record !== null && callInProgress(record, new Set((activeCall != null && activeCall !== "") ? [activeCall] : []));
  const state: RecordingSummary["state"] = inProgress ? "running" : (record?.summary.state ?? "unknown");
  const running = state === "running";

  const tail = useQuery({
    queryKey: activityKeys.tail(recordingId, state),
    // 同一個 key 的上一份快照：只抓之後的新事件（增量）；換 recording 時沒有快照，讀完整尾端。
    queryFn: ({ signal, queryKey }) => fetchEventTails(recordingId, client.getQueryData<TailSnapshot>(queryKey), signal),
    enabled: recordingId !== "",
    refetchInterval: live && running ? LIVE_POLL_MS.eventTail : false,
    refetchOnWindowFocus: live && running,
    staleTime: running ? 0 : 60_000,
    // 同一筆 recording 換狀態時先沿用舊快照，避免畫面閃成「讀取中」；換成別筆 recording 則不沿用。
    placeholderData: (previous) => (previous?.recordingId === recordingId ? previous : undefined),
    retry: retryRead,
  });

  const recording = useMemo<ShownRecording | null>(() => {
    if (!record) return null;
    const { context } = record;
    return {
      recordingId: context.recording_id,
      operation: context.operation,
      createdAt: context.created_at,
      state,
      providerId: context.provider_id,
      runId: context.run_id,
      recorderMode: isRecord(context.recording) ? context.recording.mode : null,
      synthetic: context.synthetic,
    };
  }, [record, state]);

  const providerId = record?.context.provider_id ?? "";
  const nodeName = useMemo(() => nodeLabel(catalog.data, nodeId), [catalog.data, nodeId]);
  const lines = useMemo(() => eventLines(tail.data, providerId, nodeId, nodeName), [tail.data, providerId, nodeId, nodeName]);
  const coverage = useMemo(() => streamCoverage(tail.data), [tail.data]);

  const { refetch: refetchLatest } = latest;
  const { refetch: refetchTail } = tail;
  return {
    recording,
    lines,
    coverage,
    status: {
      recording: sourceStatus(t("最新 recording"), latest),
      events: sourceStatus(t("recording 事件"), tail),
    },
    fetching: latest.isFetching || tail.isFetching,
    refetch: () => {
      void refetchLatest();
      if (recordingId) void refetchTail();
    },
  };
}
