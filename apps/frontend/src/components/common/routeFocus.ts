// 路由切換後把焦點移到新頁面的標題；首次載入與同頁 search 參數變更不移動焦點。
let pending = false;

export function markRouteFocusPending(): void {
  pending = true;
}

export function consumeRouteFocus(): boolean {
  const value = pending;
  pending = false;
  return value;
}

/**
 * Where focus can land on the current page when the control that had it is gone: the page title (PageHeader's
 * focusable h1#page-title), else the main content (AppShell's main#main-content).
 */
export function pageFocusTarget(): HTMLElement | null {
  return document.getElementById("page-title") ?? document.getElementById("main-content");
}
