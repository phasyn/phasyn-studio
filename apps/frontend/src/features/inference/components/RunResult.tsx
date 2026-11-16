import { ArrowLeft, Ban, ExternalLink, History, ListChecks, ListVideo, LoaderCircle, PackageOpen } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useRun, useRunList } from "@/api/runs";
import { asTypedValueMap, runSteps, type RunStepView, type WireRun } from "@/api/types";
import { runPath } from "@/app/paths";
import { ActionButton } from "@/components/common/ActionButton";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { StatusBadge } from "@/components/common/StatusBadge";
import { TimeText } from "@/components/common/values";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { hasErrorCode } from "@/lib/errors";
import { formatTimestamp } from "@/lib/format";
import { runDisplayName } from "@/lib/runName";
import { elapsedMs, formatElapsed, useNow } from "@/lib/time";
import type { DescriptorLookup } from "@/features/pipelines";
import { runErrorTitle, runValues, stepErrorTitle, stepProgress, stepProgressText, TypedValueView } from "@/features/runs";
import { reveal } from "@/components/ui/motion";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { t } from "@/i18n";

const MEDIA_OUTPUT = /^media\.(asset|video|audio|image)\.v1$/;

/**
 * Step progress: steps that succeeded out of all steps, with the ones that ended otherwise listed after it (the same
 * definition as the run history, stepProgress); only states are counted, nothing is estimated.
 */
function StepProgress({ steps }: { steps: readonly RunStepView[] }) {
  const progress = stepProgress(steps);
  const text = stepProgressText(progress);
  const failed = progress.ended.some((entry) => entry.state !== "skipped");
  const running = steps.some((step) => step.state === "running");
  const complete = progress.total > 0 && progress.succeeded === progress.total;
  return (
    <div className="grid gap-1.5">
      <ProgressTrack
        value={progress.succeeded}
        max={Math.max(1, progress.total)}
        tone={failed ? "failed" : running ? "running" : complete ? "done" : "idle"}
        label={t("步驟進度")}
        valueText={text}
      />
      <p className="machine text-caption text-fg-tertiary">
        {text}
        {running ? t("・執行中，每 2 秒更新") : ""}
      </p>
    </div>
  );
}

function StepRow({ step, lookup, now }: { step: RunStepView; lookup: DescriptorLookup; now: number | null }) {
  const descriptor = step.node_id && step.component_id ? lookup(step.node_id, step.component_id) : null;
  const kind = providerKind(descriptor?.provider_id);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-b border-line-subtle px-3 py-1.5 transition-colors duration-(--duration-fast) last:border-b-0 hover:bg-raised/50">
      <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
      <span className="flex min-w-0 items-baseline gap-2">
        <code className="machine truncate text-data text-fg">{step.step_id}</code>
        <code className="machine truncate text-caption text-fg-tertiary">{step.component_id ?? "—"}</code>
      </span>
      <StatusBadge kind="step" value={step.state} />
      <span />
      <span className="machine col-span-2 text-caption text-fg-tertiary">
        {`${step.started_at ? t("耗時 {elapsedMs}", { elapsedMs: formatElapsed(elapsedMs(step.started_at, step.finished_at, step.state === "running" ? now : null)) }) : t("尚未開始")}${step.remote_outcome_unknown ? t("・遠端結果未知") : ""}`}
      </span>
    </li>
  );
}

