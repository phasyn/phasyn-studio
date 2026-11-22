// The Project panel's view of the project's media: every source that is not a text or an adjustment layer, with what the panel shows
// about it (kind, length, how often the timeline uses it, a shot that waits for its render, a shorter take that waits
// to be applied, the state of its playback proxy), and the search, kind filter and sort of the list. Pure.
import type { StudioTimeline, TimelineSource } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import { formatTimecode } from "../../../model/frames";
import { KIND_LABEL } from "../../../references/materials";
import type { ShorterTake } from "../../sources";

export type MediaKind = "video" | "audio" | "image";

export type KindFilter = "all" | MediaKind;
export const KIND_FILTERS: readonly KindFilter[] = ["all", "video", "audio", "image"];
export const KIND_FILTER_LABELS: Record<KindFilter, string> = { all: t("全部"), ...KIND_LABEL };

export type SortKey = "name" | "duration" | "kind" | "uses";
export const SORT_KEYS: readonly SortKey[] = ["name", "duration", "kind", "uses"];
export const SORT_LABELS: Record<SortKey, string> = { name: t("名稱"), duration: t("長度"), kind: t("類型"), uses: t("時間軸使用次數") };

export type SortDirection = "ascending" | "descending";
export const SORT_DIRECTIONS: readonly SortDirection[] = ["ascending", "descending"];
export const DIRECTION_LABELS: Record<SortDirection, string> = { ascending: t("遞增排列"), descending: t("遞減排列") };

export type MediaView = "list" | "grid";
export const MEDIA_VIEWS: readonly MediaView[] = ["list", "grid"];

/** none = no proxy was asked for; building = its run has not answered yet. */
export type ProxyState = "none" | "building" | "ready" | "failed";

export interface MediaItem {
  /** The source's id. */
  id: string;
  source: TimelineSource;
  kind: MediaKind;
  name: string;
  /** Length in frames at the timeline's rate; null for a still image. */
  duration: number | null;
  /** How often the timeline uses it: the linked picture and sound of one placement count once. */
  uses: number;
  /** A shot whose take is not rendered yet. */
  pending: boolean;
  /** The shot's active take that waits because it is shorter than a clip uses. */
  shorter: ShorterTake | null;
  proxy: ProxyState;
}

export function proxyState(source: TimelineSource): ProxyState {
  if (source.proxy) return "ready";
  if (source.proxy_error != null && source.proxy_error !== "") return "failed";
  return (source.proxy_run_id != null && source.proxy_run_id !== "") ? "building" : "none";
}

function placements(timeline: StudioTimeline): Map<string, number> {
  const placed = new Map<string, Set<string>>();
  for (const clip of timeline.clips) {
    const groups = placed.get(clip.source_id) ?? new Set<string>();
    groups.add(clip.linked_id ?? clip.clip_id);
    placed.set(clip.source_id, groups);
  }
  return new Map([...placed].map(([sourceId, groups]) => [sourceId, groups.size]));
}

/** The project's media in the project's own order (shots first, then what was uploaded). */
export function mediaItems(sources: readonly TimelineSource[], timeline: StudioTimeline, shorterTakes: readonly ShorterTake[]): MediaItem[] {
  const uses = placements(timeline);
  return sources.flatMap((source): MediaItem[] => {
    // Text and adjustment layers are made on the timeline: they have no media to list
    if (source.kind === "text" || source.kind === "adjustment") return [];
    return [
      {
        id: source.source_id,
        source,
        kind: source.kind,
        name: source.name || t("未命名素材"),
        duration: source.kind === "image" ? null : source.duration_frames,
        uses: uses.get(source.source_id) ?? 0,
        pending: source.file === null,
        shorter: shorterTakes.find((take) => take.sourceId === source.source_id) ?? null,
        proxy: proxyState(source),
      },
    ];
  });
}

const KIND_ORDER: Record<MediaKind, number> = { video: 0, audio: 1, image: 2 };

function sortValue(item: MediaItem, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return item.name;
    case "duration":
      return item.duration;
    case "kind":
      return KIND_ORDER[item.kind];
    case "uses":
      return item.uses;
  }
}

/**
 * The items the panel lists: those of the chosen kind whose name contains the query, sorted. An item without a value
 * (a still has no length) comes last in either direction; equal items keep the project's order.
 */
export function visibleMedia(items: readonly MediaItem[], query: string, kind: KindFilter, key: SortKey, direction: SortDirection): MediaItem[] {
  const wanted = query.trim().toLocaleLowerCase();
  const sign = direction === "descending" ? -1 : 1;
  return items
    .filter((item) => (kind === "all" || item.kind === kind) && (wanted === "" || item.name.toLocaleLowerCase().includes(wanted)))
    .sort((a, b) => {
      const left = sortValue(a, key);
      const right = sortValue(b, key);
      if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
      return order * sign;
    });
}

/** An item's tooltip: its whole name and what is known about it. */
export function mediaTitle(item: MediaItem, fps: number): string {
  const { source } = item;
  return joinInline([
    item.name,
    KIND_LABEL[item.kind],
    ...(source.width > 0 && source.height > 0 ? [`${String(source.width)}×${String(source.height)}`] : []),
    ...(item.duration === null ? [] : [formatTimecode(item.duration, fps)]),
    ...(item.pending ? [t("尚未渲染")] : []),
    t("時間軸使用 {count} 次", { count: item.uses }),
  ]);
}
