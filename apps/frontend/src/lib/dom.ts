import type { NavigateOptions } from "react-router";
import type { ReactNode } from "react";

/** 把任意路徑轉成合法的 DOM id 片段（同一頁面以 prefix 區隔）。 */
export function domId(prefix: string, path: string): string {
  return `${prefix}-${path.replace(/[^A-Za-z0-9_-]+/g, "-") || "root"}`;
}

/** An explicit edit or picker replaces its trigger. Put focus into that control without scrolling the workspace. */
export function focusOpenedControl(node: HTMLElement | null): void {
  if (node && node.dataset["initialFocus"] !== "false") node.focus({ preventScroll: true });
}

/** Keep the layout of optional slots: an empty label or numeric placeholder should not allocate a wrapper. */
export function hasSlotContent(value: ReactNode): boolean {
  return value != null && value !== false && value !== "" && value !== 0n
    && (typeof value !== "number" || (value !== 0 && !Number.isNaN(value)));
}

/**
 * React Router's navigation snapshots keep the outgoing page visible while Studio's lazy outlet loads.
 * React 19.3.1's boundary can instead snapshot a blank Suspense outlet for the entire 620 ms animation.
 * Retire this compatibility option once both Studio areas paint continuously during a cold navigation.
 */
export function pageTransition(enabled = true): Pick<NavigateOptions, "viewTransition"> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Keep cold Suspense navigations visible until React snapshots the loaded outlet.
  return { viewTransition: enabled };
}

/** Copy on secure origins and on the owner’s plain-HTTP LAN. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && "clipboard" in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 改用下方的選取複製
  }
  // 內網 HTTP（非 secure context）沒有 clipboard API：以暫時 textarea 選取後複製。
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- The Clipboard API is unavailable on the supported plain-HTTP LAN origin.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** IME confirmation consumes the key even on browsers that clear isComposing before delivering Enter. */
export function compositionKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME events retain the 229 sentinel after isComposing has been cleared.
  return event.isComposing || event.keyCode === 229;
}