function RunBody({ run, lookup, pipelineId }: { run: WireRun; lookup: DescriptorLookup; pipelineId: string | null }) {
  const running = run.state === "running";
  const now = useNow(running);
  // The Cancel button that asked (non-null while confirming); it leaves with the running state, and focus then goes
  // to the link to this run's record beside it
  const [cancelOpener, setCancelOpener] = useState<HTMLElement | null>(null);
  const recordLink = useRef<HTMLAnchorElement>(null);
  const steps = runSteps(run);
  const outputs = Object.entries(asTypedValueMap(run.outputs));
  const stepMedia = runValues(run).filter((value) => value.stepId !== null && MEDIA_OUTPUT.test(value.value.type_id));
  const failedStep = steps.find((step) => step.error !== null);
  const title = runDisplayName(run);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EntityHeader
        icon={ListVideo}
        tone={running ? "info" : run.state === "succeeded" ? "success" : run.state === "failed" ? "danger" : "neutral"}
        title={title}
        status={<StatusBadge kind="run" value={run.state} />}
        description={
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>{t("建立")}</span>
            <TimeText iso={run.created_at} />
            <span className="machine">{t("· 耗時 {elapsedMs}", { elapsedMs: formatElapsed(elapsedMs(run.created_at, run.finished_at, now)) })}</span>
          </span>
        }
        id={run.run_id}
        actions={
          <>
            <Link ref={recordLink} to={runPath(run.run_id)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <ExternalLink aria-hidden />
              {t("在執行紀錄開啟")}
            </Link>
            {running ? (
              <ActionButton size="sm" variant="danger" icon={<Ban aria-hidden />} onClick={(event) => setCancelOpener(event.currentTarget)} title={t("中止進行中的步驟（只結束這個 run 呼叫的元件程序）；不會自動重跑")}>
                {t("取消 run…")}
              </ActionButton>
            ) : null}
          </>
        }
      />
      <DockBody className="relative">
        <div className="grid gap-2 border-b border-line-subtle px-3 py-3">
          <StepProgress steps={steps} />
          {pipelineId && run.request.pipeline.pipeline_id !== pipelineId ? (
            <p className="text-caption text-warning">{t("這個 run 來自元件組合 {pipeline_id}，不是目前選的元件組合。", { pipeline_id: run.request.pipeline.pipeline_id })}</p>
          ) : null}
          {run.state === "interrupted" ? <p className="text-caption text-warning">{t("run 已中斷（Controller 曾重新啟動）；沒有恢復，需要時請重新建立。")}</p> : null}
          {failedStep?.error ? (
            <ErrorCallout
              error={{ ...failedStep.error, remote_outcome_unknown: failedStep.error.remote_outcome_unknown === true || failedStep.remote_outcome_unknown }}
              title={stepErrorTitle(failedStep)}
            />
          ) : run.error ? (
            <ErrorCallout error={run.error} title={runErrorTitle(run)} />
          ) : null}
        </div>
        <PropertySection title={t("步驟")} icon={<ListChecks aria-hidden />} count={steps.length} bodyClassName="px-0 pb-0">
          <ul aria-label={t("步驟狀態")}>
            {steps.map((step) => (
              <StepRow key={step.step_id} step={step} lookup={lookup} now={now} />
            ))}
          </ul>
        </PropertySection>
        <PropertySection title={t("輸出")} icon={<PackageOpen aria-hidden />} count={outputs.length + stepMedia.length}>
          {outputs.length === 0 && stepMedia.length === 0 ? (
            <p className="text-caption text-fg-tertiary">{running ? t("執行中：輸出完成後顯示在這裡。") : t("這個 run 沒有輸出。")}</p>
          ) : (
            <div className="grid gap-3">
              {outputs.map(([name, value]) => (
                <TypedValueView key={name} name={name} value={value} run={run} usage="output" />
              ))}
              {stepMedia.map((value) => (
                <TypedValueView key={value.key} name={`${value.stepId ?? ""}.${value.port}`} value={value.value} run={run} usage="output" />
              ))}
            </div>
          )}
        </PropertySection>
      </DockBody>
      {/* Mounted only while confirming, so every confirmation starts fresh (the same dialog as the top bar). */}
      {cancelOpener ? (
        <CancelRunDialog
          run={run}
          open
          onOpenChange={(open) => (open ? undefined : setCancelOpener(null))}
          onCloseAutoFocus={(event) => returnFocusOr(event, cancelOpener, recordLink.current)}
        />
      ) : null}
    </div>
  );
}

