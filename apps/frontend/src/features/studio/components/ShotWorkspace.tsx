import { ChevronDown, ChevronUp, SquarePen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { playMotion } from "@/components/ui/motion";
import { TOOL_BUTTON } from "@/components/ui/look";
import { Splitter } from "@/components/workbench/Splitter";
import { CollapsedRail } from "@/features/studio-shell";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useElementSize } from "@/lib/useElementSize";
import { usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { useEditor } from "../editor/editorContext";
import { TimelinePanel } from "../editor/timeline/TimelinePanel";
import { Bin } from "./Bin";
import { Inspector } from "./Inspector";
import { useInspectorReveal } from "./inspector/inspectorTab";
import { Monitor } from "./Monitor";

const BIN_DEFAULT = 280;
const INSPECTOR_DEFAULT = 420;
/** Compact timeline: header, ruler, four low tracks and the zoom bar. */
const TIMELINE_DEFAULT = 252;
const TIMELINE_MIN = 132;
/** Upper bound of the remembered height (the real one follows the workspace: a shorter window shows a clamped value). */
const TIMELINE_STORED_MAX = 4000;

/** The timeline takes at most 70% of the workspace and leaves at least 200 px for the panels above it. */
function timelineMaxHeight(workspaceHeight: number): number {
  return Math.max(TIMELINE_MIN, Math.min(Math.round(workspaceHeight * 0.7), workspaceHeight - 200));
}

/** The compact timeline's own actions: continue in the Edit workspace (same timeline, playhead and selection), and collapse. */
function TimelineActions({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { project, selectedShotId } = useEditor();
  const navigate = useNavigate();
  const shot = selectedShotId ? `&shot=${encodeURIComponent(selectedShotId)}` : "";
  return (
    <>
      <Button size="sm" variant="secondary" icon={<SquarePen aria-hidden />} onClick={() => void navigate(`/studio/edit?project=${encodeURIComponent(project.project_id)}${shot}`)}>
        {t("在編輯中開啟")}
      </Button>
      <button type="button" className={cn(TOOL_BUTTON, "text-fg-tertiary")} aria-expanded={open} aria-label={open ? t("收合時間軸") : t("展開時間軸")} title={open ? t("收合時間軸") : t("展開時間軸")} onClick={onToggle}>
        {open ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
      </button>
    </>
  );
}

/**
 * The Shots workspace: project | monitor | properties, with the timeline below in compact density (the same timeline
 * as in Edit: selecting, playing and rearranging only). Splitters drag, reset on double-click and move with the arrow
 * keys; all three panels collapse (the side panels into rails, the timeline to its header). Sizes and collapsed state
 * are remembered in this browser. The side panels slide in when they mount (usePanelEnter); the timeline stays mounted,
 * so collapsing or expanding it springs its row between the two heights instead (the monitor grows or gives way with it).
 */
export function ShotWorkspace() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { height: workspaceHeight } = useElementSize(rootRef);
  const [bin, setBin] = usePersistentSize("studio.bin", BIN_DEFAULT, 220, 440);
  const [inspector, setInspector] = usePersistentSize("studio.inspector", INSPECTOR_DEFAULT, 300, 520);
  const [storedTimeline, setTimeline] = usePersistentSize("studio.timeline.compact", TIMELINE_DEFAULT, TIMELINE_MIN, TIMELINE_STORED_MAX);
  const [binOpen, setBinOpen] = usePersistentFlag("studio.bin.open", true);
  const [inspectorOpen, setInspectorOpen] = usePersistentFlag("studio.inspector.open", true);
  // Something outside the inspector asked to see one of its tabs (the action next to a blocked 渲染鏡頭): open it
  const reveal = useInspectorReveal();
  useEffect(() => {
    if (reveal > 0) setInspectorOpen(true);
  }, [reveal, setInspectorOpen]);
  const [timelineOpen, setTimelineOpen] = usePersistentFlag("studio.timeline.open", true);
  const timelineMax = timelineMaxHeight(workspaceHeight);
  const timeline = Math.min(storedTimeline, timelineMax);
  // The timeline row's height when its toggle was pressed: the layout effect below springs from it to the new height
  const toggledFrom = useRef<number | null>(null);
  const toggleTimeline = () => {
    toggledFrom.current = rootRef.current?.lastElementChild?.getBoundingClientRect().height ?? null;
    setTimelineOpen(!timelineOpen);
  };
  useLayoutEffect(() => {
    const from = toggledFrom.current;
    toggledFrom.current = null;
    const root = rootRef.current;
    const to = root?.lastElementChild?.getBoundingClientRect().height;
    if (from === null || !root || to === undefined || Math.abs(to - from) < 1) return;
    playMotion(root, [{ gridTemplateRows: `minmax(0,1fr) auto ${from}px` }, { gridTemplateRows: `minmax(0,1fr) auto ${to}px` }], { duration: "spring-smooth", easing: "spring-smooth" });
  }, [timelineOpen]);
  return (
    <div ref={rootRef} className="grid min-h-0 flex-1 px-1.5 pb-1.5" style={{ gridTemplateRows: `minmax(0,1fr) auto ${timelineOpen ? `${timeline}px` : "auto"}` }}>
      <div
        className="grid min-h-0"
        style={{ gridTemplateColumns: `${binOpen ? `${bin}px` : "2.5rem"} auto minmax(0,1fr) auto ${inspectorOpen ? `${inspector}px` : "2.5rem"}` }}
      >
        {binOpen ? <Bin onCollapse={() => setBinOpen(false)} /> : <CollapsedRail side="left" label={t("專案面板")} onExpand={() => setBinOpen(true)} />}
        {binOpen ? (
          <Splitter grip="always" orientation="vertical" value={bin} min={220} max={440} defaultValue={BIN_DEFAULT} onChange={setBin} label={t("調整專案面板寬度")} />
        ) : (
          <div aria-hidden className="w-1.5" />
        )}
        <Monitor />
        {inspectorOpen ? (
          <Splitter grip="always" orientation="vertical" value={inspector} min={300} max={520} defaultValue={INSPECTOR_DEFAULT} onChange={setInspector} label={t("調整屬性面板寬度")} invert />
        ) : (
          <div aria-hidden className="w-1.5" />
        )}
        {inspectorOpen ? (
          <Inspector onCollapse={() => setInspectorOpen(false)} />
        ) : (
          <CollapsedRail side="right" label={t("屬性面板")} onExpand={() => setInspectorOpen(true)} />
        )}
      </div>
      {timelineOpen ? (
        <Splitter
          grip="always"
          orientation="horizontal"
          value={timeline}
          min={TIMELINE_MIN}
          max={timelineMax}
          defaultValue={TIMELINE_DEFAULT}
          onChange={(next) => setTimeline(Math.min(next, timelineMax))}
          label={t("調整時間軸高度")}
          invert
        />
      ) : (
        <div aria-hidden className="h-1.5" />
      )}
      <TimelinePanel density="compact" collapsed={!timelineOpen} actions={<TimelineActions open={timelineOpen} onToggle={toggleTimeline} />} />
    </div>
  );
}
