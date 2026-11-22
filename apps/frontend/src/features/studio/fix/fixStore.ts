// Page-wide state of the 修正 menu that has no React owner of its own:
// - the open request from a timeline clip's context menu (the clip's host renders the menu next to the clip),
// - which fix runs were already brought back (kept in this browser so a take deleted later is not added again),
// - the last error of bringing a run back (shown on its card in the take strip, with a retry),
// - which mounted watcher brings finished runs back (one per page, see FixRunWatcher),
// - the tool picked in a library item's 修正 menu (LibraryFixHost opens it once the asset library has closed).
import { useSyncExternalStore } from "react";

type Listener = () => void;

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** A 修正 menu asked for from a timeline clip. */
export interface ClipFixRequest {
  clipId: string;
  /** Changes on every request, so asking again reopens the menu. */
  token: number;
}

const clipRequest = createStore<ClipFixRequest | null>(null);
let tokens = 0;

export function requestClipFix(clipId: string): void {
  tokens += 1;
  clipRequest.set({ clipId, token: tokens });
}

/** Closes the menu of this clip (a request for another clip stays). */
export function clearClipFix(clipId: string): void {
  if (clipRequest.get()?.clipId === clipId) clipRequest.set(null);
}

export function useClipFixRequest(clipId: string): ClipFixRequest | null {
  const request = useSyncExternalStore(clipRequest.subscribe, clipRequest.get);
  return request?.clipId === clipId ? request : null;
}

// Runs already brought back, or dismissed by the owner (local to this browser; the Controller keeps the runs)
const DONE_KEY = "phasyn.studio.fix.done";
const DONE_LIMIT = 200;

function readDone(): string[] {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    const parsed: unknown = raw !== null && raw !== "" ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const done = createStore<readonly string[]>(readDone());

export function markFixDone(runId: string): void {
  const list = done.get();
  if (list.includes(runId)) return;
  const next = [...list, runId].slice(-DONE_LIMIT);
  done.set(next);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the run is still remembered for this page
  }
}

export function useFixDone(): readonly string[] {
  return useSyncExternalStore(done.subscribe, done.get);
}

// Errors of bringing a run back, by run id
const errors = createStore<Readonly<Record<string, string>>>({});

export function setFixError(runId: string, message: string | null): void {
  const current = errors.get();
  if (message === null) {
    if (!(runId in current)) return;
    const { [runId]: _removed, ...rest } = current;
    errors.set(rest);
    return;
  }
  errors.set({ ...current, [runId]: message });
}

export function useFixErrors(): Readonly<Record<string, string>> {
  return useSyncExternalStore(errors.subscribe, errors.get);
}

/** Runs being brought back right now (a second watcher or a re-render never sends the same write twice). */
export const inFlight = new Set<string>();

// One watcher per page: the first mounted one leads; when it unmounts the next one takes over
const watchers = createStore<readonly symbol[]>([]);

export function joinWatchers(id: symbol): () => void {
  watchers.set([...watchers.get(), id]);
  return () => { watchers.set(watchers.get().filter((item) => item !== id)); };
}

export function useLeadsWatchers(id: symbol): boolean {
  return useSyncExternalStore(watchers.subscribe, () => watchers.get()[0] === id);
}

/**
 * A tool picked in a library item's 修正 menu. The asset library (itself a dialog) closes first and the tool's dialog
 * opens on its own at the page level (LibraryFixHost), so there is never a dialog on a dialog.
 */
export interface LibraryFixRequest {
  itemId: string;
  toolId: string;
}

const libraryRequest = createStore<LibraryFixRequest | null>(null);

export function requestLibraryFix(request: LibraryFixRequest | null): void {
  libraryRequest.set(request);
}

export function useLibraryFixRequest(): LibraryFixRequest | null {
  return useSyncExternalStore(libraryRequest.subscribe, libraryRequest.get);
}
