// A study workspace's initial screen state, from what the study remembers: its saved settings, else the settings frozen
// into its latest task, else the defaults. Pure.
import type { GenerationSettings, PromptStudy, TaskComponents } from "../types";
import { DEFAULT_SETTINGS, normalizeSettings, studySettings, taskSettings } from "./normalize";
import type { ImageRoute } from "./routes";
import { INITIAL_SEARCH, type SearchDraft } from "./search";

/**
 * The pipeline a study generates with until one is chosen: a ready one, else the first that generates text-to-image
 * (its components can be started before generating), else the first in the list. Reverse prompting generates from text
 * only, so an image-to-image pipeline is picked only when there is no other; `textToImage` is Image Studio's judgment.
 */
export function defaultRouteId(routes: readonly Pick<ImageRoute, "id" | "ready">[], textToImage: (routeId: string) => boolean): string {
  return (routes.find((route) => route.ready) ?? routes.find((route) => textToImage(route.id)) ?? routes[0])?.id ?? "";
}

/** 研究記住的生成設定；沒有時用最近一次生成任務凍結的設定，再沒有用預設。 */
export function initialSettings(study: PromptStudy): GenerationSettings {
  const saved = studySettings(study).generation;
  if (saved) return saved;
  for (let index = study.tasks.length - 1; index >= 0; index -= 1) {
    const request = study.tasks[index]?.request;
    if (request?.kind === "render" || request?.kind === "reconstruct") {
      const frozen = normalizeSettings(request.settings);
      if (frozen) return frozen;
    }
  }
  return DEFAULT_SETTINGS;
}

export function initialComponents(study: PromptStudy): TaskComponents {
  const saved = studySettings(study).components;
  if ((saved.vision ?? "") || (saved.compile != null && saved.compile !== "") || (saved.score != null && saved.score !== "")) return saved;
  for (let index = study.tasks.length - 1; index >= 0; index -= 1) {
    const request = study.tasks[index]?.request;
    if (request?.kind === "render" || request?.kind === "reconstruct") {
      const frozen = taskSettings(request.settings)?.components;
      if (frozen) return frozen;
    }
  }
  return { vision: null, compile: null, score: null };
}

export function initialSearch(study: PromptStudy): SearchDraft {
  for (let index = study.tasks.length - 1; index >= 0; index -= 1) {
    const request = study.tasks[index]?.request;
    if (request?.kind === "reconstruct") {
      return {
        searchSeeds: request.search_seeds.join(", "),
        holdoutSeeds: request.holdout_seeds.join(", "),
        rounds: String(request.max_rounds),
        budget: String(request.max_images),
        stopAfter: String(request.stop_after_no_improvement),
      };
    }
  }
  return INITIAL_SEARCH;
}
