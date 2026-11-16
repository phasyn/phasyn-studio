// Raw event list of one stream: page stitching, gap markers (a seq jump or a server-reported gap), copy lines and text
// search (one-line summaries come from @/lib/recordingEvents). Each stream numbers its events from 1 and streams have no
// total order, so gaps are only detected within one stream.
import type { EventPage, RecordingEvent } from "@/api/generated/contracts";
import { eventSummary } from "@/lib/recordingEvents";

export type EventListItem =
  | { type: "event"; key: string; event: RecordingEvent }
  | { type: "gap"; key: string; fromSeq: number; toSeq: number }
  | { type: "page-gap"; key: string; afterSeq: number };

/** 依頁序拼接；seq 跳號插入「缺段」，伺服器標 gap 但頁內看不出跳號時在頁首插入標記。 */
export function eventListWithGaps(pages: readonly EventPage[], firstAfterSeq = 0): EventListItem[] {
  const items: EventListItem[] = [];
  let lastSeq = firstAfterSeq;
  const seen = new Set<number>();
  for (const page of pages) {
    const pageStart = lastSeq;
    let foundJump = false;
    const pageItems: EventListItem[] = [];
    for (const event of page.events) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      if (event.seq > lastSeq + 1) {
        foundJump = true;
        pageItems.push({ type: "gap", key: `gap-${lastSeq + 1}-${event.seq - 1}`, fromSeq: lastSeq + 1, toSeq: event.seq - 1 });
      }
      pageItems.push({ type: "event", key: `${event.stream_id}:${event.seq}`, event });
      lastSeq = Math.max(lastSeq, event.seq);
    }
    if (page.gap && !foundJump) items.push({ type: "page-gap", key: `page-gap-${pageStart}`, afterSeq: pageStart });
    items.push(...pageItems);
  }
  return items;
}

export function flattenPages(pages: readonly EventPage[]): RecordingEvent[] {
  const seen = new Set<number>();
  const events: RecordingEvent[] = [];
  for (const page of pages) {
    for (const event of page.events) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      events.push(event);
    }
  }
  return events;
}

/** 單列文字（複製用）：UTC 時間、level、stream#seq、kind、摘要。 */
export function eventLine(event: RecordingEvent): string {
  return `${event.occurred_at}\t${event.level}\t${event.stream_id}#${event.seq}\t${event.kind}\t${eventSummary(event)}`;
}

const searchCache = new WeakMap<RecordingEvent, string>();

function searchText(event: RecordingEvent): string {
  let text = searchCache.get(event);
  if (text === undefined) {
    text = `${event.seq} ${event.level} ${event.kind} ${eventSummary(event)} ${JSON.stringify(event.data)}`.toLowerCase();
    searchCache.set(event, text);
  }
  return text;
}

export type LevelFilter = "all" | "warning+" | RecordingEvent["level"];

export interface EventFilter {
  query: string;
  level: LevelFilter;
  kind: "all" | RecordingEvent["kind"];
}

export const DEFAULT_EVENT_FILTER: EventFilter = { query: "", level: "all", kind: "all" };

function levelMatches(level: RecordingEvent["level"], filter: LevelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "warning+") return level === "warning" || level === "error";
  return level === filter;
}

export function eventMatches(event: RecordingEvent, filter: EventFilter): boolean {
  if (!levelMatches(event.level, filter.level)) return false;
  if (filter.kind !== "all" && event.kind !== filter.kind) return false;
  const query = filter.query.trim().toLowerCase();
  return query === "" || searchText(event).includes(query);
}

/** 篩選後仍保留缺段標記（缺段是事實，不因搜尋消失）。 */
export function filterEventList(items: readonly EventListItem[], filter: EventFilter): EventListItem[] {
  const active = filter.query.trim() !== "" || filter.level !== "all" || filter.kind !== "all";
  if (!active) return [...items];
  return items.filter((item) => item.type !== "event" || eventMatches(item.event, filter));
}

export function lastSeqOf(pages: readonly EventPage[]): number | null {
  let last: number | null = null;
  for (const page of pages) for (const event of page.events) last = last === null ? event.seq : Math.max(last, event.seq);
  return last;
}
