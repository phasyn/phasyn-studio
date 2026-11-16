// 管理視窗兩個分頁共用的版面：三欄（篩選、清單、詳情）的欄寬與收合狀態。

export interface PaneLayoutProps {
  railOpen: boolean;
  onToggleRail: () => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  /** 點清單的一列時呼叫：詳情收合著就展開。 */
  onOpenDetail: () => void;
}

/** 欄寬：左欄固定、右欄比清單略寬；收合的欄不佔位置。 */
export function paneColumns(railOpen: boolean, detailOpen: boolean): string {
  if (railOpen && detailOpen) return "grid-cols-[13.5rem_minmax(0,1fr)_minmax(0,1.15fr)]";
  if (railOpen) return "grid-cols-[13.5rem_minmax(0,1fr)]";
  return detailOpen ? "grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : "grid-cols-1";
}
