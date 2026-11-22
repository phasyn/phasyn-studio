// The range dialog of the timeline (and of the Shot monitor's fix menu): replace a range of a track with a candidate,
// or make a new one there. The range starts from what the owner already selected (In/Out, the selected clip, the shot's
// clip; retake/rangeDefaults.ts) and is shown as timecode; the frame fields only adjust it. One dialog level with tabs:
// 新畫面 (describe and generate the retake, or the gap), 遮罩 (mark the object on the picture, when the route takes a
// mask) and 候選與套用 (this shot's takes and results as cards, preview, seam check, apply). A finished retake comes
// back here, selected, on the same shot.
import { useCallback, useId, useRef, useState } from "react";
import { Scissors } from "lucide-react";
import type { TimelineCommandRangeCandidate } from "@/api/generated/contracts";
import { useRun, useRunList } from "@/api/runs";
import { mediaUrl } from "@/api/http";
import { AssetAudio } from "@/components/common/AssetMedia";
import { Disclosure } from "@/components/common/Disclosure";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TOOL_BUTTON } from "@/components/ui/look";
import { Tabs } from "@/components/ui/tabs";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { usePlayheadFrame } from "../../hooks/playhead";
import { formatTimecode } from "../../model/frames";
import { otherCandidates, shotRuns, shotTakes, type Candidate } from "../../retake/candidates";
import { CandidatePicker } from "../../retake/CandidatePicker";
import { clipShot, defaultRange, defaultTrack, takeShot, type EditRange, type RangeMode, type RangeOrigin } from "../../retake/rangeDefaults";
import { RetakeMonitor } from "../../retake/RetakeMonitor";
import { useStudio } from "../../studioContext";
import type { Editor } from "../editorContext";
import { clipEnd } from "../model";
import { GapGeneration } from "./GapGeneration";
import { RetakeGeneration } from "./RetakeGeneration";
import { SeamPreview } from "./SeamPreview";

type Tab = "generate" | "mask" | "candidates";

/** A range given by the caller (track, start, exclusive end in sequence frames). */
export interface InitialRange { track: string; start: number; end: number }

function originText(origin: RangeOrigin): string {
  switch (origin) {
    case "marks": return t("依入點／出點");
    case "selection": return t("依選取的片段");
    case "shot": return t("依這個鏡頭的片段");
    case "playhead": return t("依播放頭所在的片段");
    case "gap": return t("播放頭所在的空檔");
    case "given": return t("依指定範圍");
  }
}

function FrameField({ label, value, fps, min, onChange }: { label: string; value: number; fps: number; min: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1 text-caption text-fg-tertiary">
      <span className="flex items-baseline justify-between gap-2">{label}<span className="machine text-fg-secondary">{Number.isFinite(value) ? formatTimecode(value, fps) : "--"}</span></span>
      <Input compact type="number" min={min} step={1} value={Number.isFinite(value) ? value : ""} onChange={(e) => { onChange(e.target.valueAsNumber); }} />
    </label>
  );
}

