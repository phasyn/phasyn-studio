// 詳情的四個分頁與目前看的是哪一個（這台瀏覽器記住上次看的）。
import { usePersistentChoice } from "@/lib/usePersistentSize";

export const DETAIL_TABS = ["overview", "contents", "permissions", "files"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export function isDetailTab(value: string): value is DetailTab {
  return (DETAIL_TABS as readonly string[]).includes(value);
}

export function useDetailTab() {
  return usePersistentChoice<DetailTab>("plugins.manager.detail", "overview", DETAIL_TABS);
}
