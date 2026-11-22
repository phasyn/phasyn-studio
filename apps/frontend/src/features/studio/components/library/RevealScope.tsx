// The scope of a list's staggered entrance (see ./reveal): mounted with key = the list's reveal key.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";

/**
 * 進場的範圍：每次（重新）掛上時是「還沒捲動」，項目依序進場；之後一捲動，新掛上的項目就直接出現。
 * 以 key＝revealKey 掛上，所以篩選、排序、專案或類型改變時重新開始。
 */
export function RevealScope({ scrollRef, style, children }: { scrollRef: RefObject<HTMLElement | null>; style: CSSProperties; children: (scrolled: RefObject<boolean>) => ReactNode }) {
  const scrolledRef = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Scroll events arrive a frame late: the one from the list's own reset to the top (a new filter, sort, project or
    // type) reaches this new scope and must not count, or the first rows would mount without their entrance
    const mark = () => {
      if (element.scrollTop > 0) scrolledRef.current = true;
    };
    element.addEventListener("scroll", mark, { passive: true });
    return () => { element.removeEventListener("scroll", mark); };
  }, [scrollRef]);
  return <div style={style}>{children(scrolledRef)}</div>;
}
