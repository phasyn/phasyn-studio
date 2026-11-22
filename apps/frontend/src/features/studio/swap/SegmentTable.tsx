// The swap panel's segment table: each segment's original time, generated and kept length, state, join and actions,
// with the check against the original (compareQueue): a verdict badge once a check ran, a 「比對原片」 control that
// opens the check under the row (and runs it when there is no result), and an automatic check of the newest take that
// finishes while the panel is open (never every segment at once on open).
// Look (Phasyn): the table stays crisp; the check opens as a sunken card under its row.
import { Ban, CircleCheck, CircleDashed, CircleX, Film, LoaderCircle, RotateCcw, ScanEye, SquarePen, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ActionButton } from "@/components/common/ActionButton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { useEditor } from "../editor/editorContext";
import { clipDuration, clipEnabled } from "../editor/model";
import { shotClips } from "../editor/sources";
import { activeTransition } from "../model/clipEffects";
import { useStudio } from "../studioContext";
import { requestComparison, useComparisons, type CompareStatus } from "./compareQueue";
import { compareTarget, type CompareTarget } from "./compareTarget";
import { verdictView } from "./compareView";
import { Section } from "./fields";
import type { SegmentView, SwapProgress } from "./job";
import { joinText, SEGMENT_LABELS, segmentErrorHint, segmentTone, type SummaryTone } from "./jobView";
import { SegmentCompare } from "./SegmentCompare";
import type { SwapJobApi } from "./useSwapJob";
import { t, tServer } from "@/i18n";
import { errorHeadline } from "@/i18n/errors";
import { failureText } from "@/lib/errors";

const TONE_TEXT: Record<SummaryTone, string> = {
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  danger: "text-danger",
  neutral: "text-fg-tertiary",
};

const SEGMENT_ICON: Record<SegmentView["state"], { icon: LucideIcon; spin?: boolean }> = {
  pending: { icon: CircleDashed },
  rendering: { icon: LoaderCircle, spin: true },
  done: { icon: CircleCheck },
  stale: { icon: TriangleAlert },
  failed: { icon: CircleX },
  cancelled: { icon: Ban },
  interrupted: { icon: TriangleAlert },
  skipped: { icon: CircleDashed },
};

const playable = (segment: Pick<SegmentView, "state">) => segment.state === "done" || segment.state === "stale";

/**
 * Checks the newest take that finished while the panel is open: the takes ready when it opened are only remembered, a
 * take that appears later (a render that just ended) is checked once; when several appear together, only the newest.
 */
function useAutoCheck(segments: readonly SegmentView[], targets: ReadonlyMap<string, CompareTarget>): void {
  const knownRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ready = segments.flatMap((segment) => {
      const target = targets.get(segment.shot.shot_id);
      return playable(segment) && (target?.ok === true) ? [{ index: segment.index, target }] : [];
    });
    if (knownRef.current === null) {
      knownRef.current = new Set(ready.map((item) => item.target.takeId));
      return;
    }
    const seen = knownRef.current;
    const fresh = ready.filter((item) => !seen.has(item.target.takeId));
    for (const item of fresh) seen.add(item.target.takeId);
    const newest = fresh.sort((a, b) => a.target.takeCreatedAt.localeCompare(b.target.takeCreatedAt) || a.index - b.index).at(-1);
    if (newest) requestComparison(newest.target, { auto: true });
  }, [segments, targets]);
}

