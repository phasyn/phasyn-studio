// Keyboard helpers of the command palette: list navigation keys, the open/close shortcut and its labels. Pure.

export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";
export const PAGE_JUMP = 8;

const NAV_KEYS = new Set<string>(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.has(key);
}

/** ↑↓ 循環；Home／End 到頭尾；PageUp／PageDown 跳 PAGE_JUMP 項（不循環）。沒有選項回傳 -1。 */
export function moveActive(index: number, count: number, key: NavKey): number {
  if (count <= 0) return -1;
  const current = index >= 0 && index < count ? index : -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(count - 1, Math.max(current, 0) + PAGE_JUMP);
    case "PageUp":
      return Math.max(0, current - PAGE_JUMP);
  }
}

export interface ShortcutEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * Ctrl+K (⌘K on Apple) opens and closes the command palette; Ctrl+Shift+P (⇧⌘P) does the same on every page.
 * plain=false: this page uses Ctrl+K and Ctrl+Shift+K itself (the Video Studio Edit workspace adds edit points with
 * them), so only the Shift+P chord is the palette's there. Alt is never part of the shortcut, nothing is intercepted
 * while an input method composes, and a non-Latin keyboard layout is matched by the physical key.
 */
export function isPaletteShortcut(event: ShortcutEventLike, apple: boolean, plain = true): boolean {
  if (event.isComposing || event.keyCode === 229 || event.altKey) return false;
  const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return false;
  return event.shiftKey ? isLetter(event, "p") : plain && isLetter(event, "k");
}

function isLetter(event: ShortcutEventLike, char: string): boolean {
  return (typeof event.key === "string" && event.key.toLowerCase() === char) || event.code === `Key${char.toUpperCase()}`;
}

/** The chord to show for this page: the plain one where the page leaves it to the palette, else the one that works everywhere. */
export function shortcutLabel(apple: boolean, plain = true): string {
  if (!plain) return apple ? "⇧⌘P" : "Ctrl ⇧ P";
  return apple ? "⌘K" : "Ctrl K";
}

/** Whether this path uses Ctrl+K itself (the Video Studio Edit workspace: add an edit point at the playhead). */
export function pageOwnsPlainShortcut(pathname: string): boolean {
  return pathname.startsWith("/studio/edit");
}
