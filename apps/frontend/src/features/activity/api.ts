// Reads of the activity dock (GET only): recent recordings (all, one run, one component) and recording event tails.
// Keys live under qk.recordings(), so the recordings page's invalidation and fetch-history refresh them too; event tails
// extend qk.recordingEvents(id). They are kept out of the recordings list keys, which hold InfiniteData pages.
import type { Recording, RecordingPage } from "@/api/generated/contracts";
import { qk } from "@/api/keys";
import { fetchRecording, fetchRecordingEvents, fetchRecordingPage, recordingStreams } from "@/api/recordings";
import { knownStreams, loadTails, needsDiscovery, type DiscoveredStream, type TailSnapshot } from "./tail";

/** 活動表讀取的近期 recording 筆數。 */
export const ACTIVITY_RECORDING_LIMIT = 40;
/** 每個 stream 最多載入的最新事件數（單次請求 limit 也不超過此值）。 */
export const EVENT_TAIL_LIMIT = 500;

/** 「即時」開啟時的輪詢間隔（毫秒）。 */
export const LIVE_POLL_MS = {
  recentRecordings: 10_000,
  componentRecording: 4000,
  eventTail: 2500,
} as const;

/** 單一 run 的活動最多讀取的 recording 筆數（一個 run 通常不到 20 筆：每步一筆＋主控一筆）。 */
export const RUN_RECORDING_LIMIT = 200;

export const activityKeys = {
  recent: (limit: number) => [...qk.recordings(), "activity", "recent", limit] as const,
  /** 某個 run 的 recording（run 明細的「活動」預設只看這個 run）。 */
  ofRun: (runId: string) => [...qk.recordings(), "activity", "run", runId] as const,
  latestOf: (nodeId: string, componentId: string) => [...qk.recordings(), "activity", "latest", nodeId, componentId] as const,
  /** 尾端快照依 recording 狀態分 key：狀態改變（例如執行中→成功）時重新讀一次完整尾端。 */
  tail: (recordingId: string, state: string) => [...qk.recordingEvents(recordingId), "activity-tail", state] as const,
};

export function fetchRecentRecordings(limit: number, signal?: AbortSignal): Promise<RecordingPage> {
  return fetchRecordingPage({ limit }, signal);
}

/** 某個 run 的 recording（伺服器依 run_id 篩選）。 */
export function fetchRunRecordings(runId: string, signal?: AbortSignal): Promise<RecordingPage> {
  return fetchRecordingPage({ run_id: runId, limit: RUN_RECORDING_LIMIT }, signal);
}

/** 某個元件 instance 最新的一筆 recording（任何 operation）；沒有時回傳 null。 */
export async function fetchLatestRecording(nodeId: string, componentId: string, signal?: AbortSignal): Promise<Recording | null> {
  const page = await fetchRecordingPage({ node_id: nodeId, component_id: componentId, limit: 1 }, signal);
  return page.items[0] ?? null;
}

/** 探索 stream：主控的 GET /api/recordings/{id} 附上 streams（含 last_seq、event_count）。 */
export async function discoverStreams(recordingId: string, signal?: AbortSignal): Promise<DiscoveredStream[]> {
  return recordingStreams(await fetchRecording(recordingId, signal));
}

/** 即時輪詢時重新探索 stream 的最短間隔（其餘輪詢只從已知 stream 的位置往後讀）。 */
export const DISCOVERY_MAX_AGE_MS = 10_000;

/** 讀取（或延續）一筆 recording 所有 stream 的事件尾端。 */
export async function fetchEventTails(recordingId: string, prev: TailSnapshot | undefined, signal?: AbortSignal): Promise<TailSnapshot> {
  const previous = prev?.recordingId === recordingId ? prev : undefined;
  const now = Date.now();
  let streams: DiscoveredStream[];
  let discoveredAt: number;
  if (previous && !needsDiscovery(previous, recordingId, now, DISCOVERY_MAX_AGE_MS)) {
    streams = knownStreams(previous);
    discoveredAt = previous.discoveredAt;
  } else {
    streams = await discoverStreams(recordingId, signal);
    discoveredAt = now;
  }
  return loadTails(
    recordingId,
    streams,
    previous,
    (streamId, afterSeq, limit) =>
      fetchRecordingEvents(recordingId, { stream_id: streamId, after_seq: afterSeq, limit }, signal),
    EVENT_TAIL_LIMIT,
    discoveredAt,
  );
}
