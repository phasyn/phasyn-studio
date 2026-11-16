// 工作區面板的名稱：收合按鈕與窄軌的名稱，也是面板出現動畫的 key（notePanelToggle 與 usePanelEnter 以同一個字串對上）。
import { t } from "@/i18n";

export const PANEL_NAMES = {
  shots: t("圖片面板"),
  inspector: t("設定面板"),
  takes: t("take 清單"),
} as const;
