import { createContext } from "react";

/** 管理區左欄下方「大綱」面板的掛載點（由 AdminLayout 提供；頁面以 portal 放入內容，沒有內容時不顯示）。 */
export const OutlinerSlotContext = createContext<HTMLElement | null>(null);
