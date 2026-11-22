// Staggered entrance of a virtualised list's rows (the asset library's collection and the import dialog's grid): items
// enter one after another while the list is freshly mounted and not yet scrolled (RevealScope); once the owner scrolls,
// newly mounted rows appear at once.
import { useCallback, type RefObject } from "react";
import { reveal } from "@/components/ui/motion";

/** 一個項目的進場：清單（重新）掛上後、使用者還沒捲動前才播放。 */
export function useEnter(scrolled: RefObject<boolean>, stagger: number) {
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || scrolled.current) return;
      return reveal(stagger)(node);
    },
    [scrolled, stagger],
  );
}
