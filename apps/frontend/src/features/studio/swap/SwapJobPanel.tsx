// 換角工作畫面（換角專案的「一鍵換角」對話框）：整體進度、段尾凍結（「改用段尾凍結…」在 HoldTailDialog）、進行中的
// 批次 run（DiT 逐步進度、取消前說明範圍）、每一段的狀態與手動重新渲染（段落表與「比對原片」在 SegmentTable）、匯出與
// 結果（原音軌模式要確認 concat 真的用了原音軌）。
// 全部由專案推導，重新整理後一樣。
// 外觀（Phasyn）：階段是狀態色的標記（不用品牌漸層表示成功）；進行中的批次 run 卡片以品牌細邊標示；段落表維持俐落、不發光。
import { Ban, CircleAlert, CircleCheck, CircleDashed, CircleX, Clapperboard, Cpu, Download, ExternalLink, LoaderCircle, Plus, RotateCcw, Rows3, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { mediaUrl } from "@/api/http";
import { useCachedRun } from "@/api/runs";
import { ActionButton } from "@/components/common/ActionButton";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { IdText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { elapsedMs, formatElapsed, useNow } from "@/lib/time";
import { CARD } from "@/components/ui/look";
import { RunQueueProgress } from "../components/RenderProgress";
import { useRunProgress } from "../hooks/useRunProgress";
import { formatDuration } from "../model/frames";
import { catalogLookup } from "../model/progress";
import { findRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { BATCH_SIZES, batchSizeLabel, type BatchSize } from "./batchSize";
import { Fact, Facts, NoteList, Section } from "./fields";
import { HoldTailFact } from "./HoldTailDialog";
import { AUDIO_TRACK_MISSING, originalAudioApplied, unfinishedSegments, type SwapPhase, type SwapProgress, type SwapProjectInfo } from "./job";
import { MeasureSection } from "./MeasureSection";
import { SegmentTable } from "./SegmentTable";
import { StaleRenderDialog } from "./StaleRenderDialog";
import { cancelScope, PHASE_LABELS, primaryAction, type SummaryTone } from "./jobView";
import { formatCueTime } from "./prompt";
import type { SwapJobApi } from "./useSwapJob";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";
import { RenderEta } from "../components/RenderEta";

const PHASE_SPEC: Record<SwapPhase, { tone: SummaryTone; icon: LucideIcon; spin?: boolean }> = {
  pending: { tone: "neutral", icon: CircleDashed },
  rendering: { tone: "info", icon: LoaderCircle, spin: true },
  failed: { tone: "warning", icon: TriangleAlert },
  ready_to_export: { tone: "info", icon: Download },
  exporting: { tone: "info", icon: LoaderCircle, spin: true },
  exported: { tone: "success", icon: CircleCheck },
  export_failed: { tone: "danger", icon: CircleX },
};

export interface SwapJobPanelProps {
  info: SwapProjectInfo;
  job: SwapJobApi;
  progress: SwapProgress;
  /** 開始新的換角（切到精靈）。 */
  onNewSwap: () => void;
  /** 前往 Studio 其他畫面前關閉對話框。 */
  onNavigate: () => void;
  /** 關閉對話框並打開渲染引擎側欄（目前鏡頭的元件組合）。 */
  onOpenEngine: () => void;
  /** 由精靈切換過來（按下的按鈕已經不在畫面上）：焦點移到標題。 */
  focusTitle?: boolean;
}

export function SwapJobPanel({ info, job, progress, onNewSwap, onNavigate, onOpenEngine, focusTitle = false }: SwapJobPanelProps) {
  const { project } = useStudio();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);
  const spec = PHASE_SPEC[progress.phase];
  const primary = primaryAction(progress);
  const range = `${formatCueTime(info.job.start_frame, info.job.fps)}–${formatCueTime(info.job.end_frame, info.job.fps)}`;
  const total = progress.segments.length;
  const more = progress.remaining.length - job.batch.length;
  const batchShots = job.batch.flatMap((id) => project.shots.filter((shot) => shot.shot_id === id));
  // 重新渲染設定已改的段落: mounted once per opening (session) and kept while it closes, so its exit animates
  const [staleDialog, setStaleDialog] = useState<{ open: boolean; session: number } | null>(null);
  return (
    <>
      <DialogHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DialogTitle ref={titleRef} tabIndex={-1}>
            {t("一鍵換角")}
          </DialogTitle>
          <Badge tone={spec.tone} className="rounded-full px-2.5">
            <spec.icon aria-hidden className={spec.spin ? "animate-spin" : undefined} />
            {PHASE_LABELS[progress.phase]}
          </Badge>
        </div>
        <DialogDescription>
          <T source={"來源「{name}」<0>{range}</0>・{total} 段（鏡頭中間的接縫 {mid_shot_joins} 個）・{value}。進度存在專案裡，關掉對話框或重新整理都不影響渲染。"} values={{ name: info.source.name, range, total, mid_shot_joins: info.job.mid_shot_joins, value: info.job.audio === "original" ? t("原影片音軌") : t("生成的聲音") }} slots={[<span className="machine" />]} />
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid content-start gap-5">
        <Summary progress={progress} info={info} />
        <RouteNote progress={progress} onOpenEngine={onOpenEngine} />
        {progress.activeRunIds.map((runId) => (
          <ActiveRun key={runId} runId={runId} progress={progress} onNavigate={onNavigate} />
        ))}
        <SegmentTable progress={progress} job={job} projectId={project.project_id} onNavigate={onNavigate} />
        <ExportSection info={info} job={job} progress={progress} onNavigate={onNavigate} />
        <MeasureSection />
      </DialogBody>
      {/* Two rows on the right: the next batch's estimate (it wraps on its own) above the controls, so a long estimate or
          a memory warning never pushes the buttons onto a line of their own */}
      <DialogFooter className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-x-4 gap-y-2">
        <Button variant="quiet" icon={<Plus aria-hidden />} onClick={onNewSwap} className="self-end">
          {t("新的換角…")}
        </Button>
        <div className="grid min-w-0 justify-items-end gap-1.5">
          {/* the next batch's duration estimate, like every other render button (no estimate → why) */}
          {progress.playable < total && batchShots.length > 0 ? <RenderEta shots={batchShots} className="max-w-full justify-items-end text-right" /> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
          {/* 還有段落沒完成就一直顯示（渲染中停用並說明），按下後按鈕不會消失 */}
          {progress.playable < total && progress.remaining.length > 1 ? <BatchSizePicker job={job} /> : null}
          {/* Segments whose prompt, references or settings changed after their take: chosen in a dialog that says what
              changed and that the new take replaces the one in use (the old one stays), then one batch */}
          {job.stale.length > 0 ? (
            <ActionButton
              variant="secondary"
              icon={<RotateCcw aria-hidden />}
              title={job.staleReason ?? undefined}
              onClick={() => setStaleDialog((current) => ({ open: true, session: (current?.session ?? 0) + 1 }))}
            >
              {t("重新渲染設定已改的段落（{staleCount}）…", { staleCount: job.stale.length })}
            </ActionButton>
          ) : null}
          {progress.playable < total ? (
            <ActionButton variant={primary === "render" ? "primary" : "secondary"} icon={<Clapperboard aria-hidden />} disabledReason={job.renderReason} onClick={job.renderRemaining}>
              {job.batch.length === 0 ? t("渲染剩下的段落") : more > 0 ? t("渲染下一批 {batchCount} 段（還剩 {remainingCount} 段）", { batchCount: job.batch.length, remainingCount: progress.remaining.length }) : t("渲染剩下的 {batchCount} 段", { batchCount: job.batch.length })}
            </ActionButton>
          ) : null}
          <ActionButton variant={primary === "export" ? "primary" : "secondary"} icon={<Download aria-hidden />} pending={job.exporting} disabledReason={job.exporting ? null : job.exportReason} onClick={job.exportNow}>
            {progress.latestExport ? t("再匯出一次") : t("匯出")}
          </ActionButton>
          </div>
        </div>
      </DialogFooter>
      {staleDialog ? (
        <StaleRenderDialog
          key={staleDialog.session}
          open={staleDialog.open}
          shotIds={job.stale}
          batchOf={job.staleBatchOf}
          reasonOf={job.batchReason}
          onRender={job.renderStale}
          onClose={() => setStaleDialog((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
    </>
  );
}

/** How many segments the next render sends (per browser): small batches let every segment be checked first. */
function BatchSizePicker({ job }: { job: SwapJobApi }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 text-caption text-fg-tertiary" title={t("每段完成就能比對原片；有偏離先改那一段，再送下一批")}>
      {t("每批")}
      <Select id={id} compact value={job.batchSize === null ? "all" : String(job.batchSize)} onChange={(event) => job.setBatchSize(event.target.value === "all" ? null : (Number(event.target.value) as BatchSize))} className="w-auto">
        {BATCH_SIZES.map((size) => (
          <option key={size ?? "all"} value={size === null ? "all" : String(size)}>
            {batchSizeLabel(size)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function Summary({ progress, info }: { progress: SwapProgress; info: SwapProjectInfo }) {
  const { counts } = progress;
  const unfinished = unfinishedSegments(counts);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2" role="status">
        <Badge tone="success">
          <CircleCheck aria-hidden />
          {t("完成 {playable}／{segmentsCount}", { playable: progress.playable, segmentsCount: progress.segments.length })}
        </Badge>
        {counts.rendering > 0 ? (
          <Badge tone="info">
            <LoaderCircle aria-hidden className="animate-spin" />
            {t("渲染中 {rendering}", { rendering: counts.rendering })}
          </Badge>
        ) : null}
        {unfinished > 0 ? (
          <Badge tone="warning">
            <TriangleAlert aria-hidden />
            {t("沒有完成 {unfinished}", { unfinished })}
          </Badge>
        ) : null}
        {counts.pending > 0 ? (
          <Badge tone="neutral">
            <CircleDashed aria-hidden />
            {t("未渲染 {pending}", { pending: counts.pending })}
          </Badge>
        ) : null}
        {counts.stale > 0 ? (
          <Badge tone="warning" title={t("這些段落的設定在渲染後改過；匯出仍用目前的 take")}>
            <TriangleAlert aria-hidden />
            {t("設定已改 {stale}", { stale: counts.stale })}
          </Badge>
        ) : null}
      </div>
      <Facts className="text-caption">
        <Fact label={t("分段")}>
          {t("每段最多 {max_frames} 影格（{max_frames2}）・鏡頭中間的接縫交叉溶接 {crossfade_frames} 影格", { max_frames: info.job.max_frames, max_frames2: formatDuration(info.job.max_frames, info.job.fps), crossfade_frames: info.job.crossfade_frames })}
        </Fact>
        <Fact label={t("自動匯出")}>{info.job.auto_export ? t("全部段落完成後自動匯出一次") : t("已嘗試過或沒有開啟：之後按「匯出」")}</Fact>
        <HoldTailFact progress={progress} info={info} />
      </Facts>
      {unfinished > 0 && counts.rendering === 0 ? (
        <p className="text-caption text-fg-tertiary">{t("沒有完成的段落不會自動重試：確認原因後按「渲染剩下的段落」或單段的「渲染」。")}</p>
      ) : null}
    </div>
  );
}

/** 剩下的段落用的元件組合未就緒時說明，並可打開渲染引擎啟動元件。 */
function RouteNote({ progress, onOpenEngine }: { progress: SwapProgress; onOpenEngine: () => void }) {
  const { engine } = useStudio();
  if (engine.status !== "ready" || progress.counts.rendering > 0) return null;
  const pending = progress.segments.filter((segment) => progress.remaining.includes(segment.shot.shot_id));
  const route = pending.map((segment) => findRoute(engine.routes, segment.shot.route)).find((item) => item !== null && !item.ready);
  if (!route) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {t("元件組合「{label}」未就緒：{summary}。啟動需要的元件後再渲染。", { label: route.label, summary: route.summary })}
      </span>
      <Button size="sm" variant="secondary" icon={<Cpu aria-hidden />} onClick={onOpenEngine}>
        {t("開啟渲染引擎")}
      </Button>
    </div>
  );
}

/** 進行中的批次 run：DiT 逐步進度（render tracker 已在輪詢 run，這裡只讀快取）、取消（先說明範圍再確認）。 */
function ActiveRun({ runId, progress, onNavigate }: { runId: string; progress: SwapProgress; onNavigate: () => void }) {
  const { project, catalog } = useStudio();
  const lookup = useMemo(() => catalogLookup(catalog), [catalog]);
  const run = useCachedRun(runId).data;
  const runProgress = useRunProgress(run, { poll: true, lookup });
  const running = run?.state === "running";
  const now = useNow(running);
  const elapsed = run ? elapsedMs(run.created_at, run.finished_at, running ? now : null) : null;
  const [confirming, setConfirming] = useState(false);
  const scope = cancelScope(progress, runId);
  return (
    <Section
      title={t("批次渲染")}
      icon={<Rows3 />}
      actions={
        <>
          <Link
            to={`/studio/render?project=${encodeURIComponent(project.project_id)}&run=${encodeURIComponent(runId)}`}
            onClick={onNavigate}
            className="pressable inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-caption hover:bg-raised"
          >
            <ExternalLink aria-hidden className="size-3.5" />
            {t("渲染詳情")}
          </Link>
          <Button size="sm" variant="danger" icon={<Ban aria-hidden />} disabled={!run || !running} onClick={() => setConfirming(true)}>
            {t("取消渲染…")}
          </Button>
        </>
      }
    >
      <div className={cn(CARD, "grid gap-2 p-3 transition-[border-color] duration-(--duration-base) ease-standard", running && "border-brand-blue/45")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-tertiary">
          <IdText value={runId} length={8} />
          <span>
            <T source={"已執行 <0>{elapsed}</0>"} values={{ elapsed: formatElapsed(elapsed) }} slots={[<span className="machine text-fg-secondary" />]} />
          </span>
          <span>{t("這個 run 有 {inRun} 段還在進行（同一張卡依序執行）", { inRun: scope.inRun })}</span>
        </div>
        {run ? <RunQueueProgress run={run} views={runProgress.views} noun={t("段")} lookup={lookup} /> : <p className="text-caption text-fg-tertiary">{t("讀取 run…")}</p>}
        {runProgress.error ? <p className="text-caption text-fg-tertiary">{t("讀取逐步進度失敗（下一輪會再讀）：{error}", { error: runProgress.error })}</p> : null}
      </div>
      {run ? <CancelRunDialog run={run} open={confirming} onOpenChange={setConfirming} scope={scope.text} /> : null}
    </Section>
  );
}

/** actual_settings.concat.audio_track 的摘要（原音軌實際用了哪一段）；沒有紀錄時 null。 */
function audioTrackSummary(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const num = (key: string) => (typeof value[key] === "number" ? value[key] : null);
  const start = num("start_seconds");
  const duration = num("duration_seconds");
  const lead = num("lead_silence_seconds");
  const tail = num("tail_silence_seconds");
  const parts: string[] = [];
  if (start !== null) parts.push(t("從原影片 {start} 秒開始", { start: start.toFixed(3) }));
  if (duration !== null) parts.push(t("長 {duration} 秒", { duration: duration.toFixed(3) }));
  if (lead !== null && lead > 0) parts.push(t("開頭補靜音 {lead} 秒", { lead: lead.toFixed(3) }));
  if (tail !== null && tail > 0) parts.push(t("結尾補靜音 {tail} 秒", { tail: tail.toFixed(3) }));
  return parts.length > 0 ? parts.join(t("・")) : null;
}

function ExportSection({ info, job, progress, onNavigate }: { info: SwapProjectInfo; job: SwapJobApi; progress: SwapProgress; onNavigate: () => void }) {
  const { project } = useStudio();
  const record = progress.latestExport;
  const file = record?.state === "succeeded" ? record.asset?.file : undefined;
  const preview = job.exportPreview;
  const expected = preview?.totalFrames ?? info.job.end_frame - info.job.start_frame;
  const original = info.job.audio === "original";
  const range = info.job.end_frame - info.job.start_frame;
  const hints: string[] = [];
  if (preview && preview.problems.length === 0 && preview.totalFrames !== range) {
    hints.push(t("時間軸是 {totalFrames} 影格，原影片範圍是 {range} 影格（剪輯改過長度）；原音軌片段的位置以時間軸為準", { totalFrames: preview.totalFrames, range }));
  }
  const concatRecord = record?.asset?.actual_settings.concat;
  const track = isRecord(concatRecord) ? audioTrackSummary(concatRecord.audio_track) : null;
  const url = file ? mediaUrl(file.node_id, file.file_id) : null;
  const waitingAuto = info.job.auto_export && progress.phase === "ready_to_export" && project.exports.length === 0;
  return (
    <Section title={t("匯出")} icon={<Download />}>
      <Facts className="text-caption">
        <Fact label={t("聲音")}>{original ? t("原影片音軌（從範圍起點對齊，長度等於整段）") : t("各段生成的聲音")}</Fact>
        <Fact label={t("預期長度")}>
          <T source={"<0>{expected}</0> 影格（{expected2}）"} values={{ expected, expected2: formatDuration(expected, info.job.fps) }} slots={[<span className="machine" />]} />
        </Fact>
      </Facts>
      <NoteList tone="info" icon={<CircleAlert aria-hidden />} items={hints} />
      {!record ? (
        <p className="text-caption text-fg-tertiary">
          {waitingAuto ? t("全部段落完成；{value}會自動匯出一次。", { value: job.exportReason ? t("等待可以匯出（{exportReason}）後", { exportReason: job.exportReason }) : "" }) : t("還沒匯出。全部段落完成後按「匯出」。")}
        </p>
      ) : record.state === "rendering" ? (
        <p role="status" className="flex flex-wrap items-center gap-1.5 text-caption text-info">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          <T source={"匯出中（run <0>{run_id}</0>）<1>查看進度</1>"} values={{ run_id: record.run_id.slice(0, 8) }} slots={[<code className="machine" />, <Link to={`/studio/render?project=${encodeURIComponent(project.project_id)}&run=${encodeURIComponent(record.run_id)}`} onClick={onNavigate} />]} />
        </p>
      ) : record.state !== "succeeded" ? (
        <NoteList
          tone="danger"
          icon={<CircleX aria-hidden />}
          title={t("最近一次匯出沒有成功（不會自動重試）")}
          items={[record.error ? t("{code}：{message}", { code: record.error.code, message: tServer(record.error.message) }) : t("狀態：{state}", { state: record.state })]}
        />
      ) : progress.exportProblem ? (
        <NoteList
          tone="danger"
          icon={<CircleX aria-hidden />}
          title={AUDIO_TRACK_MISSING}
          items={[t("影片已經接好，但匯出紀錄裡沒有讀到來源影片的聲音。到「編輯」確認音軌上有原影片音軌的片段後，再按「再匯出一次」。")]}
        />
      ) : progress.exportCurrent ? (
        <p role="status" className="flex flex-wrap items-center gap-1.5 text-caption text-success">
          <CircleCheck aria-hidden className="size-3.5" />
          <T source={"已匯出整段影片：<0>{value}</0> 影格{value2}{value3}"} values={{ value: record.frames ?? "?", value2: record.frames !== null && record.frames !== expected ? <span className="text-warning">{t("（預期 {expected} 影格）", { expected })}</span> : null, value3: track ? <span className="text-fg-secondary">{t("・原音軌{track}", { track })}</span> : null }} slots={[<span className="machine" />]} />
        </p>
      ) : (
        <NoteList tone="warning" icon={<TriangleAlert aria-hidden />} items={[t("最近的匯出比部分段落的 take 舊（或段落順序改過）：按「再匯出一次」才會包含目前的 take。")]} />
      )}
      {url && file ? (
        <div className="grid min-w-0 gap-2">
          <video src={url} controls preload="metadata" aria-label={t("匯出結果：{title}", { title: project.title })} className="max-h-[40vh] w-full rounded-lg border border-line-subtle bg-stage object-contain animate-rise-in" />
          <div className="flex flex-wrap items-center gap-3 text-caption">
            <a href={url} download={`${project.title}.mp4`} className="pressable inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 hover:bg-raised">
              <Download aria-hidden className="size-3.5" />
              {t("下載 MP4")}
            </a>
            <span className="text-fg-tertiary">
              {t("{value}・{size_bytes}{value2}", { value: record?.frames ? formatDuration(record.frames) : "", size_bytes: formatBytes(file.size_bytes), value2: progress.exportProblem ? t("・聲音不是原影片音軌") : original && originalAudioApplied(record?.asset, info.source) === true ? t("・原影片音軌") : "" })}
            </span>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
