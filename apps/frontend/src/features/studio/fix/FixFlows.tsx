// Opening the 修正 menu and what its items start, shared by the Shot page (the 修正 button under the monitor) and the
// Edit page (a timeline clip's context menu → 修正…). A pipeline tool opens its compact dialog (FixRunDialog);
// 局部重製 opens the existing range-retake dialog on the shot's clip, 遮罩 the existing mask editor, 草稿精修 the
// batch-draft dialog.
import { ChevronDown } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { StudioShot, StudioTake, TimelineClip } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { MenuAnchor } from "@/components/ui/menuModel";
import { t } from "@/i18n";
import { DraftDialog } from "../drafts/DraftDialog";
import { useEditor, type Editor } from "../editor/editorContext";
import { clipEnd } from "../editor/model";
import { RangeCandidateDialog } from "../editor/timeline/RangeCandidateDialog";
import { RetakeMaskEditor } from "../editor/timeline/RetakeMaskEditor";
import { takeNumber } from "../model/takeDownload";
import { useStudio } from "../studioContext";
import { clearClipFix, useClipFixRequest } from "./fixStore";
import { FixMenu } from "./FixMenu";
import { FixRunDialog, type FixRunTarget } from "./FixRunDialog";
import { FIX_TOOLS, FIX_ICON, type FixTool, type PipelineTool } from "./tools";
import { useFixRuns } from "./useFixRuns";

function finished(take: StudioTake | null): take is StudioTake {
  return take?.state === "succeeded" && take.asset?.complete === true;
}

/** The video clip of the shot a range retake works on: the given clip, or the shot's clip under the playhead (else its first). */
function retakeClip(editor: Editor, shot: StudioShot, clipId: string | null): TimelineClip | null {
  const clips = editor.timeline.clips.filter((clip) => {
    if (clipId !== null) return clip.clip_id === clipId;
    const source = editor.sourceOf(clip);
    return (source?.candidate_origin ?? source)?.shot_id === shot.shot_id && editor.trackOf(clip)?.kind === "video";
  });
  const frame = editor.playhead.getFrame();
  return clips.find((clip) => clip.start_frame <= frame && clipEnd(clip) > frame) ?? clips[0] ?? null;
}

function pipelineFor(tool: PipelineTool, pipelines: readonly WirePipeline[]): WirePipeline | null {
  for (const id of tool.pipelines) {
    const found = pipelines.find((item) => item.pipeline_id === id);
    if (found) return found;
  }
  return null;
}

/** Opens the existing range-retake dialog through its own trigger (kept out of sight), then reports when it closes. */
function RetakeOpener({ onDone }: { onDone: () => void }) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const done = useEffectEvent(onDone);
  useEffect(() => {
    const trigger = ref.current?.querySelector<HTMLButtonElement>("button");
    if (!trigger) {
      done();
      return;
    }
    let opened = false;
    const observer = new MutationObserver(() => {
      const state = trigger.getAttribute("data-state");
      if (state === "open") opened = true;
      else if (opened && state === "closed") done();
    });
    observer.observe(trigger, { attributes: true, attributeFilter: ["data-state"] });
    trigger.click();
    return () => { observer.disconnect(); };
  }, []);
  return (
    <div ref={ref} aria-hidden className="sr-only">
      <RangeCandidateDialog editor={editor} videoRetake triggerLabel={t("局部重製")} />
    </div>
  );
}

/** Stops the React events of the menu and dialogs (portals bubble through the React tree) at their host. */
const stop = (event: SyntheticEvent) => { event.stopPropagation(); };
function Isolate({ children }: { children: ReactNode }) {
  return (
    <span /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Events of the menu and dialogs (portals) bubble through this display-contents wrapper; they must not reach the timeline clip's gestures. */ className="contents" onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onKeyDown={stop} onContextMenu={stop} onDragStart={stop} onDragOver={stop} onDrop={stop}>
      {children}
    </span>
  );
}

