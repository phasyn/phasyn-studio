// What the engine sheet shows when a panel opens it on purpose: the generation row's 方式 opens 元件 on the route a
// 方式 needs, its route line opens 路線, and the 路線 tab opens 元件 on a route other than the shot's own. The request
// lasts until the sheet closes or the person picks a tab, so opening the sheet from the toolbar shows the tab chosen
// last (kept in this browser by the sheet).
import { useSyncExternalStore } from "react";

export const ENGINE_TABS = ["routes", "quality", "components"] as const;
export type EngineTab = (typeof ENGINE_TABS)[number];

export interface EngineView {
  tab: EngineTab;
  /** On 元件: the route whose components are shown; null = the selected shot's route. */
  routeId: string | null;
}

let current: EngineView | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Shows `view` in the sheet (already open or not). */
export function setEngineView(view: EngineView): void {
  current = view;
  emit();
}

/** Opens the sheet on `view`. */
export function showEngine(view: EngineView, setEngineOpen: (open: boolean) => void): void {
  setEngineView(view);
  setEngineOpen(true);
}

export function clearEngineView(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** The requested view; null when the sheet shows the tab chosen last. */
export function useEngineView(): EngineView | null {
  return useSyncExternalStore(subscribe, () => current);
}
