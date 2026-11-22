// The speech jobs under way, inline in the Captions panel: one row per transcription and one summary row for the dubbed
// lines, each with what it is doing now (loading the model on first use, recognising, voicing), the time so far and a
// cancel; a job that could not finish says why until it is dismissed.
import { AudioLines, Captions, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cancelRun, useCancelRun } from "@/api/runs";
import { Button } from "@/components/ui/button";
import { reveal } from "@/components/ui/motion";
import { parseRunStep, type WireRun } from "@/api/types";
import { t } from "@/i18n";
import { componentLoadText, stepsComponentLoad } from "../model/progress";
import { dialogueJobs } from "./dialogueJobs";
import type { Readiness } from "./dialogueRoutes";
import type { JobView } from "./useDialogueJobs";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [active]);
  return now;
}

/** m:ss since the job started. */
function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the job is doing now: the Controller's component_load (loading the model, or waiting for it), else its step. */
function phase(kind: "transcribe" | "speech", run: WireRun | undefined, state: Readiness | null): string {
  const steps = Object.entries(run?.steps ?? {}).map(([stepId, raw]) => parseRunStep(stepId, raw));
  const load = stepsComponentLoad(steps);
  if (load) return componentLoadText(load);
  if (steps.some((step) => step.state === "running")) return kind === "transcribe" ? t("正在辨識台詞") : t("正在產生配音");
  if (state?.kind === "cold" || state?.kind === "loading") return t("首次使用需要載入模型（約 {seconds} 秒）", { seconds: state.seconds });
  return t("等待開始");
}

function CancelButton({ runIds }: { runIds: readonly string[] }) {
  const first = runIds[0] ?? "";
  const cancel = useCancelRun(first);
  return (
    <Button size="sm" variant="quiet" pending={cancel.isPending} title={t("取消這項工作")} onClick={() => {
      // Each line of speech is its own run: cancelling the row stops them all
      for (const runId of runIds.slice(1)) void cancelRun(runId).catch(() => undefined);
      cancel.mutate();
    }}>
      {t("取消")}
    </Button>
  );
}

interface Props {
  projectId: string;
  views: readonly JobView[];
  transcribeState: Readiness | null;
  speechState: Readiness | null;
}

export function JobRows({ projectId, views, transcribeState, speechState }: Props) {
  const running = views.filter((view) => view.job.error === undefined);
  const now = useNow(running.length > 0);
  const failed = views.filter((view) => view.job.error !== undefined);
  const transcribing = running.filter((view) => view.job.kind === "transcribe");
  const voicing = running.filter((view) => view.job.kind === "speech");
  if (views.length === 0) return null;
  const firstVoice = voicing[0];
  return (
    <ul aria-live="polite" className="grid shrink-0 grid-cols-1 gap-1 border-b border-line-subtle px-2 py-1.5">
      {transcribing.map(({ job, run }, index) => (
        <li key={job.runId} ref={reveal(index)} className="flex min-h-8 items-center gap-2 text-data">
          <Captions aria-hidden className="size-4 shrink-0 text-action-fg" />
          <span className="min-w-0 flex-1 truncate" title={job.label}>
            <span className="text-fg">{job.label}</span>
            <span className="text-fg-secondary">{t("・")}{phase("transcribe", run, transcribeState)}</span>
          </span>
          <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-fg-tertiary" />
          <span className="machine w-12 shrink-0 text-right text-caption text-fg-tertiary">{elapsed(job.startedAt, now)}</span>
          <CancelButton runIds={[job.runId]} />
        </li>
      ))}
      {firstVoice ? (
        <li ref={reveal(transcribing.length)} className="flex min-h-8 items-center gap-2 text-data">
          <AudioLines aria-hidden className="size-4 shrink-0 text-action-fg" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg">{t("配音 {count} 句", { count: voicing.length })}</span>
            <span className="text-fg-secondary">{t("・")}{phase("speech", (voicing.find((view) => view.run?.state === "running") ?? firstVoice).run, speechState)}</span>
          </span>
          <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-fg-tertiary" />
          <span className="machine w-12 shrink-0 text-right text-caption text-fg-tertiary">{elapsed(Math.min(...voicing.map((view) => view.job.startedAt)), now)}</span>
          <CancelButton runIds={voicing.map((view) => view.job.runId)} />
        </li>
      ) : null}
      {failed.map(({ job }, index) => (
        <li key={job.runId} ref={reveal(index)} role="alert" className="flex min-h-8 items-start gap-2 py-0.5 text-data">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-fg" title={job.label}>{job.kind === "transcribe" ? job.label : t("配音「{line}」", { line: job.label })}</span>
            <span className="line-clamp-2 text-caption text-danger" title={job.error}>{job.error}</span>
          </span>
          <Button size="icon-sm" variant="quiet" icon={<X aria-hidden />} aria-label={t("關閉這則訊息")} title={t("關閉這則訊息")}
            onClick={() => { dialogueJobs.remove(projectId, [job.runId]); }} />
        </li>
      ))}
    </ul>
  );
}
