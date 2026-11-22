// Recording event "tails": only the newest `cap` events of each stream, for the live component-event table in the dock.
// Streams come from the Controller's recording response (last_seq / event_count); later reads fetch only events after
// the last one seen. When it falls more than a page behind it rereads the newest `cap` events instead (the unloaded
// middle is shown honestly as a seq range: nothing is filled in or guessed).
import type { EventPage, RecordingEvent } from "@/api/generated/contracts";

export interface DiscoveredStream {
  stream_id: string;
  /** null＝這次沒有重新探索（沿用上一份快照），從已讀到的位置往後讀。 */
  last_seq: number | null;
  event_count: number | null;
}

export interface StreamTail {
  streamId: string;
  /** 依 seq 由小到大，最多 cap 筆。 */
  events: RecordingEvent[];
  /** 已讀到的最大 seq（下一次從這裡之後讀）。 */
  lastSeq: number;
  /** 伺服器回報的事件總數；未知時為 null。 */
  total: number | null;
  /** 最後一頁之後還有事件未讀（has_more）。 */
  hasMoreAfter: boolean;
  /** 伺服器標示此 stream 有缺段。 */
  gap: boolean;
}

export interface TailSnapshot {
  recordingId: string;
  streams: StreamTail[];
  /** 最近一次探索 stream 的時間（Date.now()）。 */
  discoveredAt: number;
}

export type FetchEventPage = (streamId: string, afterSeq: number, limit: number) => Promise<EventPage>;

/** 新尾端的起點（after_seq）：已知 last_seq 時取最後 cap 筆，否則從頭。 */
export function tailStart(stream: DiscoveredStream, cap: number): number {
  return stream.last_seq === null ? 0 : Math.max(0, stream.last_seq - cap);
}

export function emptyTail(streamId: string, lastSeq = 0, total: number | null = null): StreamTail {
  return { streamId, events: [], lastSeq, total, hasMoreAfter: false, gap: false };
}

/** 接上一頁新事件：依 seq 去重排序，只留最新 cap 筆。 */
export function appendToTail(prev: StreamTail, page: EventPage, cap: number, total: number | null): StreamTail {
  const bySeq = new Map<number, RecordingEvent>();
  for (const event of prev.events) bySeq.set(event.seq, event);
  for (const event of page.events) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
  const maxSeq = merged.at(-1)?.seq ?? 0;
  return {
    streamId: prev.streamId,
    events: kept,
    lastSeq: Math.max(prev.lastSeq, maxSeq),
    total,
    hasMoreAfter: page.has_more,
    gap: prev.gap || page.gap,
  };
}

async function freshTail(stream: DiscoveredStream, fetchPage: FetchEventPage, cap: number): Promise<StreamTail> {
  const after = tailStart(stream, cap);
  const page = await fetchPage(stream.stream_id, after, cap);
  return appendToTail(emptyTail(stream.stream_id, after, stream.event_count), page, cap, stream.event_count);
}

/**
 * 讀一個 stream 的尾端。有上一份尾端時只讀之後的新事件；伺服器的 last_seq 沒有前進時不發請求。
 * 新事件多於一頁（has_more）且已知 last_seq 時，直接改讀最新 cap 筆。
 */
export async function loadStreamTail(
  stream: DiscoveredStream,
  prev: StreamTail | undefined,
  fetchPage: FetchEventPage,
  cap: number,
): Promise<StreamTail> {
  if (stream.last_seq === 0) return emptyTail(stream.stream_id, 0, stream.event_count ?? 0);
  if (!prev || prev.lastSeq === 0) return freshTail(stream, fetchPage, cap);
  if (stream.last_seq !== null && stream.last_seq <= prev.lastSeq) return { ...prev, total: stream.event_count ?? prev.total };
  const page = await fetchPage(stream.stream_id, prev.lastSeq, cap);
  if (page.has_more && stream.last_seq !== null) return freshTail(stream, fetchPage, cap);
  return appendToTail(prev, page, cap, stream.event_count ?? prev.total);
}

/** 所有 stream 的尾端（上一份快照屬於同一 recording 時才沿用）。 */
export async function loadTails(
  recordingId: string,
  streams: readonly DiscoveredStream[],
  prev: TailSnapshot | undefined,
  fetchPage: FetchEventPage,
  cap: number,
  discoveredAt: number,
): Promise<TailSnapshot> {
  const previous = prev?.recordingId === recordingId ? prev : undefined;
  const tails = await Promise.all(
    streams.map((stream) =>
      loadStreamTail(
        stream,
        previous?.streams.find((tail) => tail.streamId === stream.stream_id),
        fetchPage,
        cap,
      ),
    ),
  );
  return { recordingId, streams: tails, discoveredAt };
}

/**
 * 是否需要重新探索 stream：第一次、換 recording、還沒有任何 stream，或距上次探索超過 maxAgeMs
 * （即時輪詢時不每次都多讀一次 recording）。
 */
export function needsDiscovery(prev: TailSnapshot | undefined, recordingId: string, now: number, maxAgeMs: number): boolean {
  return prev?.recordingId !== recordingId || prev.streams.length === 0 || now - prev.discoveredAt >= maxAgeMs;
}

/** 不重新探索時沿用上一份快照的 stream（last_seq 未知：直接從已讀到的位置往後讀）。 */
export function knownStreams(prev: TailSnapshot): DiscoveredStream[] {
  return prev.streams.map((tail) => ({ stream_id: tail.streamId, last_seq: null, event_count: tail.total }));
}

/** 顯示用摘要：每個 stream 顯示的 seq 範圍與總數。 */
export interface StreamCoverage {
  streamId: string;
  shown: number;
  firstSeq: number | null;
  lastSeq: number | null;
  total: number | null;
  /** 有更早或更新的事件沒有載入。 */
  partial: boolean;
  gap: boolean;
}

export function streamCoverage(snapshot: TailSnapshot | undefined): StreamCoverage[] {
  return (snapshot?.streams ?? []).map((tail) => {
    const firstSeq = tail.events[0]?.seq ?? null;
    const lastSeq = tail.events.at(-1)?.seq ?? null;
    // seq 從 1 開始：第一筆不是 1 代表較早的事件沒有載入。
    const partial = tail.hasMoreAfter || (firstSeq !== null && firstSeq > 1) || (tail.total !== null && tail.total > tail.events.length);
    return { streamId: tail.streamId, shown: tail.events.length, firstSeq, lastSeq, total: tail.total, partial, gap: tail.gap };
  });
}
