// The fix runs of a shot in its take strip, right after the takes (where the new take will appear): a small card per
// run with its progress while it runs (「修正自 take 2 · 畫質修復」, 執行中 · 2 分鐘); once brought back as a take or a
// library item the card goes away. A run that failed, could not be brought back (with 重試) or handed back files
// (open them) stays until it is closed with ×.
import { CircleAlert, FileDown, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { runSteps } from "@/api/types";
import { CHOICE_BASE, CHOICE_IDLE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { isoToMs } from "@/lib/time";
import { componentLoadText, stepsComponentLoad, waitingForResource } from "../model/progress";
import { takeNumber } from "../model/takeDownload";
import { useStudio } from "../studioContext";
import { inFlight, markFixDone, setFixError, useFixDone, useFixErrors } from "./fixStore";
import { ResultFiles } from "./FixRunDialog";
import { fixLabel } from "./tools";
import { useFixRuns, type FixRun } from "./useFixRuns";

function minutes(created: string, now: number | null): string | null {
  const start = isoToMs(created);
  if (start === null || now === null) return null;
  const elapsed = Math.max(0, Math.round((now - start) / 60_000));
  return elapsed < 1 ? t("剛開始") : t("{minutes} 分鐘", { minutes: elapsed });
}

const iconButton = "pressable grid size-5 shrink-0 place-items-center rounded-full text-fg-tertiary hover:bg-overlay hover:text-fg";

function FixCard({ entry, shot, index, now, error }: { entry: FixRun; shot: StudioShot; index: number; now: number | null; error: string | undefined }) {
  const { run, note, tool } = entry;
  const [open, setOpen] = useState(false);
  const parent = shot.takes.find((take) => take.take_id === note.take_id);
  const label = fixLabel(parent ? takeNumber(shot, parent) : null, tool.name());
  const running = run.state === "running" || (run.state === "succeeded" && tool.result !== "files" && error === undefined);
  const files = run.state === "succeeded" && tool.result === "files";
  const failed = !running && !files;
  const steps = run.state === "running" ? runSteps(run) : [];
  const load = stepsComponentLoad(steps);
  const queued = !load && waitingForResource(steps);
  const status = load ? componentLoadText(load)
    : queued ? joinStatus(t("等待資源"), minutes(run.created_at, now))
    : run.state === "running" ? joinStatus(t("執行中"), minutes(run.created_at, now))
    : running ? (tool.result === "take" ? t("加入 take 中…") : t("加入素材庫中…"))
    : files ? t("完成 · 打開結果")
    : error ?? (run.state === "cancelled" ? t("已取消") : run.error ? errorText(run.error) : t("沒有完成"));
  return (
    <div
      ref={reveal(index)}
      role="listitem"
      aria-label={t("{label}：{status}", { label, status })}
      title={`${label}\n${status}`}
      className={cn(CHOICE_BASE, CHOICE_IDLE, "flex h-12 w-52 shrink-0 items-center gap-2 rounded-lg border-dashed p-1 animate-fade-in", failed && "border-warning/50")}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-stage">
        {running ? <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-cyan" />
          : files ? <FileDown aria-hidden className="size-4 text-brand-cyan" />
          : <CircleAlert aria-hidden className="size-4 text-warning" />}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5 text-caption leading-4">
        <span className="truncate font-medium text-fg">{label}</span>
        {files ? (
          <button type="button" className="w-fit truncate text-left text-action-fg underline-offset-2 hover:underline" onClick={() => { setOpen(true); }}>{status}</button>
        ) : (
          <span className={cn("truncate", failed ? "text-warning" : "text-info")}>{status}</span>
        )}
      </span>
      {error !== undefined ? (
        <button type="button" className={iconButton} aria-label={t("重試")} title={t("重試")} onClick={() => { setFixError(run.run_id, null); }}>
          <RotateCcw aria-hidden className="size-3" />
        </button>
      ) : null}
      {!running || error !== undefined ? (
        <button type="button" className={iconButton} aria-label={t("關閉")} title={t("關閉")} onClick={() => { setFixError(run.run_id, null); markFixDone(run.run_id); }}>
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
      {files && parent ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-xl" onKeyDown={(event) => { event.stopPropagation(); }}>
            <DialogHeader>
              <DialogTitle>{tool.name()}</DialogTitle>
              <DialogDescription>{label}</DialogDescription>
            </DialogHeader>
            <DialogBody><ResultFiles run={run} source={{ kind: "take", shot, take: parent }} pair={null} /></DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function joinStatus(head: string, tail: string | null): string {
  return tail === null ? head : `${head} · ${tail}`;
}

export function FixRunCards({ shot, now, startIndex }: { shot: StudioShot; now: number | null; startIndex: number }) {
  const { project } = useStudio();
  const { runs } = useFixRuns(project.project_id);
  const done = useFixDone();
  const errors = useFixErrors();
  const own = runs
    .filter((entry) => entry.note.shot_id === shot.shot_id && !done.includes(entry.run.run_id))
    // A take result already on the shot needs no card while the watcher marks it done
    .filter((entry) => !(entry.tool.result === "take" && shot.takes.some((take) => take.run_id === entry.run.run_id) && !inFlight.has(entry.run.run_id)))
    .reverse();
  if (own.length === 0) return null;
  return (
    <div role="list" aria-label={t("進行中的修正")} className="flex shrink-0 items-center gap-1.5 border-l border-line-subtle pl-1.5">
      {own.map((entry, index) => <FixCard key={entry.run.run_id} entry={entry} shot={shot} index={startIndex + index} now={now} error={errors[entry.run.run_id]} />)}
    </div>
  );
}
