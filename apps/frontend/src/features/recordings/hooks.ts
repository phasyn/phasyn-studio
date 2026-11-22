import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { recordingPath } from "@/app/paths";

/** 前往另一筆 recording 的連結：保留目前的篩選與分頁參數。 */
export function useRecordingHref(): (recordingId: string) => string {
  const { search } = useLocation();
  return useCallback((recordingId: string) => recordingPath(recordingId, search), [search]);
}

/**
 * 以 callback ref 觀察元素內容寬度（ResizeObserver）；元素替換或卸載時中斷觀察。
 * 第一次量測前 width 為 0（呼叫端保留版面高度，量到後再畫）。
 */
export function useElementWidth(): [(node: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [element]);
  return [setElement, width];
}
