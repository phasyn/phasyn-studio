// Which tab the shot inspector shows, as one small store: the inspector reads it, and other parts of the Studio (the
// toolbar's action next to a blocked 渲染鏡頭) bring a tab forward and ask the generate workspace to open its inspector.
// Kept in this browser under the key the inspector used before (a per-viewer convenience: without storage it starts
// on the Prompt tab).
import { useSyncExternalStore } from "react";

export const INSPECTOR_TABS = ["prompt", "references", "plugins", "notes"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

const STORAGE_KEY = "phasyn.choice.studio.inspector.tab";
const listeners = new Set<() => void>();

export function isInspectorTab(value: unknown): value is InspectorTab {
  return typeof value === "string" && (INSPECTOR_TABS as readonly string[]).includes(value);
}

function stored(): InspectorTab {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isInspectorTab(raw) ? raw : "prompt";
  } catch {
    return "prompt";
  }
}

let state = { tab: stored(), reveal: 0 };

function publish(next: typeof state): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows a tab (the inspector's own tab buttons). */
export function setInspectorTab(tab: InspectorTab): void {
  if (tab === state.tab) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // this session only
  }
  publish({ ...state, tab });
}

/** Shows a tab and asks the generate workspace to open its inspector if it is collapsed. */
export function revealInspectorTab(tab: InspectorTab): void {
  setInspectorTab(tab);
  publish({ ...state, reveal: state.reveal + 1 });
}

export function useInspectorTab(): InspectorTab {
  return useSyncExternalStore(subscribe, () => state.tab);
}

/** Changes each time something asks to see the inspector (0 until then). */
export function useInspectorReveal(): number {
  return useSyncExternalStore(subscribe, () => state.reveal);
}
