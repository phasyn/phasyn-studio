// Mounts the one editor instance of a project for every Video Studio workspace: the timeline document
// (StudioProject.timeline as the Controller answered it, with the edits made since), its state, the transport and the
// timeline view, with the editor's dialogs and its one live region (EditAnnouncer). Switching workspace changes the
// layout around it, never this state.
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { t } from "@/i18n";
import { SpeedFeelDialog } from "../speedfeel/SpeedFeelDialog";
import { useStudio, type ShotListener } from "../studioContext";
import { createEditorDrafts, EditorDraftContext } from "./drafts";
import { EditAnnouncer } from "./EditAnnouncer";
import { EditorContext, type Editor, type EditorIntent, type EditorPanelId, type EditorUi, type EditorWorkspaceId, type SourceMonitorHandle } from "./editorContext";
import { createEditHistory } from "./history";
import { PasteAttributesDialog } from "./PasteAttributesDialog";
import { ShorterTakeDialog } from "./ShorterTakeDialog";
import { emptyTimeline, projectTimeline } from "./sources";
import { createTimelineView } from "./timelineView";
import { useEditorKeys } from "./useEditorKeys";
import { useFileDropGuard } from "./useFileDropGuard";
import { useEditorState } from "./useEditorState";
import { useTransport } from "./useTransport";
import { DialogueJobsRunner } from "../dialogue/useDialogueJobs";
import { LibraryFixHost } from "../fix";

export function EditorProvider({ children }: { children: ReactNode }) {
  const studio = useStudio();
  const { project, playhead, setMonitorMode, notify, listenShots } = studio;
  const [history] = useState(createEditHistory);
  const [drafts] = useState(createEditorDrafts);
  const [view] = useState(createTimelineView);
  const [panel, setPanel] = useState<EditorPanelId>("timeline");
  const [transform, setTransform] = useState(false);
  const [intent, setIntent] = useState<EditorIntent | null>(null);
  const [pastingAttributes, setPastingAttributes] = useState(false);
  const [speedFeelClip, setSpeedFeelClip] = useState<string | null>(null);
  const monitorRef = useRef<SourceMonitorHandle | null>(null);
  const [sourceMonitor] = useState<Editor["sourceMonitor"]>(() => ({
    register(handle) {
      monitorRef.current = handle;
      return () => {
        if (monitorRef.current === handle) monitorRef.current = null;
      };
    },
    current: () => monitorRef.current,
  }));

  const result = useMemo(() => projectTimeline(project), [project]);
  // A timeline that cannot be edited is replaced by an empty stand-in: nothing plays and edits are refused with the reason
  const built = useMemo(() => (result.ok ? result.value : emptyTimeline(project.format.fps)), [result, project.format.fps]);
  // A project without a saved timeline answers an equal empty document for every snapshot: keep the object, so nothing downstream reacts
  const [held, setHeld] = useState(built);
  let timeline = held;
  if (held !== built && JSON.stringify(held) !== JSON.stringify(built)) {
    setHeld(built);
    timeline = built;
  }

  const state = useEditorState({ studio, timeline, problem: result.ok ? null : result.error, history });
  const transport = useTransport({
    playhead,
    totalFrames: state.totalFrames,
    fps: state.fps,
    setMonitorMode,
    onAudioBlocked: () => { notify({ tone: "warning", title: t("無法啟動瀏覽器音訊輸出") }); },
  });

  // A shot chosen in the Shots workspace selects its clip here (the reverse happens in select()); a new shot joins the film
  const { selectShotClip, placeShot } = state;
  const shots = useEffectEvent((): ShotListener => ({ selected: selectShotClip, added: (shot) => { placeShot(shot); } }));
  useEffect(() => listenShots({ selected: (shotId) => { shots().selected(shotId); }, added: (shot) => { shots().added(shot); } }), [listenShots]);

  const focus = useMemo(() => ({ panel, setPanel }), [panel]);
  const ui = useMemo<EditorUi>(
    () => ({
      transform,
      setTransform,
      intent,
      request: (next) => { setIntent((current) => ({ ...next, id: (current?.id ?? 0) + 1 })); },
      pastingAttributes,
      setPastingAttributes,
      speedFeelClip,
      setSpeedFeelClip,
    }),
    [transform, intent, pastingAttributes, speedFeelClip],
  );
  const { workspace: routeWorkspace } = useParams();
  const workspace: EditorWorkspaceId = routeWorkspace === "generate" || routeWorkspace === "render" ? routeWorkspace : "edit";
  const editor = useMemo<Editor>(() => ({ ...studio, ...state, workspace, transport, view, focus, ui, drafts, sourceMonitor }), [studio, state, workspace, transport, view, focus, ui, drafts, sourceMonitor]);
  useEditorKeys(editor);
  useFileDropGuard();
  return (
    <EditorContext value={editor}>
      <EditorDraftContext value={drafts}>
        {children}
        <DialogueJobsRunner />
        <LibraryFixHost />
        <ShorterTakeDialog />
        <PasteAttributesDialog />
        <SpeedFeelDialog />
        <EditAnnouncer history={history} />
      </EditorDraftContext>
    </EditorContext>
  );
}
