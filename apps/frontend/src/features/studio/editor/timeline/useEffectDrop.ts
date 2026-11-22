// Dropping an item of the Effects browser on the timeline. While it is dragged over the tracks the timeline shows what
// a release would do (the clips an effect lands on, the frames a transition or a fade covers) and the status line says
// it, or why it is refused there; a refused place takes no drop. A release writes the document once, as one step of
// the history named after the item.
import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import type { StudioTimeline } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { localId } from "../../model/ids";
import { clipAtFrame, spotAtFrame, spotKey } from "../editSpots";
import { activeEffectDrag, isEffectDrag, readEffectDrag, type EffectDrag } from "../effectDrag";
import type { Editor } from "../editorContext";
import type { AllocateId } from "../model";
import { planEffectDrop, type DropMark, type DropPoint } from "../panels/effects/applyEffect";
import { effectItem } from "../panels/effects/catalog";
import { RULER_HEIGHT } from "../timelineGeometry";

export interface EffectDropPreview {
  /** What a release here does; null when it is refused. */
  hint: string | null;
  /** Why a release here is refused; null when it lands. */
  error: string | null;
  marks: DropMark[];
}

export interface EffectDropOptions {
  /** Pixels per frame. */
  zoom: number;
  /** Width of the sticky track-header column left of the clips. */
  headerWidth: number;
}

/** Ids of objects a preview creates: never written. */
const previewId: AllocateId = (prefix) => `${prefix}-preview`;

/** What a drop at a point acts on: it changes only when the clip (an effect) or the edit spot (a transition) changes. */
function targetOf(timeline: StudioTimeline, drag: EffectDrag, point: DropPoint): string {
  const item = effectItem(drag.itemId);
  if (!item || point.trackId === null) return `${drag.itemId}|none`;
  if (item.lands === "clip") return `${drag.itemId}|${clipAtFrame(timeline, point.trackId, point.frame)?.clip_id ?? "none"}`;
  const spot = spotAtFrame(timeline, point.trackId, point.frame);
  return `${drag.itemId}|${spot ? spotKey(spot) : "none"}`;
}

export function useEffectDrop(editor: Editor, scroller: RefObject<HTMLDivElement | null>, options: EffectDropOptions) {
  const [preview, setPreview] = useState<EffectDropPreview | null>(null);
  const shownRef = useRef<{ target: string; timeline: StudioTimeline; refused: boolean } | null>(null);
  const liveRef = useRef({ editor, options });
  useLayoutEffect(() => {
    liveRef.current = { editor, options };
  });

  const clear = () => {
    shownRef.current = null;
    setPreview(null);
  };

  /** The track and the (fractional) frame under the pointer; null over the track headers or the ruler. */
  const pointOf = (event: DragEvent<HTMLElement>): DropPoint | null => {
    const node = scroller.current;
    if (!node) return null;
    const { zoom, headerWidth } = liveRef.current.options;
    const frame = node.getBoundingClientRect();
    if (event.clientX < frame.left + headerWidth || event.clientY < frame.top + RULER_HEIGHT) return null;
    let trackId: string | null = null;
    for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-track]")) {
      const rect = row.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY < rect.bottom) trackId = row.dataset["timelineTrack"] ?? null;
    }
    return { trackId, frame: Math.max(0, (event.clientX - (frame.left + headerWidth - node.scrollLeft)) / zoom) };
  };

  /** What a release at a point would do, for the preview (or, with real ids, for the drop). */
  const plan = (drag: EffectDrag, point: DropPoint, allocate: AllocateId) => {
    const { editor: current } = liveRef.current;
    const item = effectItem(drag.itemId);
    if (!item) return { ok: false as const, error: t("效果面板裡已經沒有這個項目"), marks: [] };
    if (current.problem != null && current.problem !== "") return { ok: false as const, error: current.problem, marks: [] };
    return planEffectDrop(current.timeline, item, point, { selected: current.selected, linked: current.linked }, allocate);
  };

  const over = (event: DragEvent<HTMLElement>) => {
    if (!isEffectDrag(event.dataTransfer)) return;
    event.preventDefault();
    const node = scroller.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      if (event.clientX > rect.right - 24) node.scrollBy({ left: 18 });
      else if (event.clientX < rect.left + liveRef.current.options.headerWidth + 24) node.scrollBy({ left: -18 });
    }
    const point = pointOf(event);
    const drag = activeEffectDrag();
    if (!point) {
      event.dataTransfer.dropEffect = "none";
      clear();
      return;
    }
    // A drag from another window carries no readable payload until it is dropped: nothing to preview
    if (!drag) {
      event.dataTransfer.dropEffect = "copy";
      return;
    }
    const { timeline } = liveRef.current.editor;
    const target = targetOf(timeline, drag, point);
    if (shownRef.current?.target !== target || shownRef.current.timeline !== timeline) {
      const next = plan(drag, point, previewId);
      shownRef.current = { target, timeline, refused: !next.ok };
      setPreview(next.ok ? { hint: next.hint, error: null, marks: next.marks } : { hint: null, error: next.error, marks: next.marks });
    }
    event.dataTransfer.dropEffect = shownRef.current.refused ? "none" : "copy";
  };

  const leave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    clear();
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    if (!isEffectDrag(event.dataTransfer)) return;
    event.preventDefault();
    const drag = readEffectDrag(event.dataTransfer);
    const point = pointOf(event);
    clear();
    if (!drag || !point) return;
    const { editor: current } = liveRef.current;
    const result = plan(drag, point, localId);
    if (!result.ok) {
      current.warn(result.error);
      return;
    }
    current.playhead.setPlaying(false);
    if (current.commit(result.timeline, result.label)) current.focus.setPanel("timeline");
  };

  return { preview, handlers: { onDragEnter: over, onDragOver: over, onDragLeave: leave, onDrop: drop } };
}