export function SegmentTable({ progress, job, projectId, onNavigate }: { progress: SwapProgress; job: SwapJobApi; projectId: string; onNavigate: () => void }) {
  const { project } = useStudio();
  const { timeline } = useEditor();
  const checks = useComparisons();
  const targets = useMemo(() => new Map(progress.segments.map((segment) => [segment.shot.shot_id, compareTarget(project, segment.shot, timeline)])), [progress.segments, project, timeline]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  useAutoCheck(progress.segments, targets);
  const toggle = (shotId: string) => {
    const opening = !open.has(shotId);
    const next = new Set(open);
    if (opening) next.add(shotId);
    else next.delete(shotId);
    setOpen(next);
    const target = targets.get(shotId);
    if (opening && (target?.ok === true)) requestComparison(target);
  };
  const last = progress.segments.length - 1;
  return (
    <Section title={t("段落（{segmentsCount}）", { segmentsCount: progress.segments.length })} icon={<Film />}>
      {progress.segments.length === 0 ? (
        <p className="text-caption text-fg-tertiary">{t("序列裡沒有段落（鏡頭都移出序列了）：在「編輯」把段落加回序列。")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line-subtle">
          <table className="w-full min-w-[56rem] table-fixed border-collapse text-data">
            <caption className="sr-only">{t("每一段的原影片時間、生成與保留長度、狀態、接到下一段的方式與動作")}</caption>
            <thead className="bg-canvas text-caption text-fg-tertiary">
              <tr>
                {/* the column holds a two-digit number: a short heading that fits, the word for assistive technology */}
                <th scope="col" aria-label={t("段")} title={t("段")} className="w-10 px-2 py-1.5 text-left font-medium">
                  {t("段", undefined, { context: "number-column" })}
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">
                  {t("原影片")}
                </th>
                <th scope="col" className="w-32 px-2 py-1.5 text-left font-medium">
                  {t("生成／保留")}
                </th>
                <th scope="col" className="w-52 px-2 py-1.5 text-left font-medium">
                  {t("狀態")}
                </th>
                <th scope="col" className="w-40 px-2 py-1.5 text-left font-medium">
                  {t("接下一段")}
                </th>
                <th scope="col" className="w-64 px-2 py-1.5 text-left font-medium">
                  {t("動作")}
                </th>
              </tr>
            </thead>
            <tbody>
              {progress.segments.map((segment) => {
                const target = targets.get(segment.shot.shot_id) ?? null;
                return (
                  <SegmentRow
                    key={segment.shot.shot_id}
                    segment={segment}
                    last={segment.index === last}
                    job={job}
                    projectId={projectId}
                    onNavigate={onNavigate}
                    target={target}
                    check={(target?.ok === true) ? (checks.get(target.key) ?? null) : null}
                    open={open.has(segment.shot.shot_id)}
                    onToggle={() => { toggle(segment.shot.shot_id); }}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** A failed segment's reason: the error's plain headline and what to try; the runtime's own message stays in the tooltip. */
function SegmentError({ code, message }: { code: string; message: string }) {
  const headline = errorHeadline(code);
  const hint = segmentErrorHint(code);
  return (
    <span className="mt-0.5 grid gap-0.5 text-caption [overflow-wrap:anywhere]" title={failureText(code, message)}>
      <span className="line-clamp-2 text-fg-secondary">{headline ?? failureText(code, message)}</span>
      {(hint != null && hint !== "") ? <span className="text-fg-tertiary">{hint}</span> : null}
    </span>
  );
}

/** The check's state in the row: the verdict once it ran, a spinner while it runs, why it could not finish. */
function CheckBadge({ check }: { check: CompareStatus | null }) {
  if (!check) return null;
  if (check.status === "done") {
    const view = verdictView(check.result.metrics);
    return (
      <Badge key="done" tone={view.tone} className="animate-pop-in" title={view.line}>
        {view.label}
      </Badge>
    );
  }
  if (check.status === "failed") {
    return (
      <Badge key="failed" tone="neutral" className="animate-pop-in" title={check.reason}>
        {t("無法比對")}
      </Badge>
    );
  }
  return (
    <Badge key="busy" tone="info" className="animate-pop-in">
      <LoaderCircle aria-hidden className="animate-spin" />
      {check.status === "queued" ? t("等待比對") : t("比對中")}
    </Badge>
  );
}

interface SegmentRowProps {
  segment: SegmentView;
  last: boolean;
  job: SwapJobApi;
  projectId: string;
  onNavigate: () => void;
  target: CompareTarget | null;
  check: CompareStatus | null;
  open: boolean;
  onToggle: () => void;
}

function SegmentRow({ segment, last, job, projectId, onNavigate, target, check, open, onToggle }: SegmentRowProps) {
  const { shot, state, error } = segment;
  // What the segment contributes to the film is read from the timeline (the one edit state), not from the shot
  const editor = useEditor();
  const { timeline } = editor;
  const navigate = useNavigate();
  const panelId = useId();
  const clips = shotClips(timeline, shot.shot_id);
  // The speed-feel tool works on one clip: the segment's picture, when the timeline has it as one clip
  const pictures = clips.filter((clip) => editor.trackOf(clip)?.kind === "video" && clipEnabled(clip));
  const picture = pictures.length === 1 ? pictures[0] : undefined;
  const speedFeel = {
    blocked: picture ? null : pictures.length === 0 ? t("這段不在時間軸上（或片段已關閉），沒有可以加效果的片段") : t("這段在時間軸上分成 {count} 個片段：到「編輯」選一個片段，從它的選單開啟速度感", { count: pictures.length }),
    onOpen: () => {
      if (!picture) return;
      // The dialog opens over 「編輯」 with the segment's clip selected (the selection does not touch the address)
      editor.selectShotClip(shot.shot_id);
      editor.ui.setSpeedFeelClip(picture.clip_id);
      onNavigate();
      void navigate(`/studio/edit?project=${encodeURIComponent(projectId)}&shot=${encodeURIComponent(shot.shot_id)}`);
    },
  };
  const kept = clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
  const join = joinText(activeTransition(clips.at(-1)?.effects), last || clips.length === 0);
  const icon = SEGMENT_ICON[state];
  const tone = TONE_TEXT[segmentTone(segment)];
  const done = playable(segment);
  return (
    <>
      <tr className="border-t border-line-subtle align-top transition-colors duration-(--duration-fast) hover:bg-raised/40">
        <td className="machine px-2 py-1.5 text-fg-secondary">{String(segment.index + 1).padStart(2, "0")}</td>
        <td className="px-2 py-1.5">
          <span className="block truncate text-fg" title={shot.title}>
            {shot.title}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <span className="machine block text-fg">{t("{frames} 影格", { frames: shot.frames })}</span>
          <span className="machine block text-caption text-fg-tertiary">{clips.length > 0 ? t("時間軸 {frames} 影格", { frames: kept }) : t("不在時間軸上")}</span>
        </td>
        <td className="px-2 py-1.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("inline-flex items-center gap-1 text-caption [&_svg]:size-3.5", tone)}>
              <icon.icon aria-hidden className={(icon.spin === true) ? "animate-spin" : undefined} />
              {SEGMENT_LABELS[state]}
            </span>
            {done ? <CheckBadge check={check} /> : null}
          </span>
          {error ? <SegmentError code={error.code} message={tServer(error.message)} /> : null}
          {state === "skipped" ? <span className="mt-0.5 block text-caption text-fg-tertiary">{t("同一個 run 的其他段落失敗，這段沒有開始")}</span> : null}
        </td>
        <td className={cn("px-2 py-1.5 text-caption", (join?.midShot === true) ? "text-warning" : "text-fg-secondary")}>{join ? join.text : "—"}</td>
        <td className="px-2 py-1.5">
          <span className="flex flex-wrap items-center gap-1">
            {/* 渲染中也保留按鈕（停用並說明原因），按下後焦點不會掉到對話框外 */}
            <ActionButton size="sm" variant="secondary" icon={<RotateCcw aria-hidden />} disabledReason={job.retryReason(shot)} onClick={() => { job.retrySegment(shot.shot_id); }} title={done ? t("再渲染一個新的 take（完成後成為使用中的 take，之後要重新匯出）") : t("渲染這一段")}>
              {done ? t("重新渲染") : t("渲染")}
            </ActionButton>
            <Link
              to={`/studio/generate?project=${encodeURIComponent(projectId)}&shot=${encodeURIComponent(shot.shot_id)}`}
              onClick={onNavigate}
              className="pressable inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-caption hover:bg-raised"
              title={t("到「鏡頭」查看這段的 prompt、參考與 take")}
            >
              <SquarePen aria-hidden className="size-3.5" />
              {t("鏡頭")}
            </Link>
            {done ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={onToggle}
                title={t("逐格對照這段的 take 與原片：構圖、動作速度與切鏡")}
                className={cn("pressable inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-caption transition-colors duration-(--duration-fast) hover:bg-raised", open ? "bg-raised text-fg" : "text-fg-secondary")}
              >
                <ScanEye aria-hidden className="size-3.5" />
                {t("比對原片")}
              </button>
            ) : null}
          </span>
        </td>
      </tr>
      {done && open && target ? (
        <tr>
          <td colSpan={6} className="px-2 pt-0 pb-3">
            <SegmentCompare id={panelId} target={target} check={check} onRun={() => { if (target.ok) { requestComparison(target, { force: true }); } }} speedFeel={speedFeel} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
