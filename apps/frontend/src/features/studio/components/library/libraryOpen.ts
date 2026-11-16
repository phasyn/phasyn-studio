// Asset Library 對話框的開關（模組層級的小型 store）：對話框掛在 Studio 工具列（每個工作區都在），專案面板「素材」分頁的
// 「開啟素材庫」按鈕與工具列按鈕都透過這裡開啟；可以指定要先選取的素材。
import { useSyncExternalStore } from "react";

export interface LibraryOpenState {
  open: boolean;
  /** 開啟時要選取的素材（null＝沿用上次的選取）。 */
  itemId: string | null;
  /** 每次開啟加一，讓對話框知道要套用 itemId。 */
  serial: number;
}

let state: LibraryOpenState = { open: false, itemId: null, serial: 0 };
const listeners = new Set<() => void>();

function set(next: LibraryOpenState) {
  state = next;
  for (const listener of listeners) listener();
}

export function openAssetLibrary(itemId: string | null = null): void {
  set({ open: true, itemId, serial: state.serial + 1 });
}

export function closeAssetLibrary(): void {
  if (state.open) set({ ...state, open: false });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssetLibraryOpen(): LibraryOpenState {
  return useSyncExternalStore(subscribe, () => state);
}
