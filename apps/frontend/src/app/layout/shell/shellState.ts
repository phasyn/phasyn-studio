// 外殼的共用狀態：側欄寬度與「Image／Video Studio 最近開啟的專案」記憶（側欄與行動版抽屜共用）。
import { useState } from "react";
import { useLocation } from "react-router";
import { EMPTY_STUDIO_MEMORY, rememberStudio, type StudioMemory } from "@/app/areas";
import { usePersistentChoice } from "@/lib/usePersistentSize";

/** 展開／收合時的側欄寬度（px）；全收（hidden）時不佔寬度，滑出來的覆蓋側欄用展開的寬度。 */
export const SIDEBAR_WIDTH = { expanded: 232, collapsed: 64 } as const;

/** 側欄的三種狀態：展開（名稱）、收合（64 px 圖示軌）、全收（不佔寬度，指標停在左緣或鍵盤焦點進入時滑出）。 */
export type SidebarMode = "expanded" | "collapsed" | "hidden";
const SIDEBAR_MODES: readonly SidebarMode[] = ["expanded", "collapsed", "hidden"];

/** 舊版只存「收合與否」的旗標（phasyn.flag.shell.sidebar.collapsed）：還沒有三態偏好時沿用它，否則窄於 1600 px 預設收合。 */
function initialSidebarMode(): SidebarMode {
  try {
    const legacy = window.localStorage.getItem("phasyn.flag.shell.sidebar.collapsed");
    if (legacy !== null) return legacy === "1" ? "collapsed" : "expanded";
  } catch {
    // 讀不到儲存：用視窗寬度決定
  }
  return typeof window !== "undefined" && window.innerWidth < 1600 ? "collapsed" : "expanded";
}

/** 側欄狀態（這台瀏覽器的偏好，phasyn.choice.shell.sidebar.mode）。 */
export function useSidebarMode() {
  const [fallback] = useState(initialSidebarMode);
  return usePersistentChoice<SidebarMode>("shell.sidebar.mode", fallback, SIDEBAR_MODES);
}

/**
 * Image／Video Studio 的連結帶著這個分頁最近開啟的專案（Video Studio 回到上次的工作區）：由網址推導的記憶，
 * render 時更新（同一個元件的 state，React 允許），沒有變化時是同一個物件、不會重繪。
 */
export function useStudioMemory(): StudioMemory {
  const { pathname, search } = useLocation();
  const [memory, setMemory] = useState(EMPTY_STUDIO_MEMORY);
  const next = rememberStudio(memory, pathname, search);
  if (next !== memory) setMemory(next);
  return next;
}
