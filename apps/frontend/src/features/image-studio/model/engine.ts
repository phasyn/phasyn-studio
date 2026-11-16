// 生成引擎（運算路由需要的元件）的一行摘要（純函式）。互斥群組（同一台 Node 一次只能載入一個 DiT，
// ）由 Node 執行，畫面上的提示與確認在 features/components/exclusiveStart。
import { UNASSIGNED_ROUTE } from "@/features/studio";
import type { ImageRoute } from "./routes";
import { t } from "@/i18n";

export type EngineStatus = "loading" | "error" | "ready";

export interface EngineSummary {
  ready: boolean;
  text: string;
  title: string;
}

/** 這台主控還沒有任何可以生圖的元件組合（「基本」分頁提供範本）。 */
export const NO_IMAGE_ENGINE = t("還沒有可以生圖的引擎");

/** 引擎狀態一行文字：目前圖片的路由名稱與就緒狀態；noRoutes＝沒有任何圖片元件組合。 */
export function engineSummary(status: EngineStatus, error: string | null, route: ImageRoute | null, routeId: string, noRoutes: boolean): EngineSummary {
  if (status === "loading") return { ready: false, text: t("讀取中…"), title: t("還在讀取元件組合與元件目錄") };
  if (status === "error") return { ready: false, text: t("讀取失敗"), title: error ?? "" };
  if (noRoutes) return { ready: false, text: NO_IMAGE_ENGINE, title: NO_IMAGE_ENGINE };
  if (!route) return { ready: false, text: t("路由不存在"), title: routeId === UNASSIGNED_ROUTE ? t("還沒有選擇運算路由") : t("找不到元件組合 {routeId}", { routeId }) };
  return { ready: route.ready, text: route.ready ? t("就緒") : t("未就緒"), title: route.ready ? t("「{label}」就緒", { label: route.label }) : route.problems.join("\n") };
}
