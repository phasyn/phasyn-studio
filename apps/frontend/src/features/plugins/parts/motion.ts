// 這個功能用到的動作小工具；時間與曲線都來自共用的 token（components/ui/motion）。
import { useCallback, useState, type RefCallback } from "react";
import { playMotion, reveal } from "@/components/ui/motion";

/**
 * 清單列的進場：掛上時依當時的序號延遲進場一次。之後篩選或排序讓序號改變時不重播（位置的變化由 useFlipList 補位），
 * 所以打字搜尋時留在清單上的列不會閃動。
 */
export function useRevealRef(index: number): RefCallback<HTMLElement | SVGElement> {
  const [ref] = useState(() => reveal(index));
  return ref;
}

/** 換了對象（另一個包、另一個貢獻）的詳情內容：從右側滑入（smooth 彈簧）。搭配 key＝對象 id 使用。 */
export function useSlideIn<T extends HTMLElement>(): RefCallback<T> {
  return useCallback((node: T | null) => {
    if (!node) return;
    playMotion(
      node,
      [
        { opacity: 0, transform: "translateX(12px)" },
        { opacity: 1, transform: "translateX(0px)" },
      ],
      { duration: "spring-smooth", easing: "spring-smooth" },
    );
  }, []);
}
