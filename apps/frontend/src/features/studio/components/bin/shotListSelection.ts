// The shot list's multi-selection for the parts of the Studio outside the list that act on it (the engine sheet's 路線
// tab sets the route of every selected shot). A small external store, like the engine sheet's requested view: the list
// publishes the selected shots' ids (list order) while two or more are selected and withdraws them when the selection
// ends or the list goes away (another workspace, the 素材 tab, the panel collapsed), so a selection never outlives the
// list that shows it. Readers take the shots from the project by id, so a shot deleted meanwhile simply drops out.
import { useId, useLayoutEffect, useSyncExternalStore } from "react";

interface Published {
  /** The list that published it (only that list withdraws it). */
  owner: string;
  ids: readonly string[];
}

let current: Published | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function publish(owner: string, ids: readonly string[] | null): void {
  if (ids === null) {
    withdraw(owner);
    return;
  }
  if (current?.owner === owner && current.ids.length === ids.length && current.ids.every((id, at) => id === ids[at])) return;
  current = { owner, ids };
  emit();
}

function withdraw(owner: string): void {
  if (current?.owner !== owner) return;
  current = null;
  emit();
}

/** The list publishes its multi-selection (null without one) for as long as it is mounted. */
export function usePublishShotSelection(ids: readonly string[] | null): void {
  const ownerId = useId();
  useLayoutEffect(() => { publish(ownerId, ids); }, [ownerId, ids]);
  useLayoutEffect(() => () => { withdraw(ownerId); }, [ownerId]);
}

/** The selected shots' ids (list order) while the shot list has a multi-selection; null otherwise. */
export function useShotListSelection(): readonly string[] | null {
  return useSyncExternalStore(subscribe, () => current?.ids ?? null);
}
