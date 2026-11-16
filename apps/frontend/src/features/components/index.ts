// Public entry of the components feature: other features import only from here. The page itself is lazy-loaded by the
// app router (app/lazyPages.tsx), so it is not re-exported. Only what other features use is exported; for exclusive
// groups that is useComponentControl plus exclusiveConflict / exclusiveBlockReason / exclusiveReplaceNote and their
// types. requestStart, the confirmation queue, batching, start watching and waiting stay internal.
export {
  exclusiveBlockReason,
  exclusiveConflict,
  exclusiveReplaceNote,
  type ExclusiveConflict,
  type ExclusiveHolder,
  type ExclusiveTarget,
} from "./control/exclusive";
export {
  useComponentControl,
  type ComponentControl,
  type ControlAction,
  type ControlEvent,
  type ControlFailure,
  type ControlOutcome,
  type ControlPhase,
} from "./control/useComponentControl";
export { LastLoadNote } from "./LastLoadNote";
export { isResidentComponent, RESIDENT_HINT } from "./resident";
export { sectionSchemas } from "./settingsModel";
