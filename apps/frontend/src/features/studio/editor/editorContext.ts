// The Video Studio's one editor instance (provided by EditorProvider): the editing state, the transport, the timeline
// view and which panel has the focus. Workspaces and panels read it with useEditor().
import { createContext, useContext } from "react";
import { t } from "@/i18n";
import type { StudioContextValue } from "../studioContext";
import type { createEditorDrafts } from "./drafts";
import type { TimelineViewStore } from "./timelineView";
import type { EditorState } from "./useEditorState";
import type { Transport } from "./useTransport";

/** The panels keyboard shortcuts can act on (the focused one gets the cyan frame). */
export type EditorPanelId = "source" | "controls" | "program" | "timeline" | "project" | "dock";

export interface EditorFocus {
  panel: EditorPanelId;
  setPanel: (panel: EditorPanelId) => void;
}

/** What a monitor that plays a single source (the Source monitor, the take preview of Shots) lets the key map drive while it is mounted. */
export interface SourceMonitorHandle {
  toggle: () => void;
  step: (frames: number) => void;
  seekEdge: (edge: "start" | "end" | "in" | "out") => void;
  /** Mark In / Out at its playhead; absent where there is nothing to mark (the take preview). */
  mark?: (edge: "in" | "out") => void;
  /** J / K / L: -1 back, 0 stop, 1 forward; slow = the Shift variants. Absent = these keys drive the sequence. */
  shuttle?: (direction: -1 | 0 | 1, slow: boolean) => void;
}

/**
 * A command asks a panel to come forward (match frame, reveal in project, rename, speed): the one case where
 * something other than the user's click changes a tab. Selecting never does.
 */
export interface EditorIntent {
  panel: "source" | "controls" | "project";
  /** The field of Effect Controls to focus. */
  field?: "name" | "speed";
  /** Source monitor: the source frame to show (match frame). */
  frame?: number;
  /** Distinguishes two identical requests. */
  id: number;
}

export interface EditorUi {
  /** Whether the Program monitor shows the transform box of the selected layer. */
  transform: boolean;
  setTransform: (on: boolean) => void;
  intent: EditorIntent | null;
  request: (intent: Omit<EditorIntent, "id">) => void;
  /** Whether the Paste Attributes dialog is open (Ctrl/⌘+Alt+V, the clip's menu). */
  pastingAttributes: boolean;
  setPastingAttributes: (open: boolean) => void;
  /** The clip the speed-feel dialog is open for (the clip's menu, Effect Controls, the swap panel's check); null = closed. */
  speedFeelClip: string | null;
  setSpeedFeelClip: (clipId: string | null) => void;
}

/** The workspace the editor is shown in (the URL's /studio/:workspace). */
export type EditorWorkspaceId = "generate" | "edit" | "render";

export interface Editor extends StudioContextValue, EditorState {
  workspace: EditorWorkspaceId;
  transport: Transport;
  view: TimelineViewStore;
  focus: EditorFocus;
  ui: EditorUi;
  drafts: ReturnType<typeof createEditorDrafts>;
  /** The mounted single-source monitor registers itself here (the returned function removes it); current() is null while there is none. */
  sourceMonitor: { register: (handle: SourceMonitorHandle) => () => void; current: () => SourceMonitorHandle | null };
}

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const value = useContext(EditorContext);
  if (!value) throw new Error(t("useEditor 必須在 EditorProvider 內使用"));
  return value;
}
