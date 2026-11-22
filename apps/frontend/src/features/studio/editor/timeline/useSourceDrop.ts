// Dropping a source on the timeline, from the Project panel or the Source monitor. Over the tracks the drop is
// previewed where it would land (the track under the pointer and its pair of the other kind, snapped like a moved
// clip); a release overwrites, and with Ctrl (⌘ on a Mac) held it inserts and everything after it moves right. The
// document is written once, on the drop.
import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { detectApplePlatform } from "@/lib/keyboard";
import { executeEdit } from "../commands";
import { activeSourceDrag, isSourceDrag, readSourceDrag, type SourceDrag } from "../dragSource";
import type { Editor } from "../editorContext";
import type { PlaceMode } from "../sourceDrop";
import { RULER_HEIGHT, snappedStart } from "../timelineGeometry";

export interface SourceDropPreview {
  mode: PlaceMode;
  /** Name of the dragged source. */
  name: string;
  trackIds: string[];
  start: number;
  length: number;
  /** Frame of the snap guide. */
  guide: number | null;
  /** Why a release here would be refused; null when it would land. */
  error: string | null;
}

export interface SourceDropOptions {
  /** Pixels per frame. */
  zoom: number;
  /** Width of the sticky track-header column left of the clips. */
  headerWidth: number;
}

interface Spot {
  trackId: string | null;
  frame: number;
  mode: PlaceMode;
  snap: boolean;
}

const sameSpot = (a: Spot | null, b: Spot) => a !== null && a.trackId === b.trackId && a.frame === b.frame && a.mode === b.mode && a.snap === b.snap;

export function useSourceDrop(editor: Editor, scroller: RefObject<HTMLDivElement | null>, options: SourceDropOptions) {
  const [preview, setPreview] = useState<SourceDropPreview | null>(null);
  const shownRef = useRef<Spot | null>(null);
  const liveRef = useRef({ editor, options });
  useLayoutEffect(() => {
    liveRef.current = { editor, options };
  });

  const clear = () => {
    shownRef.current = null;
    setPreview(null);
  };

  /** Where the pointer is on the tracks; null over the track headers or the ruler (rows scrolled under them are not hit). */
  const spotOf = (event: DragEvent<HTMLElement>): Spot | null => {
    const node = scroller.current;
    if (!node) return null;
    const { zoom, headerWidth } = liveRef.current.options;
    const frame = node.getBoundingClientRect();
    if (event.clientX < frame.left + headerWidth || event.clientY < frame.top + RULER_HEIGHT) return null;
    const left = frame.left + headerWidth - node.scrollLeft;
    let trackId: string | null = null;
    for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-track]")) {
      const rect = row.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY < rect.bottom) trackId = row.dataset["timelineTrack"] ?? null;
    }
    const insert = detectApplePlatform() ? event.metaKey : event.ctrlKey;
    return { trackId, frame: Math.max(0, Math.round((event.clientX - left) / zoom)), mode: insert ? "insert" : "overwrite", snap: liveRef.current.editor.snapping && !event.altKey };
  };

  /** Where the drag would land from a spot: the snapped start and whether the edit would be accepted. */
  const landing = (drag: SourceDrag, spot: Spot): SourceDropPreview => {
    const { editor: current, options: view } = liveRef.current;
    const rough = current.planDrop(drag, spot.trackId, spot.frame, spot.mode);
    if (!rough.ok) return { mode: spot.mode, name: "", trackIds: [], start: spot.frame, length: 0, guide: null, error: rough.error };
    const snapped = spot.snap ? snappedStart(current.timeline, spot.frame, rough.value.length, current.playhead.getFrame(), view.zoom) : { start: spot.frame, guide: null };
    const plan = snapped.start === spot.frame ? rough : current.planDrop(drag, spot.trackId, snapped.start, spot.mode);
    const base = { mode: spot.mode, name: rough.value.source.name, trackIds: rough.value.trackIds, start: snapped.start, length: rough.value.length, guide: snapped.guide };
    if (!plan.ok) return { ...base, error: plan.error };
    const result = executeEdit(plan.value.timeline, plan.value.command);
    return { ...base, error: result.ok ? null : result.error };
  };

  const over = (event: DragEvent<HTMLElement>) => {
    if (!isSourceDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const node = scroller.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      if (event.clientX > rect.right - 24) node.scrollBy({ left: 18 });
      else if (event.clientX < rect.left + liveRef.current.options.headerWidth + 24) node.scrollBy({ left: -18 });
    }
    const drag = activeSourceDrag();
    const spot = spotOf(event);
    if (!spot) {
      event.dataTransfer.dropEffect = "none";
      clear();
      return;
    }
    // A drag from another window carries no readable payload until it is dropped: nothing to preview
    if (!drag || sameSpot(shownRef.current, spot)) return;
    shownRef.current = spot;
    setPreview(landing(drag, spot));
  };

  const leave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    clear();
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    if (!isSourceDrag(event.dataTransfer)) return;
    event.preventDefault();
    const drag = readSourceDrag(event.dataTransfer);
    const spot = spotOf(event);
    clear();
    if (!drag || !spot) return;
    const { editor: current } = liveRef.current;
    const target = landing(drag, spot);
    current.playhead.setPlaying(false);
    if (current.dropSource(drag, spot.trackId, target.start, spot.mode)) current.focus.setPanel("timeline");
  };

  return { preview, handlers: { onDragEnter: over, onDragOver: over, onDragLeave: leave, onDrop: drop } };
}
