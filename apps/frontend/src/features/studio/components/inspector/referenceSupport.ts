// Whether the shot's route can take reference material (the Prompt tab's professional editor and the References tab
// both ask): unknown while the routes are still being read, otherwise only ref2va pipelines can.
import { t } from "@/i18n";
import { findRoute, type Engine } from "../../model/routes";

/** Why the route cannot take references; null = it can (or the routes are still being read). */
export function referenceUnsupported(engine: Engine, routeId: string): string | null {
  const route = findRoute(engine.routes, routeId);
  return engine.status !== "ready" || route?.capability === "ref2va" ? null : (route?.referenceHint ?? t("目前的運算路由不支援參考素材（需要 ref2va 元件組合）"));
}
