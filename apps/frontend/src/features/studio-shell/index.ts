// Public entry of the Studio shell: the frame both Studios share (project document and autosave, save state and
// conflict banner, notices, project switching, the engine sheet, uploads, panel layout). Each Studio keeps
// its own workspaces, document reducer, render planning and engine resolution.
export { createDocReducer, type DocEvent, type DocReducer, type DocState, type PendingAction, type SaveStatus, type VersionedDoc } from "./document/docReducer";
export { useAutosaveDocument, type AutosaveDocument, type AutosaveOptions } from "./document/useAutosaveDocument";
export { OUTSIDE_SAVES_POLL_MS, useOutsideSaves } from "./document/useOutsideSaves";
export { StudioShellContext, useStudioShell, useStudioShellValue, type ShellDoc, type StudioShellValue } from "./StudioShellContext";
export { StudioNotices } from "./notices/StudioNotices";
export type { Notice, NoticeInput } from "./notices/useNotices";
export { SaveIndicator } from "./SaveIndicator";
export { ConflictBanner } from "./ConflictBanner";
export { SaveFailureBanner } from "./SaveFailureBanner";
export { ProjectSwitcher, type ProjectSwitcherProps } from "./ProjectSwitcher";
export { NewProjectForm, type NewProjectFormProps } from "./NewProjectForm";
export { EngineSheet, type EngineSheetProps } from "./engine/EngineSheet";
export { ComponentRow, type ComponentRowProps } from "./engine/ComponentRow";
export { useEngineControl, type EngineControl } from "./engine/useEngineControl";
export { UploadProblem, useUploadQueue, type UploadRequest, type UploadRun, type UploadState, type UploadTask } from "./uploads/useUploadQueue";
export { UploadTaskRow } from "./uploads/UploadTaskRow";
export { LoadingPanels } from "./layout/LoadingPanels";
export { CollapsedRail, PanelCollapseButton, SectionTitle } from "./layout/panels";
