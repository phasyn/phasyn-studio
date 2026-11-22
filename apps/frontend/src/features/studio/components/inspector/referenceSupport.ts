// Whether the shot's route can take reference material (the Prompt tab's professional editor and the References tab
// both ask): unknown while the routes are still being read; otherwise reference-generation routes take the @ references
// and media-driven routes (表演影片, 音訊驅動) take their driving media from the same list.
import { t } from "@/i18n";
import { findRoute, type Engine } from "../../model/routes";

/** The generic reason (a more specific one is the route's own hint); the References tab offers to switch the route. */
export const REFERENCES_UNSUPPORTED = t("目前路線不支援參考素材");

/** Why the route cannot take references; null = it can (or the routes are still being read). */
export function referenceUnsupported(engine: Engine, routeId: string): string | null {
  const route = findRoute(engine.routes, routeId);
  if (engine.status !== "ready" || route?.purpose === "reference" || route?.family === "creative") return null;
  return route?.referenceHint ?? REFERENCES_UNSUPPORTED;
}
