// The Edit workspace: a header with the task layouts over a four-region grid. Top row: the Source group (Source,
// Effect Controls, Audio) and the Program monitor, equal by default, plus the layout's dock on the right. Bottom row:
// the Project group, the tools strip, the timeline and the audio meters. Both rows always fit the window (each grid row
// is bounded and every panel scrolls inside itself). Every splitter, tab and collapsed state is remembered in this
// browser; what is edited is the Video Studio's one editor instance, shared with Shots.
import { AudioLines, Captions, Clapperboard, Flag, FolderOpen, History, Palette, SlidersHorizontal, Sparkles, Type, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { notePanelToggle } from "@/components/ui/motion";
import { PanelGroup, type PanelGroupTab } from "@/components/workbench/PanelGroup";
import { Splitter } from "@/components/workbench/Splitter";
import { t } from "@/i18n";
import { useElementSize } from "@/lib/useElementSize";
import { usePersistentSize } from "@/lib/usePersistentSize";
import { useEditor, type EditorPanelId } from "./editorContext";
import { EditHeader } from "./layout/EditHeader";
import { EDIT_LAYOUTS, useEditLayout, useLayoutState, type BottomTabId, type DockId, type EditLayoutId, type TopTabId } from "./layout/layouts";
import { ToolsStrip } from "./layout/ToolsStrip";
import { ProgramMonitor } from "./monitors/ProgramMonitor";
import { SourceMonitor } from "./monitors/SourceMonitor";
import { AudioMeters } from "./panels/AudioMeters";
import { AudioMixer } from "./panels/AudioMixer";
import { CaptionsPanel } from "./panels/CaptionsPanel";
import { ColorDock } from "./panels/ColorDock";
import { EffectControls } from "./panels/EffectControls";
import { EffectsBrowser } from "./panels/EffectsBrowser";
import { HistoryPanel } from "./panels/HistoryPanel";
import { MarkersPanel } from "./panels/MarkersPanel";
import { MigrationNotice } from "./panels/MigrationNotice";
import { ProjectPanel } from "./panels/ProjectPanel";
import { TextDock } from "./panels/TextDock";
import { TimelinePanel } from "./timeline/TimelinePanel";

const GAP = 6;
const RAIL = 44;
const TOOLS = 44;
/** The monitors never get less than this… */
const TOP_MIN = 220;
/** …and the timeline row keeps this much (its toolbar, ruler and three tracks) before the monitors grow further. */
const BOTTOM_MIN = 300;
/** Below this width of the workspace (a 1280 px window beside the app's sidebar) the Project group opens over the timeline instead of beside it. */
const OVERLAY_BELOW = 1040;
/** From this width (a 1920 px window) the Project group and the meters take their wide defaults. */
const WIDE_FROM = 1500;

const TOP_TABS: readonly (PanelGroupTab & { id: TopTabId })[] = [
  { id: "source", label: t("來源"), icon: Clapperboard },
  { id: "controls", label: t("效果控制"), icon: SlidersHorizontal },
  { id: "mixer", label: t("音訊"), icon: AudioLines },
];

const DOCKS: Record<DockId, { label: string; icon: LucideIcon; width: number }> = {
  color: { label: t("調色"), icon: Palette, width: 380 },
  effects: { label: t("效果"), icon: Sparkles, width: 380 },
  mixer: { label: t("混音器"), icon: AudioLines, width: 420 },
  text: { label: t("文字"), icon: Type, width: 380 },
};

const dockLabel = (dock: DockId) => t("{name}面板", { name: DOCKS[dock].label });

/** Marks the frame of a panel group for the key map and gives it the focus on a click or when focus moves inside. */
function panelFrame(id: EditorPanelId, setPanel: (id: EditorPanelId) => void) {
  return { "data-editor-panel": id, onPointerDownCapture: () => setPanel(id), onFocusCapture: () => setPanel(id) } as const;
}

export function EditWorkspace() {
  const editor = useEditor();
  const { focus, ui } = editor;
  const body = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(body);
  const [layout, setLayout] = useEditLayout(editor.project.project_id);
  const [state, setState] = useLayoutState(layout);
  const wide = width >= WIDE_FROM;
  const overlay = width > 0 && width < OVERLAY_BELOW;
  const [topRatio, setTopRatio] = usePersistentSize("studio.nle.top", 0.52, 0.3, 0.72, 3);
  const [sourceRatio, setSourceRatio] = usePersistentSize("studio.nle.source", 0.5, 0.25, 0.7, 3);
  const [projectWide, setProjectWide] = usePersistentSize("studio.nle.project.wide", 420, 280, 640);
  const [projectNarrow, setProjectNarrow] = usePersistentSize("studio.nle.project.narrow", 300, 260, 480);
  const [dockWidth, setDockWidth] = usePersistentSize(`studio.nle.dock.${layout.dock ?? "none"}`, layout.dock ? DOCKS[layout.dock].width : 380, 320, 560);

  const dock = layout.dock;
  // The dock of the layout that is being opened slides in from its edge
  const chooseLayout = (id: EditLayoutId) => {
    const next = EDIT_LAYOUTS.find((item) => item.id === id)?.dock;
    if (next) notePanelToggle(dockLabel(next), { refocus: false });
    setLayout(id);
  };
  // A panel that is docked on the right is not repeated as a tab
  const topTabs = TOP_TABS.filter((tab) => !(dock === "mixer" && tab.id === "mixer"));
  // No counts on these tabs: a count that appears mid-edit (the first marker, the first undo step) would make a strip
  // that just fits drop its icons
  const bottomTabs: (PanelGroupTab & { id: BottomTabId })[] = [
    { id: "project", label: t("專案", undefined, { context: "panel" }), icon: FolderOpen },
    ...(dock === "effects" ? [] : [{ id: "effects" as const, label: t("效果"), icon: Sparkles }]),
    { id: "markers", label: t("標記"), icon: Flag },
    { id: "captions", label: t("字幕"), icon: Captions },
    { id: "history", label: t("歷程"), icon: History },
  ];
  const topTab = topTabs.find((tab) => tab.id === state.topTab)?.id ?? "controls";
  const bottomTab = bottomTabs.find((tab) => tab.id === state.bottomTab)?.id ?? "project";

  // Selecting a clip may open its detail panel when that is collapsed, but never changes a tab or the layout
  const selectedId = editor.selected[0] ?? editor.selectedTransition;
  const known = useRef(selectedId);
  const reveal = useEffectEvent(() => {
    if (dock && !state.dockOpen) setState({ dockOpen: true });
    else if (!dock && !state.topOpen) setState({ topOpen: true });
  });
  useEffect(() => {
    if (selectedId && selectedId !== known.current) reveal();
    known.current = selectedId;
  }, [selectedId]);
  // A command (match frame, reveal in project, rename, speed) brings its panel forward
  const intent = ui.intent;
  const follow = useEffectEvent(() => {
    if (!intent) return;
    if (intent.panel === "project") setState({ bottomTab: "project", bottomOpen: true });
    else setState({ topTab: intent.panel, topOpen: true });
  });
  useEffect(() => {
    if (intent) follow();
  }, [intent]);

  // The rows always fit the window: the monitors take their share of the height, but not the part the timeline row
  // keeps; in a window too short for both minimums the monitors keep theirs and every panel scrolls inside itself
  const available = Math.max(0, height - GAP);
  const topMax = Math.max(TOP_MIN, available - BOTTOM_MIN);
  const topHeight = Math.round(Math.min(topMax, Math.max(TOP_MIN, available * topRatio)));
  const dockSize = dock ? (state.dockOpen ? Math.min(dockWidth, Math.max(320, width * 0.3)) : RAIL) : 0;
  const monitorsWidth = Math.max(0, width - (dock ? dockSize + GAP : 0) - GAP);
  const sourceWidth = state.topOpen ? Math.round(Math.max(280, Math.min(monitorsWidth - 320, monitorsWidth * sourceRatio))) : RAIL;
  const projectWidth = wide ? projectWide : projectNarrow;
  const setProjectWidth = wide ? setProjectWide : setProjectNarrow;
  const projectMax = Math.max(260, Math.min(wide ? 640 : 480, width - 520));
  const projectSize = state.bottomOpen && !overlay ? Math.min(projectWidth, projectMax) : RAIL;

  const topPanels: Record<TopTabId, ReactNode> = { source: <SourceMonitor />, controls: <EffectControls />, mixer: <AudioMixer /> };
  const bottomPanels: Record<BottomTabId, ReactNode> = { project: <ProjectPanel />, effects: <EffectsBrowser />, markers: <MarkersPanel />, captions: <CaptionsPanel />, history: <HistoryPanel /> };
  const dockPanels: Record<DockId, ReactNode> = { color: <ColorDock />, effects: <EffectsBrowser />, mixer: <AudioMixer />, text: <TextDock /> };
  const dockSpec = dock ? DOCKS[dock] : null;

  const projectGroup = (
    <PanelGroup
      idPrefix="studio-edit-bottom"
      label={t("專案面板")}
      side="left"
      tabs={bottomTabs}
      value={bottomTab}
      onChange={(id) => setState({ bottomTab: bottomTabs.find((tab) => tab.id === id)?.id ?? "project" })}
      collapsed={!state.bottomOpen}
      onCollapsedChange={(collapsed) => setState({ bottomOpen: !collapsed })}
      focused={focus.panel === "project"}
      frameProps={panelFrame("project", focus.setPanel)}
      className={overlay && state.bottomOpen ? "absolute inset-y-0 left-0 z-40 w-[min(26rem,80%)] shadow-popover" : "h-full"}
    >
      {bottomPanels[bottomTab]}
    </PanelGroup>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-1.5">
      <EditHeader layout={layout} onLayout={chooseLayout} />
      <MigrationNotice />
      <div ref={body} className="grid min-h-0 flex-1" style={{ gridTemplateRows: `${topHeight}px ${GAP}px minmax(0,1fr)` }}>
        <div className="grid min-h-0" style={{ gridTemplateRows: "minmax(0,1fr)", gridTemplateColumns: `${sourceWidth}px ${GAP}px minmax(0,1fr)${dock ? ` ${GAP}px ${dockSize}px` : ""}` }}>
          <PanelGroup
            idPrefix="studio-edit-top"
            label={t("來源面板")}
            side="left"
            tabs={topTabs}
            value={topTab}
            onChange={(id) => setState({ topTab: topTabs.find((tab) => tab.id === id)?.id ?? "controls" })}
            collapsed={!state.topOpen}
            onCollapsedChange={(collapsed) => setState({ topOpen: !collapsed })}
            focused={focus.panel === (topTab === "source" ? "source" : "controls")}
            frameProps={panelFrame(topTab === "source" ? "source" : "controls", focus.setPanel)}
          >
            {topPanels[topTab]}
          </PanelGroup>
          {state.topOpen ? (
            <Splitter
              grip="always"
              orientation="vertical"
              value={sourceWidth}
              min={280}
              max={Math.max(280, monitorsWidth - 320)}
              defaultValue={Math.round(monitorsWidth / 2)}
              onChange={(next) => setSourceRatio(next / Math.max(1, monitorsWidth))}
              label={t("調整來源與節目監看器的寬度")}
            />
          ) : (
            <div aria-hidden />
          )}
          <ProgramMonitor />
          {dock && dockSpec ? (
            <>
              {state.dockOpen ? (
                <Splitter grip="always" orientation="vertical" invert value={dockSize} min={320} max={560} defaultValue={dockSpec.width} onChange={setDockWidth} label={t("調整右側面板寬度")} />
              ) : (
                <div aria-hidden />
              )}
              <PanelGroup
                idPrefix="studio-edit-dock"
                label={dockLabel(dock)}
                side="right"
                tabs={[{ id: dock, label: dockSpec.label, icon: dockSpec.icon }]}
                value={dock}
                onChange={() => undefined}
                collapsed={!state.dockOpen}
                onCollapsedChange={(collapsed) => setState({ dockOpen: !collapsed })}
                focused={focus.panel === "dock"}
                frameProps={panelFrame("dock", focus.setPanel)}
              >
                {dockPanels[dock]}
              </PanelGroup>
            </>
          ) : null}
        </div>
        <Splitter
          grip="always"
          orientation="horizontal"
          value={topHeight}
          min={TOP_MIN}
          max={topMax}
          defaultValue={Math.round(Math.min(topMax, available * 0.52))}
          onChange={(next) => setTopRatio(next / Math.max(1, available))}
          label={t("調整監看器與時間軸的高度")}
        />
        <div
          className="relative grid min-h-0"
          style={{ gridTemplateRows: "minmax(0,1fr)", gridTemplateColumns: `${projectSize}px ${GAP}px ${TOOLS}px ${GAP}px minmax(0,1fr) ${GAP}px ${wide || layout.id === "audio" ? 56 : 44}px` }}
        >
          {overlay && state.bottomOpen ? <div aria-hidden /> : null}
          {projectGroup}
          {state.bottomOpen && !overlay ? (
            <Splitter grip="always" orientation="vertical" value={projectSize} min={wide ? 280 : 260} max={projectMax} defaultValue={wide ? 420 : 300} onChange={setProjectWidth} label={t("調整專案面板寬度")} />
          ) : (
            <div aria-hidden />
          )}
          <ToolsStrip />
          <div aria-hidden />
          <TimelinePanel density="full" />
          <div aria-hidden />
          <AudioMeters />
        </div>
      </div>
    </div>
  );
}
