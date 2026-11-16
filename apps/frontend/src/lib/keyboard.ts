// Keyboard helpers shared by global shortcuts (shell, command palette, Studio workspaces). Pure apart from reading
// navigator in detectApplePlatform.

/** The parts of a keyboard event the helpers read (React and DOM events both fit). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Opens an action menu from the keyboard: Shift+F10 or the context-menu key (the keyboard twin of a right click). */
export function isMenuKey(event: KeyLike): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === "F10");
}

/** Apple platform names (macOS, iOS, iPadOS) as reported by userAgentData.platform, navigator.platform or the UA. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Whether this browser runs on an Apple platform (⌘ instead of Ctrl); false when navigator is unavailable. */
export function detectApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: unknown } }).userAgentData;
  const platform = typeof data?.platform === "string" && data.platform ? data.platform : navigator.platform || navigator.userAgent || "";
  return isApplePlatform(platform);
}

/** Display name of a modifier on this platform: Mod → ⌘ / Ctrl, Alt → ⌥ / Alt; other keys unchanged. */
export function modifierLabel(key: string, apple: boolean): string {
  if (key === "Mod") return apple ? "⌘" : "Ctrl";
  if (key === "Alt") return apple ? "⌥" : "Alt";
  return key;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** Focus is in a text entry (including selects, where typing jumps between options): global shortcuts stand down. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

/** Focus is inside a dialog or menu: global shortcuts stand down. */
export function isInOverlay(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}
