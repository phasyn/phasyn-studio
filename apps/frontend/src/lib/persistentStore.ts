// Per-browser convenience state in localStorage (remembered choices, recents, compare lists) as a small external
// store: React reads it with useSyncExternalStore, other tabs follow through the `storage` event, and when storage is
// unavailable (private mode, blocked site data) the value simply lives in memory for this session.
import { useSyncExternalStore } from "react";

export interface PersistentStoreOptions<T> {
  /** localStorage key (`phasyn.<area>.<name>`). */
  key: string;
  /** Value when nothing (valid) is stored. */
  initial: T;
  /** Turns the parsed JSON into a value; throw (or return `initial`) for an unexpected shape. */
  parse: (raw: unknown) => T;
  /** What to store (default: the value itself), written with JSON.stringify. */
  serialize?: (value: T) => unknown;
  /** Follow writes made in other tabs (default true). */
  crossTab?: boolean;
}

/** A function passed to set always updates the previous value; functions themselves cannot be JSON preferences. */
type StoreUpdate<T> = Exclude<T, (...args: never[]) => unknown> | ((current: T) => T);

function isUpdater<T>(candidate: StoreUpdate<T>): candidate is (current: T) => T {
  return typeof candidate === "function";
}

export interface PersistentStore<T> {
  get(): T;
  set(next: StoreUpdate<T>): void;
  subscribe(listener: () => void): () => void;
  /** React hook: the current value, re-rendering on every change. */
  use(): T;
  /** Forgets the cached value and the in-memory fallback (tests). */
  reset(): void;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function createPersistentStore<T>(options: PersistentStoreOptions<T>): PersistentStore<T> {
  const { key, initial, parse, serialize = (value: T) => value, crossTab = true } = options;
  const listeners = new Set<() => void>();
  let memory: T = initial;
  let snapshot: { value: T } | null = null;

  const read = (): T => {
    try {
      const raw = storage()?.getItem(key);
      return raw === null || raw === undefined ? memory : parse(JSON.parse(raw));
    } catch {
      return memory;
    }
  };

  const get = (): T => {
    snapshot ??= { value: read() };
    return snapshot.value;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const set = (next: StoreUpdate<T>): void => {
    const value = isUpdater(next) ? next(get()) : next;
    if (Object.is(value, get())) return;
    memory = value;
    snapshot = { value };
    try {
      storage()?.setItem(key, JSON.stringify(serialize(value)));
    } catch {
      // Storage refused the write (quota, private mode): the value stays in memory for this session.
    }
    notify();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      // Removed (or the whole storage cleared) in another tab: follow it back to the initial value
      if (event.key === null || event.newValue === null) memory = initial;
      snapshot = null;
      listener();
    };
    if (crossTab && typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      if (crossTab && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  };

  return {
    get,
    set,
    subscribe,
    use: function usePersistentStore() {
      return useSyncExternalStore(subscribe, get, () => initial);
    },
    reset: () => {
      memory = initial;
      snapshot = null;
    },
  };
}
