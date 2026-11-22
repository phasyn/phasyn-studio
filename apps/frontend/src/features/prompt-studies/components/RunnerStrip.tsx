// Runner status strip: the current step, the run it waits for (step progress and the latest preview, which is not the
// final result), stop (takes effect after the current run), cancelling the current run (the shared confirmation; one
// request, only this run's own processes) and why the runner stopped.
import { Ban, Info, LoaderCircle, Square, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { runSteps, type WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { pageFocusTarget } from "@/components/common/routeFocus";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { Button } from "@/components/ui/button";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { runPath } from "@/app/paths";
import { CircularProgress } from "@/components/common/CircularProgress";
import { HUD_CHIP } from "@/components/ui/look";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { cn } from "@/lib/cn";
import { runPreview } from "../model/ops";
import type { TaskRunner } from "../hooks/useTaskRunner";
import { t } from "@/i18n";

export function RunnerStrip({ runner }: { runner: TaskRunner }) {
  const state = runner.state;
  // The run being confirmed stays in the dialog even if the runner moves on meanwhile, with the button that asked: it
  // leaves with the busy state (the strip itself may go too), and focus then goes to the page title.
  const [confirming, setConfirming] = useState<{ run: WireRun; opener: HTMLElement } | null>(null);
  if (!state.busy && !(state.notice != null && state.notice !== "") && !(state.error != null) && !confirming) return null;
  const run = state.run;
  const steps = run ? runSteps(run) : [];
  const done = steps.filter((step) => step.state === "succeeded").length;
  const current = steps.find((step) => step.state === "running");
  const preview = run?.state === "running" ? runPreview(run) : null;

  return (
    <div className="grid shrink-0 gap-2 border-b border-line-subtle bg-canvas/40 px-4 py-2.5 animate-rise-in" aria-live="polite">
      {state.busy ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <LoaderCircle aria-hidden className="size-4 shrink-0 text-brand-cyan animate-spin" />
          <span className="min-w-0 flex-1 text-data font-medium text-fg">{state.description ?? t("執行中…")}</span>
          {(state.runId != null && state.runId !== "") ? (
            <Link to={runPath(state.runId)} className="machine text-caption" title={t("在執行紀錄開啟 run {runId}", { runId: state.runId })}>
              {`run ${state.runId.slice(0, 8)}`}
            </Link>
          ) : null}
          {steps.length > 0 ? <span className="machine text-caption text-fg-tertiary">{t("步驟 {done}/{stepsCount}{value}", { done, stepsCount: steps.length, value: current ? ` · ${current.step_id}` : "" })}</span> : null}
          {state.stopRequested ? <span className="text-caption text-warning">{t("會在目前的 run 結束後停止")}</span> : null}
          <div className="flex items-center gap-1">
            {state.mode !== "compile" ? (
              <Button size="sm" variant="secondary" icon={<Square aria-hidden />} disabled={state.stopRequested} onClick={runner.stop} title={t("目前的 run 結束、結果寫回後停止；不取消 run")}>
                {t("停止")}
              </Button>
            ) : null}
            {(state.runId != null && state.runId !== "") ? (
              <ActionButton
                size="sm"
                variant="danger"
                icon={<Ban aria-hidden />}
                disabledReason={run?.run_id === state.runId ? null : t("正在讀取這個 run 的狀態，讀到後才能取消")}
                onClick={(event) => {
                  if (run) setConfirming({ run, opener: event.currentTarget });
                }}
              >
                {t("取消 run…")}
              </ActionButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.busy ? (
        <ProgressTrack
          value={steps.length > 0 ? done : null}
          max={Math.max(1, steps.length)}
          tone="running"
          label={t("這一步的進度")}
          valueText={steps.length > 0 ? t("步驟 {done}/{stepsCount}", { done, stepsCount: steps.length }) : (state.description ?? t("執行中"))}
        />
      ) : null}
      {preview ? (
        <figure className="flex items-center gap-3">
          <GeneratingFrame active progress={preview.step !== null && preview.total !== null && preview.total > 0 ? preview.step / preview.total : null} className="size-28 shrink-0">
            <span className="relative block size-full overflow-hidden rounded-[inherit] bg-stage">
              <img key={preview.url} src={preview.url} alt={t("生成中的預覽（非最終結果）")} className="size-full object-contain animate-fade-in" />
              <span className="material-hud absolute top-1 right-1 grid place-items-center rounded-full border border-white/10 p-0.5">
                {preview.step !== null && preview.total !== null && preview.total > 0 ? (
                  <CircularProgress value={preview.step / preview.total} label={t("生成步數：第 {step}/{total} 步", { step: preview.step, total: preview.total })} size={20} />
                ) : (
                  <LoaderCircle aria-hidden className="size-5 text-brand-cyan animate-spin" />
                )}
              </span>
            </span>
          </GeneratingFrame>
          <figcaption className="grid gap-1 text-caption text-fg-tertiary">
            <span className={cn(HUD_CHIP, "w-fit border-warning/45 text-warning")}>{t("預覽（非最終結果）")}</span>
            {preview.step !== null && preview.total !== null ? <span className="machine">{t("第 {step}/{total} 步", { step: preview.step, total: preview.total })}</span> : null}
          </figcaption>
        </figure>
      ) : null}
      {!state.busy && (state.notice != null && state.notice !== "") ? (
        <p className="flex items-start gap-2 text-data text-fg-secondary">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
          <span className="min-w-0 flex-1">{state.notice}</span>
          <ToolButton label={t("關閉訊息")} icon={<X aria-hidden />} onClick={runner.clearMessages} />
        </p>
      ) : null}
      {(state.error != null) ? <ErrorCallout error={state.error} write title={t("這一步沒有完成")} /> : null}
      {confirming ? (
        <CancelRunDialog
          run={confirming.run}
          open
          onOpenChange={(open) => { if (!(open)) { setConfirming(null); } }}
          onCloseAutoFocus={(event) => { returnFocusOr(event, confirming.opener, pageFocusTarget()); }}
          scope={`${t("這一步會記為失敗，之後可以明確重試或結束任務。")} ${t("生成的 run 被取消也會計入圖片預算（不自動補抽）。")}`}
        />
      ) : null}
    </div>
  );
}
