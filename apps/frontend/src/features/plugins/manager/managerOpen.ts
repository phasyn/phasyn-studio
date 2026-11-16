// 插件管理視窗的開關（模組層級的小型 store）：視窗掛在 Studio 一次（PluginManagerHost），鏡頭「插件」分頁的
// 「管理插件…」與專案管理員的「插件管理…」都透過這裡開啟，可以指定要先看哪個分頁或哪個貢獻。
import { useSyncExternalStore } from "react";
import type { StudioPluginRef } from "@/api/generated/contracts";

export type ManagerTab = "installed" | "project";

export interface ManagerTarget {
  /** 開啟時要看的分頁（沒有指定＝沿用上次的）。 */
  tab?: ManagerTab;
  /** 「這個專案」要選取的貢獻。 */
  ref?: StudioPluginRef;
}

export interface ManagerOpenState {
  open: boolean;
  target: ManagerTarget;
  /** 每次開啟加一，讓視窗知道要套用 target。 */
  serial: number;
}

let state: ManagerOpenState = { open: false, target: {}, serial: 0 };
const listeners = new Set<() => void>();

function set(next: ManagerOpenState) {
  state = next;
  for (const listener of listeners) listener();
}

export function openPluginManager(target: ManagerTarget = {}): void {
  set({ open: true, target, serial: state.serial + 1 });
}

export function closePluginManager(): void {
  if (state.open) set({ ...state, open: false });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginManagerOpen(): ManagerOpenState {
  return useSyncExternalStore(subscribe, () => state);
}
