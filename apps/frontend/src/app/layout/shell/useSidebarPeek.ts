// 全收側欄的滑出與收回：指標停在螢幕左緣 1 秒（或點左緣的把手、鍵盤焦點進入側欄）時滑出；指標離開側欄後
// 短暫寬限再收回，按 Esc 或焦點離開側欄也收回。狀態立即改變，滑動由 AppShell 的 Motion 彈簧呈現。
import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/** 指標在左緣停留多久才滑出（ms）。 */
const DWELL_MS = 1000;
/** 指標離開側欄後的寬限（ms）：短暫滑出邊界再回來不會收回。 */
const GRACE_MS = 350;

export interface SidebarPeek {
  /** 全收狀態下側欄目前是否滑出。 */
  revealed: boolean;
  reveal: () => void;
  /** 左緣感應區（把手）：停留 1 秒後滑出。 */
  edgeHandlers: { onPointerEnter: () => void; onPointerLeave: () => void };
  /** 側欄本身：指標進出、焦點進出、Esc。 */
  panelHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * enabled＝側欄是全收狀態（其他狀態永遠 revealed＝false、計時器全部清掉）。panelRef 用來判斷焦點是否還在側欄裡，
 * handleRef 是收回時接住焦點的把手（Esc 收回後焦點不會留在畫面外）。
 */
export function useSidebarPeek(enabled: boolean, panelRef: RefObject<HTMLElement | null>, handleRef: RefObject<HTMLElement | null>): SidebarPeek {
  const [revealed, setRevealed] = useState(false);
  const dwellRef = useRef<number | null>(null);
  const graceRef = useRef<number | null>(null);

  const clearTimer = useCallback((timer: { current: number | null }) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reveal = useCallback(() => {
    clearTimer(dwellRef);
    clearTimer(graceRef);
    setRevealed(true);
  }, [clearTimer]);

  const conceal = useCallback(() => {
    clearTimer(dwellRef);
    clearTimer(graceRef);
    setRevealed(false);
  }, [clearTimer]);

  // 離開全收狀態時收回（render 時調整 state，React 允許）；離開或卸載時清掉計時器
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) setRevealed(false);
  }
  useEffect(() => {
    if (!enabled) return undefined;
    return () => {
      clearTimer(dwellRef);
      clearTimer(graceRef);
    };
  }, [enabled, clearTimer]);

  const edgeHandlers = {
    onPointerEnter: () => {
      if (!enabled) return;
      clearTimer(graceRef);
      dwellRef.current ??= window.setTimeout(reveal, DWELL_MS);
    },
    onPointerLeave: () => { clearTimer(dwellRef); },
  };

  const panelHandlers = {
    onPointerEnter: () => { clearTimer(graceRef); },
    onPointerLeave: () => {
      if (!enabled) return;
      clearTimer(graceRef);
      graceRef.current = window.setTimeout(() => {
        graceRef.current = null;
        const panel = panelRef.current;
        const active = document.activeElement;
        // 原生下拉選單（介面語言）開著時，指標會落在瀏覽器的選單上：不收回
        if (panel && active instanceof HTMLSelectElement && panel.contains(active)) return;
        // 指標收回時焦點不留在畫面外的連結上
        if (panel && active instanceof HTMLElement && panel.contains(active)) active.blur();
        conceal();
      }, GRACE_MS);
    },
    onFocus: () => {
      if (enabled) reveal();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!enabled) return;
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      // 焦點移到側欄外（Tab 離開或點了主區）：鍵盤使用者收回；指標還在側欄上時由 pointerleave 決定
      if (!event.currentTarget.matches(":hover")) conceal();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled || event.key !== "Escape" || !revealed) return;
      event.preventDefault();
      conceal();
      handleRef.current?.focus({ preventScroll: true });
    },
  };

  return { revealed: enabled && revealed, reveal, edgeHandlers, panelHandlers };
}
