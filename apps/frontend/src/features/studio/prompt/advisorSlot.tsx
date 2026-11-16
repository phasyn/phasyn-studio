// 「修正與建議」的插槽：實作在 prompt/advisor/**（PromptAdvisorPanel／PromptAdvisorBadge）；這裡固定 props 介面與接線。
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { PromptAdvisorBadge, PromptAdvisorPanel } from "./advisor";

export type PromptTask = "t2va" | "fl2va" | "ref2va";

export interface AdvisorSlotProps {
  /** 目前的 prompt 全文。 */
  text: string;
  /** 鏡頭影格數（24 fps）；呼叫端沒提供時為 0＝未知。 */
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 這個鏡頭的 H3 任務（呼叫端沒提供時為 undefined＝未知）。 */
  mode?: PromptTask;
  /** 編輯器停用：可以看與複製，不能套用或插入。 */
  disabled?: boolean;
  /** 套用修正或改寫：以新的全文取代（經 onChange，編輯器留下可復原的提示）；label 是改了什麼。 */
  onApplyFix: (next: string, label: string) => void;
  /** 在編輯器選取並捲動到全文中的 [start, end)。 */
  onRevealRange?: (start: number, end: number) => void;
  /** 插入範本：有標題的區塊附加在選取的區塊後面，其他文字插入到游標位置。 */
  onInsertTemplate?: (text: string) => void;
}

export interface AdvisorBadgeSlotProps {
  text: string;
  frames: number;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  mode?: PromptTask;
  /** 編輯器停用：浮層可以看，修正不能套用。 */
  disabled?: boolean;
  /** 打開專業 Prompt 編輯器的「修正與建議」分頁。 */
  onOpen: () => void;
  /** 浮層裡的一鍵修正：以新的全文取代並留下可以復原的提示；false＝沒有套用（例如超過字數上限）。 */
  onApplyFix: (next: string, label: string) => boolean;
}

/** 「修正與建議」面板（專業 Prompt 編輯器側欄分頁；由外層容器捲動）。 */
export function AdvisorSlot(props: AdvisorSlotProps) {
  return <PromptAdvisorPanel {...props} />;
}

/** 行內編輯器工具列的「建議 n」：錯誤＋警告＋建議數，按下打開列出發現與一鍵修正的浮層。 */
export function AdvisorBadgeSlot(props: AdvisorBadgeSlotProps) {
  return <PromptAdvisorBadge {...props} />;
}
