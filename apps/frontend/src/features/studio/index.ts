// Public entry of Video Studio: what other features (Image Studio, prompt studies) reuse. The page itself is
// lazy-loaded by the app router, so it is not re-exported. Named exports only; add an item here instead of importing a
// file inside the feature.
export { firstFrameImageProblem, firstFrameItemId } from "./model/continuity";
export { catalogLookup, findBranchRecording, resolveTotalSteps, summarizeDit, type DitProgress } from "./model/progress";
export { newProject, newShot, projectReducer, type ProjectAction } from "./model/project";
export {
  componentSlot,
  defaultRouteFor,
  deriveStudioRoutes,
  engineUnavailable,
  findRoute,
  UNASSIGNED_ROUTE,
  type ComponentSlot,
  type StudioRoute,
} from "./model/routes";
export { runRecordingsOptions, stepLogOptions } from "./hooks/useRunProgress";
export { useRunSlots, type RunSlots } from "./hooks/useRunSlots";
export { newLocalId } from "./references/ids";
export { addBlockedReason, IMAGE_MASK_NOTE, newReference } from "./references/materials";
export { libraryName, readMediaFacts } from "./references/media";
