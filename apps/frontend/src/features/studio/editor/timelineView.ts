// The timeline's view (zoom and horizontal scroll) as a small external store, so the compact timeline of the Shots
// workspace and the full timeline of the Edit workspace show the same span. The zoom is remembered in this browser.
import { useSyncExternalStore } from "react";
import { MAX_ZOOM, MIN_ZOOM } from "./timelineGeometry";

const ZOOM_KEY = "phasyn.panel.studio.nle.zoom";
const DEFAULT_ZOOM = 4;

export interface TimelineViewStore {
  /** Pixels per frame. */
  getZoom: () => number;
  setZoom: (zoom: number) => void;
  /** Horizontal scroll of the tracks in pixels (not reactive: each timeline applies it when it mounts). */
  getScroll: () => number;
  setScroll: (left: number) => void;
  subscribe: (listener: () => void) => () => void;
}

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

function storedZoom(): number {
  try {
    const value = Number(window.localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(value) && value > 0 ? clampZoom(value) : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function createTimelineView(): TimelineViewStore {
  let zoom = storedZoom();
  let scroll = 0;
  const listeners = new Set<() => void>();
  return {
    getZoom: () => zoom,
    setZoom(next) {
      const value = clampZoom(next);
      if (!Number.isFinite(value) || value === zoom) return;
      zoom = value;
      try {
        window.localStorage.setItem(ZOOM_KEY, String(Math.round(value * 1000) / 1000));
      } catch {
        // Only for this session
      }
      for (const listener of listeners) listener();
    },
    getScroll: () => scroll,
    setScroll(left) {
      scroll = Math.max(0, left);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useTimelineZoom(view: TimelineViewStore): number {
  return useSyncExternalStore(view.subscribe, view.getZoom);
}

/** Dispatched on window by the editor's key map (detail: "fit", "in" or "out"); the mounted timeline applies it to the view. */
export const TIMELINE_ZOOM_EVENT = "phasyn:timeline-zoom";

export function requestTimelineZoom(kind: "fit" | "in" | "out"): void {
  window.dispatchEvent(new CustomEvent(TIMELINE_ZOOM_EVENT, { detail: kind }));
}
