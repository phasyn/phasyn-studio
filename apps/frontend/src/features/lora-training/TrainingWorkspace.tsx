// 一個訓練工作：標頭（名稱、方向、狀態與動作）、七階段進度、四個分頁（進度／資料／比較／設定）。
// 執行中每 3 秒重讀；動作一次送出、不自動重送，送出中按鈕顯示進行中。
import { ArrowLeft, Ban, Database, GitCompareArrows, Play, Settings2, Square, TrendingDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { LoraTraining } from "@/api/generated/contracts";
import { PATHS } from "@/app/paths";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { DockBody } from "@/components/workbench/DockPanel";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { StatusChip } from "@/components/workbench/StatusChip";
import { Stepper } from "@/components/workbench/Stepper";
import { t } from "@/i18n";
import { useTraining } from "./api";
import { ClipsTab } from "./ClipsTab";
import { CompareTab } from "./CompareTab";
import { phaseSteps, progressDetail, STATUS_SPEC, trainingView } from "./model";
import { ProgressTab } from "./ProgressTab";
import { SettingsTab } from "./SettingsTab";
import { useAction } from "./useAction";

type TabId = "progress" | "data" | "compare" | "settings";

function defaultTab(job: LoraTraining): TabId {
  if (job.phase === "decide" || job.phase === "compare" || job.phase === "registered" || job.phase === "discarded") return "compare";
  if (job.phase === "select" && job.status === "review") return "data";
  return "progress";
}

function Actions({ job, action }: { job: LoraTraining; action: ReturnType<typeof useAction> }) {
  const view = trainingView(job);
  const canStop = (job.phase === "train" || job.phase === "compare") && (view?.loras.length ?? 0) > 0 && view?.stopRequested !== true && job.status !== "completed";
  const ended = job.phase === "decide" || job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "stopping";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {job.status === "paused" ? (
        <Button variant="primary" icon={<Play aria-hidden />} pending={action.pending === "resume"} onClick={() => void action.run({ action: "resume" })}>
          {t("繼續")}
        </Button>
      ) : null}
      {job.status === "review" && job.phase === "select" ? (
        <Button variant="primary" icon={<Play aria-hidden />} pending={action.pending === "start_training"} onClick={() => void action.run({ action: "start_training" })}>
          {t("開始訓練")}
        </Button>
      ) : null}
      {canStop ? (
        <Button icon={<Square aria-hidden />} pending={action.pending === "stop_training"} onClick={() => void action.run({ action: "stop_training" })} title={t("停在目前最新的 LoRA，直接做強度比較")}>
          {t("停止訓練並比較")}
        </Button>
      ) : null}
      {!ended ? (
        <Button variant="danger" icon={<Ban aria-hidden />} pending={action.pending === "cancel"} onClick={() => void action.run({ action: "cancel" })}>
          {t("取消")}
        </Button>
      ) : null}
    </div>
  );
}

function Workspace({ job }: { job: LoraTraining }) {
  const [tab, setTab] = useState<TabId>(() => defaultTab(job));
  const action = useAction(job.training_id);
  const status = STATUS_SPEC[job.status];
  const view = trainingView(job);
  const err = job.error as { message?: unknown } | null | undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="grid gap-3 border-b border-line-subtle px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <Link to={PATHS.training} className={buttonVariants({ variant: "quiet", size: "icon-sm" })} aria-label={t("回到訓練清單")}>
            <ArrowLeft aria-hidden />
          </Link>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-body font-semibold text-fg" title={job.name}>{job.name}</h1>
              <StatusChip tone={status.tone} label={status.label} spinning={status.spinning} />
            </span>
            <p className="line-clamp-2 text-data text-fg-secondary" title={job.direction}>{job.direction}</p>
          </div>
          <Actions job={job} action={action} />
        </div>
        <Stepper steps={phaseSteps(job, progressDetail(job, view))} label={t("訓練階段")} size="sm" />
        {job.status === "paused" || job.status === "failed" ? (
          <ErrorCallout error={{ message: typeof err?.message === "string" ? err.message : t("訓練停住了") }} title={job.status === "failed" ? t("訓練失敗") : t("訓練暫停了：按「繼續」重試這一步")} />
        ) : null}
        {action.error !== null ? <ErrorCallout error={action.error} write title={t("操作沒有成功")} /> : null}
      </header>
      <PanelTabs
        variant="underline"
        label={t("訓練工作分頁")}
        idPrefix={`training-${job.training_id}`}
        tabs={[
          { id: "progress", label: t("進度"), icon: TrendingDown },
          { id: "data", label: t("資料"), icon: Database },
          { id: "compare", label: t("強度比較"), icon: GitCompareArrows },
          { id: "settings", label: t("設定"), icon: Settings2 },
        ]}
        value={tab}
        onChange={setTab}
      />
      <DockBody className="p-4" role="tabpanel" id={`training-${job.training_id}-panel-${tab}`} aria-labelledby={`training-${job.training_id}-tab-${tab}`}>
        {tab === "progress" ? <ProgressTab job={job} /> : null}
        {tab === "data" ? <ClipsTab job={job} /> : null}
        {tab === "compare" ? <CompareTab job={job} /> : null}
        {tab === "settings" ? <SettingsTab job={job} /> : null}
      </DockBody>
    </div>
  );
}

export function TrainingWorkspace({ trainingId }: { trainingId: string }) {
  const query = useTraining(trainingId);
  if (query.data) return <Workspace job={query.data} />;
  return (
    <DockBody className="p-4">
      {query.isError ? (
        <ErrorCallout error={query.error} title={t("無法開啟這個訓練工作")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        <p role="status" className="text-data text-fg-secondary">{t("讀取中…")}</p>
      )}
    </DockBody>
  );
}
