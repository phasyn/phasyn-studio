// Where keyboard focus goes when a Radix dialog closes. Shared by DialogContent and SheetContent (./dialog.tsx) and by
// dialogs that lay out their own Radix content (the professional prompt editor).
import type { DialogContentProps } from "@radix-ui/react-dialog";
import { useRef } from "react";

/**
 * Focus handlers for a dialog's Radix content:
 * 1. When the user or the caller has already moved focus elsewhere (not to the page) while the dialog was closing,
 *    focus is not pulled back to the trigger.
 * 2. Without a Dialog.Trigger (a dialog opened from code) Radix has nowhere to return focus: it goes back to the element
 *    that had focus when the dialog opened, while that element is still on the page.
 * The caller's own handlers run first; when its onCloseAutoFocus calls preventDefault, focus is left to the caller.
 */
export function useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus }: Pick<DialogContentProps, "onOpenAutoFocus" | "onCloseAutoFocus">) {
  const openerRef = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        event.preventDefault();
        return;
      }
      const fallback = openerRef.current;
      openerRef.current = null;
      // Radix then gives focus to the trigger; without one focus stays on the page, so return it to the opener
      queueMicrotask(() => {
        if (document.activeElement === document.body && (fallback?.isConnected === true)) fallback.focus({ preventScroll: true });
      });
    },
  };
}

/**
 * For a dialog's onCloseAutoFocus when the control that opened it can leave the page while the dialog is open (a Cancel
 * button shown only while its run is running): while `opener` is on the page nothing is done, so focus returns to it
 * as usual; once it is gone, focus goes to `fallback` instead of falling to the page.
 */
export function returnFocusOr(event: Event, opener: HTMLElement | null, fallback: HTMLElement | null | undefined): void {
  if ((opener?.isConnected ?? false) || !(fallback?.isConnected === true)) return;
  event.preventDefault();
  fallback.focus();
}
