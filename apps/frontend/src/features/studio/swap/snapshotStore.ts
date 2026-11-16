// A small keyed store for useSyncExternalStore: every change replaces the snapshot (a new ReadonlyMap), so a render
// reads one consistent picture. Bounded: past `limit` entries the oldest go first (a set refreshes an entry's age).

export interface SnapshotStore<V> {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  delete: (key: string) => void;
  snapshot: () => ReadonlyMap<string, V>;
  subscribe: (listener: () => void) => () => void;
}

export function snapshotStore<V>(limit: number): SnapshotStore<V> {
  let entries = new Map<string, V>();
  const listeners = new Set<() => void>();
  const publish = (next: Map<string, V>) => {
    while (next.size > limit) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    entries = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      const next = new Map(entries);
      next.delete(key);
      next.set(key, value);
      publish(next);
    },
    delete: (key) => {
      if (!entries.has(key)) return;
      const next = new Map(entries);
      next.delete(key);
      publish(next);
    },
    snapshot: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
