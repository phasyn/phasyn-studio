// The asset library dialog's code (AssetLibrary.tsx and everything under it) loads on demand, outside the Studio page
// chunk: when the toolbar is idle after mounting, when the pointer or focus reaches the library button, or at the
// latest when the library is opened (also from the project panel). One shared load; a failed load stays failed (a
// reload is the remedy, as for every lazy part) so the dialog can say so instead of retrying silently.
import { useSyncExternalStore } from "react";
import type * as AssetLibrary from "./AssetLibrary";

type AssetLibraryModule = typeof AssetLibrary;

export interface AssetLibraryLoad {
  module: AssetLibraryModule | null;
  failure: unknown;
}

let state: AssetLibraryLoad = { module: null, failure: null };
let started = false;
const listeners = new Set<() => void>();

function set(next: AssetLibraryLoad) {
  state = next;
  for (const listener of listeners) listener();
}

export function loadAssetLibrary(): void {
  if (started) return;
  started = true;
  import("./AssetLibrary").then(
    (module) => { set({ module, failure: null }); },
    (failure: unknown) => { set({ module: null, failure }); },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssetLibraryLoad(): AssetLibraryLoad {
  return useSyncExternalStore(subscribe, () => state);
}