function CandidatePreview({ item, fps }: { item: Candidate; fps: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = mediaUrl(item.file.node_id, item.file.file_id);
  if (item.media === "video") return <RetakeMonitor key={item.key} src={url} fps={fps} label={t("候選預覽")} videoRef={videoRef} height="min(30vh, 15rem)" />;
  if (item.media === "audio") return <AssetAudio className="w-full" controls src={url} aria-label={t("候選預覽")} />;
  return <div className="grid h-[min(30vh,15rem)] place-items-center overflow-hidden rounded-lg bg-stage"><img className="max-h-full max-w-full object-contain animate-fade-in" src={url} alt={item.title} /></div>;
}

interface FormProps {
  editor: Editor;
  close: () => void;
  videoRetake: boolean;
  initialRange: InitialRange | undefined;
  shotHint: string | null;
  initialTab: Tab | undefined;
}

function CandidateForm({ editor, close, videoRetake, initialRange, shotHint, initialTab }: FormProps) {
  const { project, runTimelineCommands } = useStudio();
  const frame = usePlayheadFrame(editor.playhead);
  const timeline = editor.timeline;
  const fps = timeline.fps.num / timeline.fps.den;
  const tabsId = useId();
  const tracks = videoRetake ? timeline.tracks.filter(row => row.kind === "video") : timeline.tracks;
  const usable = (id: string) => tracks.some(row => row.track_id === id && !row.locked);
  const context = { timeline, selectedClip: editor.selectedClip, shotId: shotHint, playhead: frame };
  const [track, setTrack] = useState(() => initialRange && usable(initialRange.track) ? initialRange.track : defaultTrack(context, editor.videoTarget, usable));
  const [range, setRange] = useState<EditRange>(() => initialRange?.track === track
    ? { start: initialRange.start, end: initialRange.end, mode: "replace_range", origin: "given" } : defaultRange(context, track));
  const [mode, setMode] = useState<RangeMode>(videoRetake ? "replace_range" : range.mode);
  const [offset, setOffset] = useState(0);
  const [retain, setRetain] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [masksAvailable, setMasksAvailable] = useState(false);
  const [returned, setReturned] = useState<string | null>(null);
  const [select, setSelect] = useState<string | null>(null);
  const trackRow = timeline.tracks.find(row => row.track_id === track);
  const overlapping = timeline.clips.filter((clip) => clip.track_id === track && clip.start_frame < range.end && clipEnd(clip) > range.start);
  const shot = shotHint ?? (overlapping.length === 1 ? clipShot(timeline, overlapping[0]) : null) ?? editor.selectedShotId;
  const runs = useRunList(25, "include", shot !== null ? { project_id: project.project_id, shot_id: shot } : { project_id: project.project_id }, "summary");
  const extra = useRun(returned);
  const fits = (item: Candidate) => !videoRetake || item.media === "video";
  const own = [...shotTakes(project, shot), ...shotRuns(project, shot, runs.data?.pages.flatMap((page) => page.items) ?? [])];
  const back = extra.data ? shotRuns(project, null, [extra.data]).filter((item) => !own.some((row) => row.key === item.key)) : [];
  const mine = [...back, ...own].filter(fits);
  const others = otherCandidates(project, shot).filter(fits);
  const all = [...mine, ...others];
  // A retake or gap result that just came back is selected as soon as its card exists.
  if (select !== null) {
    const found = all.find((item) => item.binding.run_id === select);
    if (found) { setChoice(found.key); setSelect(null); }
  }
  const selected = all.find((item) => item.key === choice);
  const generates = mode === "fill_gap" || trackRow?.kind === "video";
  const canRetain = mode === "replace_range" && trackRow?.kind === "video";
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(generates ? [{ id: "generate" as const, label: mode === "fill_gap" ? t("生成空檔") : t("新畫面") }] : []),
    ...(generates && mode === "replace_range" && masksAvailable ? [{ id: "mask" as const, label: t("遮罩") }] : []),
    { id: "candidates", label: t("候選與套用"), count: mine.length },
  ];
  const [tabState, setTabState] = useState<Tab>(initialTab ?? (generates ? "generate" : "candidates"));
  const tab = tabs.some((item) => item.id === tabState) ? tabState : tabs[0]?.id ?? "candidates";
  const valid = range.end > range.start && range.start >= 0 && offset >= 0 && [range.start, range.end, offset].every(Number.isSafeInteger);
  const command: TimelineCommandRangeCandidate | null = selected && (!videoRetake || (canRetain && usable(track))) && valid ? {
    op: "range_candidate", mode, track_id: track, start_frame: range.start, end_frame: range.end, candidate_in_frame: offset,
    expected_source_sha256: selected.file.sha256, ...selected.binding,
    ...(canRetain && retain ? { inherit_static_visuals: true } : {}),
  } : null;
  const onCandidate = useCallback((runId: string) => { setReturned(runId); setSelect(runId); setTabState("candidates"); }, []);

  async function apply() {
    if (!command || busy) return;
    setBusy(true);
    setError("");
    try {
      await runTimelineCommands([command]);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const length = range.end - range.start;
  const applyReason = !selected ? t("請先選一個候選。") : !valid ? t("範圍不正確。") : null;
  return <>
    <DialogHeader>
      <DialogTitle>{videoRetake ? t("局部重製") : t("套用候選片段")}</DialogTitle>
      <DialogDescription>{videoRetake ? t("重新生成選取範圍的畫面，原聲保留。") : t("預覽候選後，只替換所選軌道的影格範圍。")}</DialogDescription>
    </DialogHeader>
    <DialogBody className="grid content-start gap-4">
      <fieldset disabled={busy} className="grid min-w-0 gap-2">
        <legend className="sr-only">{t("範圍")}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid w-36 gap-1 text-caption text-fg-tertiary">{t("目標軌道")}
            <Select compact value={track} onChange={(event) => {
              const id = event.target.value;
              const next = defaultRange(context, id);
              setTrack(id); setRange(next); setMode(videoRetake ? "replace_range" : next.mode);
            }}>{tracks.map((row) => <option key={row.track_id} value={row.track_id} disabled={row.locked}>{row.name}</option>)}</Select>
          </label>
          {!videoRetake && <label className="grid w-36 gap-1 text-caption text-fg-tertiary">{t("套用方式")}
            <Select compact value={mode} onChange={(event) => { setMode(event.target.value === "fill_gap" ? "fill_gap" : "replace_range"); }}>
              <option value="replace_range">{t("替換選區")}</option><option value="fill_gap">{t("填補空檔")}</option>
            </Select>
          </label>}
          <div className="grid min-w-0 flex-1 gap-1">
            <span className="text-caption text-fg-tertiary">{t("範圍")} · {originText(range.origin)}</span>
            <span className="flex min-h-8 flex-wrap items-center gap-x-3 rounded-md border border-line-subtle bg-sunken/60 px-2.5">
              <span className="machine text-data text-brand-cyan">{formatTimecode(range.start, fps)} → {formatTimecode(range.end, fps)}</span>
              <span className="machine text-caption text-fg-secondary">{valid ? t("{seconds} 秒・{frames} 幀", { seconds: formatNumber(length / fps, { maximumFractionDigits: 2 }), frames: length }) : t("範圍不正確")}</span>
            </span>
          </div>
        </div>
        <Disclosure summary={t("調整範圍（影格）")}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <FrameField label={t("開始影格")} value={range.start} fps={fps} min={0} onChange={(start) => { setRange({ ...range, start, origin: "given" }); }} />
            <FrameField label={t("結束影格（不含）")} value={range.end} fps={fps} min={1} onChange={(end) => { setRange({ ...range, end, origin: "given" }); }} />
          </div>
        </Disclosure>
      </fieldset>
      <div className="grid min-w-0 gap-4">
        <Tabs items={tabs} value={tab} onChange={(id) => { if (id === "generate" || id === "mask" || id === "candidates") setTabState(id); }} idPrefix={tabsId} label={t("局部重製步驟")} />
        {generates && <div role="tabpanel" id={`${tabsId}-panel-generate`} aria-labelledby={`${tabsId}-tab-${tab === "mask" ? "mask" : "generate"}`} hidden={tab === "candidates"} className="min-w-0">
          {mode === "fill_gap"
            ? <div hidden={tab !== "generate"}><GapGeneration track={track} start={range.start} end={range.end} onCandidate={onCandidate} /></div>
            : <RetakeGeneration track={track} start={range.start} end={range.end} panel={tab === "candidates" ? "hidden" : tab === "mask" ? "mask" : "prompt"}
              onMasksAvailable={setMasksAvailable} onCandidate={onCandidate} />}
        </div>}
        {tab === "candidates" && <div role="tabpanel" id={`${tabsId}-panel-candidates`} aria-labelledby={`${tabsId}-tab-candidates`} className="grid min-w-0 gap-4 animate-fade-in lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
          <fieldset disabled={busy} className="grid min-w-0 content-start gap-3">
            <legend className="sr-only">{t("候選")}</legend>
            {mine.length > 0
              ? <CandidatePicker items={mine} value={choice} onChange={setChoice} label={t("這個鏡頭的 take 與候選")} />
              : <p className="rounded-lg border border-dashed border-line-subtle p-4 text-center text-data text-fg-tertiary">
                {generates ? t("這個鏡頭還沒有可用的候選。到「新畫面」生成一個，完成後會回到這裡。") : t("這個鏡頭還沒有可用的候選。")}</p>}
            {runs.hasNextPage && <Button size="sm" variant="quiet" onClick={() => { void runs.fetchNextPage(); }} disabled={runs.isFetchingNextPage}>{t("顯示更早的候選")}</Button>}
            {others.length > 0 && <Disclosure summary={t("其他素材")}>
              <Select compact aria-label={t("其他素材")} value={others.some((item) => item.key === choice) ? choice : ""} onChange={(e) => { setChoice(e.target.value); }}>
                <option value="">{t("選擇其他鏡頭的 take 或素材庫項目")}</option>
                {others.map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}
              </Select>
            </Disclosure>}
          </fieldset>
          <fieldset disabled={busy} className="grid min-w-0 content-start gap-3">
            <legend className="sr-only">{t("候選預覽")}</legend>
            {selected ? <>
              <CandidatePreview item={selected} fps={fps} />
              <div className="grid grid-cols-2 gap-2">
                <FrameField label={t("候選入點")} value={offset} fps={fps} min={0} onChange={setOffset} />
              </div>
              {canRetain && <Checkbox label={t("沿用原片段的固定縮放與調色")} checked={retain} onChange={event => { setRetain(event.target.checked); }} />}
              {command && <SeamPreview key={JSON.stringify([project.revision, command])} command={command} />}
            </> : <div className="grid h-[min(30vh,15rem)] place-items-center rounded-lg bg-stage text-data text-fg-tertiary">{t("選一個候選來預覽")}</div>}
          </fieldset>
        </div>}
      </div>
    </DialogBody>
    <DialogFooter>
      {error && <p role="alert" className="mr-auto text-caption text-warning">{error}</p>}
      {!error && applyReason !== null && tab === "candidates" && <p className="mr-auto text-caption text-fg-tertiary">{applyReason}</p>}
      <Button variant="quiet" disabled={busy} onClick={close}>{t("取消")}</Button>
      <Button variant="primary" pending={busy} disabled={!command || !track} title={applyReason ?? undefined} onClick={() => { void apply(); }}>{t("套用候選片段")}</Button>
    </DialogFooter>
  </>;
}

export interface RangeCandidateDialogProps {
  editor: Editor;
  /** A labelled button as the trigger; absent = the timeline toolbar's scissors icon. */
  triggerLabel?: string;
  /** Video tracks only, replace only (the retake). */
  videoRetake?: boolean;
  /** Start from this range instead of the owner's selection. */
  initialRange?: InitialRange;
  /** Opened for this take (the Shot monitor): its shot's clip is the default range and its takes the candidates. */
  takeId?: string;
  /** Opened for this shot. */
  shotId?: string;
  /** The tab to open on (for example 遮罩 from a 「修正遮罩」 command). */
  initialTab?: Tab;
  /** Controlled open state (a menu opens it); uncontrolled when absent. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render no trigger (the caller opens it through `open`). */
  showTrigger?: boolean;
}

export function RangeCandidateDialog({ editor, triggerLabel, videoRetake = false, initialRange, takeId, shotId, initialTab, open: openProp, onOpenChange, showTrigger = true }: RangeCandidateDialogProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const shotHint = shotId ?? takeShot(editor.project, takeId);
  return <Dialog open={open} onOpenChange={setOpen}>
    {showTrigger && <DialogTrigger asChild>{triggerLabel !== undefined ? <Button size="sm" icon={<Scissors aria-hidden />}>{triggerLabel}</Button> : <button type="button" className={TOOL_BUTTON} aria-label={t("套用候選片段")} title={t("套用候選片段")}><Scissors aria-hidden /></button>}</DialogTrigger>}
    {open && <DialogContent wide className="h-[min(88vh,48rem)] max-w-5xl" onKeyDown={(event) => { event.stopPropagation(); }}>
      <CandidateForm editor={editor} videoRetake={videoRetake} initialRange={initialRange} shotHint={shotHint} initialTab={initialTab} close={() => { setOpen(false); }} />
    </DialogContent>}
  </Dialog>;
}
