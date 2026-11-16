// 樹狀清單的純函式：攤平成可見列（扁平 ARIA tree：aria-level／posinset／setsize）、搜尋過濾、找祖先。
import type { LucideIcon } from "lucide-react";
import type { Tone } from "./tones";

export interface TreeItem {
  /** 全樹唯一。 */
  id: string;
  label: string;
  icon?: LucideIcon;
  iconTone?: Tone;
  /** 開啟時導向的路徑（含 query）。 */
  to?: string;
  /** tooltip（完整名稱、ID、狀態）。 */
  title?: string;
  /** 次要文字（mono，靠右前）。 */
  detail?: string;
  /** 狀態點（含 aria 文字 dotLabel）。 */
  dot?: Tone | null;
  dotLabel?: string;
  /** 計數徽章。 */
  count?: number | null;
  /** 狀態過時（離線 Node）：文字降為 tertiary。 */
  muted?: boolean;
  /** 搜尋額外比對的字（ID、provider）。 */
  keywords?: readonly string[];
  children?: readonly TreeItem[];
}

export interface TreeRow {
  item: TreeItem;
  level: number;
  parentId: string | null;
  posinset: number;
  setsize: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** 依展開狀態攤平成可見列（深度優先）。 */
export function visibleRows(items: readonly TreeItem[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeItem[], level: number, parentId: string | null) => {
    list.forEach((item, index) => {
      const hasChildren = Boolean(item.children && item.children.length > 0);
      const open = hasChildren && expanded.has(item.id);
      rows.push({ item, level, parentId, posinset: index + 1, setsize: list.length, hasChildren, expanded: open });
      if (open && item.children) walk(item.children, level + 1, item.id);
    });
  };
  walk(items, 1, null);
  return rows;
}

function matches(item: TreeItem, needle: string): boolean {
  if (item.label.toLowerCase().includes(needle)) return true;
  if (item.detail?.toLowerCase().includes(needle)) return true;
  return (item.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle));
}

/**
 * 搜尋：保留符合的項目與其祖先；符合的父項保留全部子項。回傳需要展開的祖先（只用於這次顯示，不寫回偏好）。
 */
export function filterTree(items: readonly TreeItem[], query: string): { items: TreeItem[]; expand: Set<string> } {
  const needle = query.trim().toLowerCase();
  const expand = new Set<string>();
  if (!needle) return { items: [...items], expand };
  const visit = (list: readonly TreeItem[]): TreeItem[] => {
    const out: TreeItem[] = [];
    for (const item of list) {
      if (matches(item, needle)) {
        out.push(item);
        continue;
      }
      const children = item.children ? visit(item.children) : [];
      if (children.length > 0) {
        expand.add(item.id);
        out.push({ ...item, children });
      }
    }
    return out;
  };
  return { items: visit(items), expand };
}

/** 項目的祖先 ID（由根到父）；找不到時回空陣列。 */
export function ancestorsOf(items: readonly TreeItem[], id: string): string[] {
  const path: string[] = [];
  const walk = (list: readonly TreeItem[]): boolean => {
    for (const item of list) {
      if (item.id === id) return true;
      if (item.children) {
        path.push(item.id);
        if (walk(item.children)) return true;
        path.pop();
      }
    }
    return false;
  };
  return walk(items) ? path : [];
}

/** 有子項的項目 ID（深度優先，與畫面順序相同）。 */
export function branchIds(items: readonly TreeItem[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeItem[]) => {
    for (const item of list) {
      if (!item.children || item.children.length === 0) continue;
      out.push(item.id);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

// ---------------------------------------------------------------- 拖曳排序（TreeView 的 opt-in 拖曳用；純函式）

/** 放置指示：畫在哪一列——上緣插入線（before）、下緣插入線（after）或整列高亮（inside，放進資料夾）。 */
export interface TreeDropIndicator {
  rowId: string;
  position: "before" | "after" | "inside";
  /** 插入線的縮排層級（1 起算）；省略＝該列的層級。 */
  level?: number;
}

/** 放置結果：畫面上的指示＋呼叫端自己的放置資料（放開時交回 onDrop）。 */
export interface TreeDropResult<D> {
  indicator: TreeDropIndicator;
  drop: D;
}

export interface VerticalRect {
  top: number;
  bottom: number;
}

/** 開始拖曳的門檻：按下後移動超過 threshold px 才算拖曳，否則仍是點選。 */
export function passedDragThreshold(dx: number, dy: number, threshold = 4): boolean {
  return dx * dx + dy * dy > threshold * threshold;
}

/**
 * 指標的 y 落在哪一列（rects 依畫面順序）與在列內的相對高度（0＝上緣、1＝下緣）。
 * 在第一列之上＝第一列頂端；在最後一列之下＝最後一列底端；沒有列時回傳 null。
 */
export function rowAtY(rects: readonly VerticalRect[], y: number): { index: number; fraction: number } | null {
  if (rects.length === 0) return null;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index] as VerticalRect;
    if (y < rect.bottom) {
      const height = rect.bottom - rect.top;
      const fraction = height > 0 ? (y - rect.top) / height : 0;
      return { index, fraction: Math.min(1, Math.max(0, fraction)) };
    }
  }
  return { index: rects.length - 1, fraction: 1 };
}

/**
 * 拖曳時靠近捲動區上下緣的自動捲動量（px／每個畫面）：距離邊緣 edge px 內開始捲，越靠近（或超出）越快，最多 max。
 * 負值＝往上捲。
 */
export function autoScrollStep(y: number, top: number, bottom: number, edge = 32, max = 14): number {
  if (bottom - top <= edge * 2) return 0;
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}

export function sameIndicator(a: TreeDropIndicator | null, b: TreeDropIndicator | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rowId === b.rowId && a.position === b.position && (a.level ?? 0) === (b.level ?? 0);
}
