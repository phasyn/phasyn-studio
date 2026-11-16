// The route of the selected shot (the project default when no shot is selected) and its one-line engine summary,
// shared by the toolbar, the status bar and the engine sheet.
import type { StudioShot } from "@/api/generated/contracts";
import { findRoute, ROUTE_MISSING, type Engine, type StudioRoute } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { t } from "@/i18n";

export interface CurrentRoute {
  routeId: string;
  route: StudioRoute | null;
  engine: Engine;
  shot: StudioShot | undefined;
}

export function useCurrentRoute(): CurrentRoute {
  const { project, selectedShotId, engine } = useStudio();
  const shot = project.shots.find((item) => item.shot_id === selectedShotId);
  const routeId = shot?.route ?? project.defaults.route;
  return { routeId, route: findRoute(engine.routes, routeId), engine, shot };
}

export interface EngineSummary {
  ready: boolean;
  text: string;
  title: string;
}

/** 引擎狀態一行文字：目前鏡頭的路由名稱與就緒狀態。 */
export function engineSummary(engine: Engine, route: StudioRoute | null): EngineSummary {
  if (engine.status === "loading") return { ready: false, text: t("讀取中…"), title: t("還在讀取元件組合與元件目錄") };
  if (engine.status === "error") return { ready: false, text: t("讀取失敗"), title: engine.error ?? "" };
  if (!route) return { ready: false, text: t("路由不存在"), title: ROUTE_MISSING };
  return { ready: route.ready, text: route.ready ? t("就緒") : t("未就緒"), title: route.ready ? t("「{label}」就緒", { label: route.label }) : route.problems.join("\n") };
}