export interface FixFlowsProps {
  shot: StudioShot | null;
  take: StudioTake | null;
  /** The timeline clip the menu was opened on (Edit page); null on the Shot page. */
  clipId: string | null;
  /** The open menu's anchor; null = closed. */
  anchor: MenuAnchor | null;
  returnFocus: HTMLElement | null;
  onMenuClose: () => void;
  /** Nothing is open any more (no menu, dialog or retake): a host may unmount the flows. */
  onIdle?: () => void;
}

export function FixFlows({ shot, take, clipId, anchor, returnFocus, onMenuClose, onIdle }: FixFlowsProps) {
  const editor = useEditor();
  const { project, notify } = useStudio();
  const pipelines = usePipelines();
  const fixRuns = useFixRuns(project.project_id);
  const [target, setTarget] = useState<FixRunTarget | null>(null);
  const [mask, setMask] = useState<StudioTake | null>(null);
  const [drafts, setDrafts] = useState(false);
  const [retake, setRetake] = useState(false);

  const idle = anchor === null && target === null && mask === null && !drafts && !retake;
  const reportIdle = useEffectEvent(() => { onIdle?.(); });
  useEffect(() => { if (idle) reportIdle(); }, [idle]);

  const items = pipelines.data?.items ?? [];
  const ready = finished(take);
  const clip = shot ? retakeClip(editor, shot, clipId) : null;
  const clipSource = clip ? editor.sourceOf(clip) : undefined;
  const clipTake = (clipSource?.candidate_origin ?? clipSource)?.take_id ?? null;
  const pairs = shot?.takes.filter((item) => item.take_id !== take?.take_id && finished(item)) ?? [];
  const reasons: Record<string, string | null> = {};
  const pipelineIds: Record<string, string | undefined> = {};
  for (const tool of FIX_TOOLS) {
    if (tool.kind === "flow") {
      reasons[tool.id] = tool.flow === "drafts" ? null
        : !shot ? t("這個片段不屬於任何鏡頭")
        : !ready ? t("這個 take 還沒有完整的影片")
        : tool.flow === "mask" ? null
        : !clip ? t("這個鏡頭還沒放到時間軸")
        : editor.trackOf(clip)?.locked === true ? t("軌道已鎖定；請先解鎖再編輯")
        : clipTake !== null && clipTake !== take.take_id ? t("局部重製作用在時間軸上的 take；請先把 take {number} 設為使用中", { number: takeNumber(shot, take) })
        : null;
      continue;
    }
    const pipeline = pipelineFor(tool, items);
    pipelineIds[tool.id] = pipeline?.pipeline_id ?? tool.pipelines[0];
    const running = take ? fixRuns.runs.some((entry) => entry.tool.id === tool.id && entry.note.take_id === take.take_id && entry.run.state === "running") : false;
    reasons[tool.id] = pipelines.isPending ? t("正在讀取流程…")
      : !pipeline ? t("這台 Studio 還沒有這個流程")
      : !shot ? t("這個片段不屬於任何鏡頭")
      : !ready ? t("這個 take 還沒有完整的影片")
      : tool.pairInput !== undefined && pairs.length === 0 ? t("這個鏡頭沒有其他完成的 take")
      : running ? t("這個 take 正在執行這項修正")
      : null;
  }

  const pick = (tool: FixTool) => {
    if (tool.kind === "flow" && tool.flow === "drafts") {
      setDrafts(true);
      return;
    }
    if (!shot || !finished(take)) return;
    if (tool.kind === "pipeline") {
      const pipeline = pipelineFor(tool, items);
      if (pipeline) setTarget({ tool, pipeline, source: { kind: "take", shot, take } });
      return;
    }
    switch (tool.flow) {
      case "mask":
        setMask(take);
        return;
      case "retake": {
        if (!clip) return;
        editor.select(clip.clip_id);
        const frame = editor.playhead.getFrame();
        if (frame < clip.start_frame || frame >= clipEnd(clip)) editor.transport.seek(clip.start_frame);
        setRetake(true);
        return;
      }
      case "drafts":
        setDrafts(true);
    }
  };

  return (
    <Isolate>
      {anchor ? (
        <FixMenu
          label={shot && take ? t("修正 take {number}", { number: takeNumber(shot, take) }) : t("修正")}
          anchor={anchor}
          reasons={reasons}
          pipelineIds={pipelineIds}
          returnFocus={returnFocus}
          onPick={pick}
          onClose={onMenuClose}
        />
      ) : null}
      <FixRunDialog target={target} onClose={() => { setTarget(null); }} />
      <Dialog open={mask !== null} onOpenChange={(open) => { if (!open) setMask(null); }}>
        <DialogContent wide onKeyDown={stop}>
          <DialogHeader>
            <DialogTitle>{t("遮罩")}</DialogTitle>
            <DialogDescription>{t("在畫面上點選要保留或排除的人物、物件，產生逐幀遮罩；採用後加入素材庫，可在局部重製中使用。")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {mask?.asset ? <RetakeMaskEditor key={mask.take_id} source={mask.asset.file} onAdopt={() => {
              notify({ tone: "success", title: t("遮罩已加入素材庫"), detail: t("在局部重製中選這個遮罩即可使用。") });
              setMask(null);
            }} /> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
      <DraftDialog open={drafts} setOpen={setDrafts} />
      {retake ? <RetakeOpener onDone={() => {
        setRetake(false);
        if (returnFocus?.isConnected === true) returnFocus.focus({ preventScroll: true });
      }} /> : null}
    </Isolate>
  );
}

/** The 修正 button of the Shot page's take action bar. */
export function FixButton({ shot, take }: { shot: StudioShot; take: StudioTake | null }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<FIX_ICON aria-hidden />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={t("修正這個 take：局部重製、遮罩、畫質修復、補幀、超分…")}
        onClick={(event) => { setAnchor(anchor ? null : event.currentTarget); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        {t("修正")}
        <ChevronDown aria-hidden className={anchor ? "rotate-180 transition-[rotate]" : "transition-[rotate]"} />
      </Button>
      <FixFlows shot={shot} take={take} clipId={null} anchor={anchor ? { kind: "element", element: anchor } : null} returnFocus={anchor} onMenuClose={() => { setAnchor(null); }} />
    </>
  );
}

/**
 * A timeline clip's 修正 host: when the clip's context menu asks for the menu (fixStore), it shows the menu next to the
 * clip and keeps the flows mounted until the dialog they opened is closed.
 */
export function ClipFixHost({ clipId }: { clipId: string }) {
  const request = useClipFixRequest(clipId);
  const [active, setActive] = useState(false);
  if (request && !active) setActive(true);
  return active ? <ClipFix clipId={clipId} open={request !== null} onIdle={() => { clearClipFix(clipId); setActive(false); }} /> : null;
}

function ClipFix({ clipId, open, onIdle }: { clipId: string; open: boolean; onIdle: () => void }) {
  const editor = useEditor();
  const clip = editor.timeline.clips.find((item) => item.clip_id === clipId);
  const source = clip ? editor.sourceOf(clip) : undefined;
  const origin = source?.candidate_origin ?? source;
  const shot = editor.project.shots.find((item) => item.shot_id === origin?.shot_id) ?? null;
  const take = shot?.takes.find((item) => item.take_id === origin?.take_id) ?? null;
  const [element] = useState(() => document.querySelector<HTMLElement>(`[data-editor-clip="${CSS.escape(clipId)}"]`));
  return (
    <FixFlows
      shot={shot}
      take={take}
      clipId={clipId}
      anchor={open && element ? { kind: "element", element } : null}
      returnFocus={element}
      onMenuClose={() => { clearClipFix(clipId); }}
      onIdle={onIdle}
    />
  );
}
