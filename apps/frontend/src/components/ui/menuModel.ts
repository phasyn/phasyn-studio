// Action menu data and placement (pure). Menus are position: fixed next to their trigger or the pointer; they flip
// above when there is no room below and never leave the viewport horizontally.
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** 顯示用的快速鍵提示（例如「Alt+↑」）。 */
  shortcut?: string;
  /** 不能執行的原因（顯示在選項下方）；null／undefined＝可以執行。停用的選項仍可聚焦，方便讀到原因。 */
  disabledReason?: string | null;
  tone?: "danger";
  /** 在這個選項前畫分隔線。 */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** 選單錨點：指標位置（右鍵）或觸發元件（按鈕、Shift+F10）。 */
export type MenuAnchor = { kind: "point"; x: number; y: number } | { kind: "element"; element: HTMLElement };

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 選單左上角位置：預設在錨點下方、左緣對齊；下方放不下時翻到上方，仍放不下就貼齊視窗底部。 */
export function placeMenu(anchor: Rect, menu: Size, viewport: Size, gap = 4, margin = 8): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - margin - menu.width);
  let left = anchor.left;
  if (left > maxLeft) left = Math.max(margin, Math.min(anchor.right, viewport.width - margin) - menu.width);
  left = Math.min(Math.max(margin, left), maxLeft);
  let top = anchor.bottom + gap;
  if (top + menu.height > viewport.height - margin) {
    const above = anchor.top - gap - menu.height;
    top = above >= margin ? above : Math.max(margin, viewport.height - margin - menu.height);
  }
  return { left, top };
}
