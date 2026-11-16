// 步驟 1：來源影片與反推（video.describe）。中欄＝來源影片（上傳或挑選既有檔、預覽）與反推結果；
// 檢視器＝反推 run、元件、抽樣參數與「執行反推」。
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Cpu, FileBraces, ScanText, SlidersHorizontal } from "lucide-react";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { AssetPlayer } from "@/components/common/AssetPlayer";
import { ParametersEditor } from "@/components/common/ParametersEditor";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { EntityHeader, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { KindComponentSelect, TypedValueInput } from "@/features/pipelines";
import { FlowSection } from "@/components/flow/FlowSection";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { RunCreateError, RunSection, StepInspector } from "./StepFrame";
import type { DescribeStepState } from "./useSemanticsSteps";
import { t } from "@/i18n";

/** 分析：反推 run 的狀態（執行中顯示不確定進度；沒有步數證據時不編比例）。 */
function DescribeAnalysis({ describeRunId, describeRun }: { describeRunId: string | null; describeRun: UseQueryResult<WireRun> }) {
  if (!describeRunId) return <p className="text-data text-fg-tertiary">{t("尚未執行反推：在檢視器選擇元件與抽樣參數後按「執行反推」。也可從 run 明細的 Scene 輸出開啟此頁。")}</p>;
  const run = describeRun.data;
  if (!run) {
    return describeRun.isError ? (
      <p className="text-data text-danger">{t("無法讀取反推 run：錯誤細節與重新讀取在檢視器的「反推 run」。")}</p>
    ) : (
      <p role="status" className="text-data text-fg-secondary">
        {t("讀取反推 run…")}
      </p>
    );
  }
  const running = run.state === "running";
  return (
    <div className="grid max-w-3xl gap-2" role={running ? "status" : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-data text-fg-secondary">
        <StatusBadge kind="run" value={run.state} />
        <span>
          {running
            ? t("反推執行中，自動更新；完成後到「2. 編修 Scene」檢視。")
            : run.state === "succeeded"
              ? t("反推完成。")
              : t("反推沒有完成：錯誤細節在檢視器的「反推 run」；調整後可再執行一次（新的 run）。")}
        </span>
      </div>
      {running ? <ProgressTrack value={null} tone="running" label={t("反推進度")} valueText={t("反推執行中")} /> : null}
    </div>
  );
}

/** 結果：反推產生的 Scene（有的話可以直接到下一步）。 */
function DescribeResult({ describeRun, hasScene, onNext }: { describeRun: UseQueryResult<WireRun>; hasScene: boolean; onNext: () => void }) {
  if (hasScene) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-subtle bg-canvas px-3.5 py-3 animate-rise-in">
        <span aria-hidden className="grid size-8 place-items-center rounded-lg border border-success/40 bg-success/12 text-success">
          <FileBraces className="size-4" />
        </span>
        <span className="min-w-0 flex-1 text-data text-fg">{t("反推已產生 Scene（video.scene.v1）。")}</span>
        <Button size="sm" variant="secondary" icon={<ArrowRight aria-hidden />} onClick={onNext}>
          {t("下一步：編修 Scene")}
        </Button>
      </div>
    );
  }
  if (describeRun.data?.state === "succeeded") return <p className="text-data text-warning">{t("這個 run 沒有 video.scene.v1 輸出。")}</p>;
  return <p className="text-data text-fg-tertiary">{t("還沒有結果：反推完成後，Scene 會出現在這裡。")}</p>;
}

/** 中欄：輸入（來源影片與預覽）→ 分析（反推 run）→ 結果（Scene）。 */
export function DescribeWorkspace({
  step,
  describeRunId,
  describeRun,
  hasScene,
  onNext,
}: {
  step: DescribeStepState;
  describeRunId: string | null;
  describeRun: UseQueryResult<WireRun>;
  hasScene: boolean;
  onNext: () => void;
}) {
  const source = step.source;
  const running = describeRun.data?.state === "running";
  return (
    <div className="grid content-start p-5">
      <FlowSection id="semantics-source-title" phase="input" title={t("來源影片（media.video.v1）")} lit={Boolean(source)}>
        <TypedValueInput id="semantics-source" label={t("來源影片")} typeId="media.video.v1" transport="file" required value={source} onChange={(next) => step.setSource(next)} />
        {step.usingRunSource ? <p className="text-caption text-fg-tertiary">{t("沿用反推 run 的來源影片。")}</p> : null}
        {source && "file" in source ? (
          <AssetPlayer
            key={`${source.file.node_id}/${source.file.file_id}`}
            file={source.file}
            label="source"
            title={t("來源影片預覽")}
            showDownload={false}
            className="max-w-3xl overflow-hidden rounded-xl"
          />
        ) : null}
      </FlowSection>
      <FlowSection id="semantics-describe-analysis-title" phase="analysis" title={t("反推（video.describe）")} lit={running || hasScene}>
        <DescribeAnalysis describeRunId={describeRunId} describeRun={describeRun} />
      </FlowSection>
      <FlowSection id="semantics-describe-outcome-title" phase="result" title={t("反推結果")} lit={hasScene} last>
        <DescribeResult describeRun={describeRun} hasScene={hasScene} onNext={onNext} />
      </FlowSection>
    </div>
  );
}

/** 檢視器：反推 run 的事實、元件、抽樣參數；底部是「執行反推」（防重送、不自動重試）。 */
export function DescribeInspector({ step, describeRunId, describeRun }: { step: DescribeStepState; describeRunId: string | null; describeRun: UseQueryResult<WireRun> }) {
  const kind = step.descriptor ? providerKind(step.descriptor.provider_id) : null;
  return (
    <StepInspector
      header={
        <EntityHeader
          icon={kind?.icon ?? ScanText}
          tone={kind?.tone ?? "info"}
          title={t("反推（video.describe）")}
          status={describeRun.data ? <StatusBadge kind="run" value={describeRun.data.state} /> : null}
          description={t("從來源影片反推事件、主體與證據幀，輸出 Scene（video.scene.v1）。")}
          id={describeRunId}
        />
      }
      note={t("抽樣不改變原片 FPS，也不保證看見每個瞬間；局部重看請調整參數後再執行一次。")}
      actions={
        <>
          {step.create.isError ? <RunCreateError error={step.create.error} title={t("建立反推 run 失敗")} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              size="sm"
              icon={<ScanText aria-hidden />}
              pending={step.create.isPending}
              disabledReason={step.create.isPending ? null : step.blockReason}
              onClick={step.submit}
            >
              {t("執行反推")}
            </ActionButton>
          </div>
        </>
      }
    >
      <RunSection title={t("反推 run")} runId={describeRunId} run={describeRun} label="video.describe" emptyText={t("尚未執行反推。")} errorTitle={t("無法讀取反推 run")} />
      <PropertySection title={t("元件")} icon={<Cpu aria-hidden />}>
        <KindComponentSelect id="describe-component" label={t("反推元件（video.describe，任何 Node）")} kind="video.describe" value={step.choice} onChange={(value) => step.setChoice(value)} />
      </PropertySection>
      {step.descriptor ? (
        <PropertySection title={t("抽樣參數")} icon={<SlidersHorizontal aria-hidden />}>
          <ParametersEditor
            schema={step.schema}
            value={step.parameters}
            onChange={step.setParameters}
            idPrefix="describe-params"
            issues={step.issues}
            label={t("抽樣參數（預設 4 FPS、快動作 12 FPS、保留首尾）")}
          />
        </PropertySection>
      ) : null}
    </StepInspector>
  );
}
