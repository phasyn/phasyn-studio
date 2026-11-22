// What to do about a run that ended without finishing everything (audit F-06, F-07), at the top of the overview.
// Failed: which shot and which step failed, in words, then the next steps: go to that shot in the Shots workspace,
// render again only the shots that did not finish (the render buttons' disabled reasons apply), copy the error; the
// error code, the step id and the details fold into 技術資訊. Cancelled by the user: one neutral line,
// 「已取消・完成 0／7」, with 重新渲染未完成的 n 個 (not a red alert). Interrupted (the Controller stopped): the same line
// in the warning tone. A sequence export offers the export dialog instead of a render.
import { Ban, Check, CircleX, Copy, RotateCcw, Unplug, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { StudioShot } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { Disclosure } from "@/components/common/Disclosure";
import { ErrorDetails } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { runErrorTitle } from "@/features/runs";
import { cn } from "@/lib/cn";
import { toErrorInfo } from "@/lib/errors";
import type { ProviderLookup } from "../../model/progress";
import type { QueueItem } from "../../model/renderQueue";
import { copyText } from "../../prompt/advisor/clipboard";
import { useStudio } from "../../studioContext";
import { ExportDialog } from "../ExportDialog";
import { retryDisabledReason } from "./retry";
import { runFailure, unfinishedShots, type RunItem } from "./runView";
import { useShotsLink } from "./shotsLink";
import { t, tServer } from "@/i18n";

const ENDED_WITHOUT_VIDEO: ReadonlySet<RunItem["state"]> = new Set(["failed", "cancelled", "interrupted"]);

/** Renders again what the run did not finish: the shots, or as many new variations of the one shot. */
function RetryButton({ item, items, label }: { item: QueueItem; items: readonly RunItem[]; label: (count: number) => string }) {
  const { project, engine, runBlockedReason, busy, renderShots, renderVariations } = useStudio();
  const shots = unfinishedShots(items, project);
  const first = shots[0];
  if (!first) return null;
  // Variations: as many new seeds as variations did not finish (one is a plain render of the shot)
  const count = item.kind === "variations" ? items.filter((entry) => ENDED_WITHOUT_VIDEO.has(entry.state)).length : shots.length;
  const run = () => (item.kind === "variations" && count > 1 ? renderVariations(first.shot_id, count) : renderShots(item.kind === "variations" ? [first.shot_id] : shots.map((shot) => shot.shot_id)));
  return (
    <ActionButton size="sm" variant="secondary" icon={<RotateCcw aria-hidden />} pending={busy === "render"} disabledReason={retryDisabledReason(shots, { project, engine, runBlockedReason, busy })} onClick={() => void run()}>
      {label(count)}
    </ActionButton>
  );
}

function CopyErrorButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => { setState("idle"); }, 2000);
    return () => { window.clearTimeout(timer); };
  }, [state]);
  return (
    <>
      <Button size="sm" variant="quiet" icon={state === "copied" ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />} onClick={() => void copyText(text).then((ok) => { setState(ok ? "copied" : "failed"); })}>
        {t("複製錯誤")}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? t("已複製") : state === "failed" ? t("複製失敗，請手動選取") : ""}
      </span>
    </>
  );
}

function FixLink({ shot }: { shot: StudioShot }) {
  const link = useShotsLink();
  return (
    <Link to={link.href(shot.shot_id)} onClick={() => { link.prepare(shot.shot_id); }} className={cn(buttonVariants({ variant: "primary", size: "sm" }), "max-w-full min-w-0 no-underline")} title={t("在「鏡頭」選取「{title}」", { title: shot.title })}>
      <Wrench aria-hidden />
      <span className="truncate">{t("前往「{title}」修正", { title: shot.title })}</span>
    </Link>
  );
}

function FailureCard({ run, item, items, lookup }: { run: WireRun; item: QueueItem; items: readonly RunItem[]; lookup: ProviderLookup }) {
  const { project } = useStudio();
  const failure = runFailure(run, lookup);
  const info = failure.error ? toErrorInfo(failure.error) : null;
  const failedShotId = items.find((entry) => entry.suffix === failure.suffix)?.shot?.shot_id;
  const shot = project.shots.find((candidate) => candidate.shot_id === failedShotId) ?? null;
  const stage = failure.stage;
  const title = shot && (stage != null && stage !== "") ? t("「{shot}」：{stage}失敗", { shot: shot.title, stage }) : (stage != null && stage !== "") ? t("{stage}失敗", { stage }) : runErrorTitle(run);
  const message = info ? tServer(info.message) : null;
  const copied = [title, message, info ? info.code : null, failure.stepId, `run ${run.run_id}`].filter(Boolean).join("\n");
  return (
    <section aria-label={title} className="grid gap-3 rounded-xl border border-danger/40 bg-danger/5 p-4 animate-fade-in">
      <div className="flex min-w-0 items-start gap-3">
        <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="grid min-w-0 gap-1">
          <h3 className="text-body font-semibold text-fg [overflow-wrap:anywhere]">{title}</h3>
          {(message != null && message !== "") ? <p className="text-data text-fg-secondary [overflow-wrap:anywhere]">{message}</p> : null}
          {(info?.hint != null && info.hint !== "") ? <p className="text-caption text-fg-tertiary">{info.hint}</p> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pl-8">
        {shot ? <FixLink shot={shot} /> : null}
        {item.kind === "export" ? <ExportDialog /> : <RetryButton item={item} items={items} label={(count) => t("只重新渲染失敗的 {count} 個", { count })} />}
        <CopyErrorButton text={copied} />
      </div>
      {info ? (
        <Disclosure summary={t("技術資訊")} className="pl-8" summaryClassName="text-caption">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
            <dt className="text-fg-tertiary">{t("錯誤碼")}</dt>
            <dd className="machine text-fg-secondary">{info.code}</dd>
            {(failure.stepId != null && failure.stepId !== "") ? (
              <>
                <dt className="machine text-fg-tertiary">step_id</dt>
                <dd className="machine text-fg-secondary">{failure.stepId}</dd>
              </>
            ) : null}
            <dt className="machine text-fg-tertiary">run_id</dt>
            <dd className="machine text-fg-secondary [overflow-wrap:anywhere]">{run.run_id}</dd>
          </dl>
          <ErrorDetails details={info.details} />
        </Disclosure>
      ) : null}
    </section>
  );
}

function StoppedLine({ run, item, items }: { run: WireRun; item: QueueItem; items: readonly RunItem[] }) {
  const interrupted = run.state === "interrupted";
  const Icon = interrupted ? Unplug : Ban;
  const values = { done: items.filter((entry) => entry.state === "succeeded").length, total: items.length };
  return (
    <div className={cn("flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2 animate-fade-in", interrupted ? "border-warning/40 bg-warning/10 text-warning" : "border-line bg-raised/40 text-fg-secondary")}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-data" title={run.error ? tServer(run.error.message) : undefined}>
        {interrupted ? t("已中斷・完成 {done}／{total}", values) : t("已取消・完成 {done}／{total}", values)}
      </p>
      {item.kind === "export" ? <ExportDialog /> : <RetryButton item={item} items={items} label={(count) => t("重新渲染未完成的 {count} 個", { count })} />}
    </div>
  );
}

export function RunOutcome({ run, item, items, lookup }: { run: WireRun; item: QueueItem; items: readonly RunItem[]; lookup: ProviderLookup }) {
  if (run.state === "failed") return <FailureCard run={run} item={item} items={items} lookup={lookup} />;
  if (run.state === "cancelled" || run.state === "interrupted") return <StoppedLine run={run} item={item} items={items} />;
  return null;
}