/** 右側「執行結果」：網址的 ?run= 對應的 run（執行中自動更新），或這個元件組合最近的 run。 */
export function RunResult({
  runId,
  pipelineId,
  lookup,
  onSelectRun,
}: {
  runId: string | null;
  pipelineId: string | null;
  lookup: DescriptorLookup;
  onSelectRun: (runId: string | null) => void;
}) {
  const query = useRun(runId);
  if (!runId) return <RecentRuns pipelineId={pipelineId} onSelectRun={onSelectRun} />;
  const back = (
    <div className="flex h-9 shrink-0 items-center border-b border-line-subtle px-1.5">
      <Button size="sm" variant="quiet" icon={<ArrowLeft aria-hidden />} onClick={() => onSelectRun(null)} className="min-h-7 px-2">
        {t("最近的 run")}
      </Button>
    </div>
  );
  if (query.isPending) {
    return (
      <>
        {back}
        <p role="status" className="flex items-center gap-2 px-3 py-4 text-body text-fg-secondary">
          <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
          {t("讀取 run {runId}…", { runId: runId.slice(0, 8) })}
        </p>
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        {back}
        <DockBody className="relative p-3">
          {hasErrorCode(query.error, "NOT_FOUND") ? (
            <EmptyState illustration="offline" size="compact" title={t("找不到這個 run")} description={t("{runId} 不存在或已被刪除。", { runId })} />
          ) : (
            <ErrorCallout error={query.error} title={t("無法讀取 run")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
          )}
        </DockBody>
      </>
    );
  }
  return (
    <>
      {back}
      {/* key：換到另一個 run 時重新建立（取消請求的結果等狀態屬於原本的 run） */}
      <RunBody key={query.data.run_id} run={query.data} lookup={lookup} pipelineId={pipelineId} />
    </>
  );
}

function RecentRuns({ pipelineId, onSelectRun }: { pipelineId: string | null; onSelectRun: (runId: string) => void }) {
  const runs = useRunList();
  const items = (runs.data?.pages[0]?.items ?? []).filter((run) => !pipelineId || run.request.pipeline.pipeline_id === pipelineId).slice(0, 12);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3 text-data font-semibold text-fg">
        <History aria-hidden className="size-4 text-fg-tertiary" />
        {pipelineId ? t("這個元件組合最近的 run") : t("最近的 run")}
      </div>
      <DockBody className="relative">
        {runs.isPending ? (
          <p role="status" className="px-3 py-4 text-body text-fg-secondary">
            {t("讀取 run 列表…")}
          </p>
        ) : runs.isError && !runs.data ? (
          <div className="p-3">
            <ErrorCallout error={runs.error} title={t("無法讀取 run 列表")} onRetry={() => void runs.refetch()} retrying={runs.isFetching} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<ListVideo />} size="compact" title={t("還沒有 run")} description={pipelineId ? t("在左邊填好輸入後按「建立 run」，結果會出現在這裡。") : t("先在左側選一個元件組合。")} />
        ) : (
          <ul aria-label={t("最近的 run")} className="">
            {items.map((run, index) => (
              <li key={run.run_id} ref={reveal(index)} className={"border-b border-line-subtle last:border-b-0"}>
                <button
                  type="button"
                  onClick={() => onSelectRun(run.run_id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset active:bg-sunken"
                  title={t("{value}（{created_at}）", { value: runDisplayName(run), created_at: formatTimestamp(run.created_at) })}
                >
                  <span className="truncate text-data text-fg">{runDisplayName(run)}</span>
                  <StatusBadge kind="run" value={run.state} />
                  <span className="machine col-span-2 truncate text-caption text-fg-tertiary">{`${run.run_id.slice(0, 8)} · ${formatTimestamp(run.created_at)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="px-3 py-3 text-caption text-fg-tertiary">{t("只列出 run 列表第一頁；完整清單在「紀錄・執行紀錄」。")}</p>
      </DockBody>
    </div>
  );
}
