// 步驟 3：caption.compile。中欄＝結果（training caption 與 generation prompt 並排）；
// 檢視器＝輸入 Scene、caption run、元件與參數（language、include_uncertain 預設 false），底部是「產生 caption」。
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Captions, Cpu, FileBraces, LoaderCircle, SlidersHorizontal } from "lucide-react";
import type { CaptionPair } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { ParametersEditor } from "@/components/common/ParametersEditor";
import { StatusBadge } from "@/components/common/StatusBadge";
import { IdText } from "@/components/common/values";
import { Button } from "@/components/ui/button";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { KindComponentSelect } from "@/features/pipelines";
import { CaptionPairView } from "@/features/runs";
import { FlowSection } from "@/components/flow/FlowSection";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { RunCreateError, RunSection, StepInspector } from "./StepFrame";
import type { CaptionStepState, SceneStepState } from "./useSemanticsSteps";
import { t } from "@/i18n";

/** 中欄：caption 結果；沒有結果時說明原因（尚未產生、執行中、成功但沒有輸出、失敗）。 */
export function CaptionWorkspace({
  captionRunId,
  captionRun,
  pair,
  sceneBlock,
  onNext,
}: {
  captionRunId: string | null;
  captionRun: UseQueryResult<WireRun>;
  pair: CaptionPair | null;
  sceneBlock: string | null;
  onNext: () => void;
}) {
  if (!(captionRunId != null && captionRunId !== "")) {
    return <EmptyState icon={<Captions />} title={t("尚未產生 caption")} description={(sceneBlock != null && sceneBlock !== "") ? t("目前還不能產生：{sceneBlock}。", { sceneBlock }) : t("在檢視器選擇 caption 元件與參數後按「產生 caption」。")} />;
  }
  const run = captionRun.data;
  if (!run) {
    return captionRun.isError ? (
      <p className="px-4 py-6 text-data text-danger">{t("無法讀取 caption run：錯誤細節與重新讀取在檢視器的「caption run」。")}</p>
    ) : (
      <p role="status" className="flex items-center gap-2 px-5 py-6 text-data text-fg-secondary">
        <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
        {t("讀取 caption run…")}
      </p>
    );
  }
  if (pair) {
    return (
      <div className="grid content-start p-5">
        <FlowSection
          id="semantics-caption-result-title"
          phase="result"
          title={t("training caption 與 generation prompt")}
          lit
          last
          actions={
            <Button size="sm" icon={<ArrowRight aria-hidden />} onClick={onNext}>
              {t("下一步：加入資料集")}
            </Button>
          }
        >
          <div className="animate-rise-in">
            <CaptionPairView pair={pair} />
          </div>
        </FlowSection>
      </div>
    );
  }
  return (
    <div className="grid max-w-3xl gap-2 px-5 py-6" role={run.state === "running" ? "status" : undefined}>
      <p className="flex flex-wrap items-center gap-2 text-data text-fg-secondary">
        <StatusBadge kind="run" value={run.state} />
        {run.state === "running" ? (
          <span>{t("caption.compile 執行中，自動更新；完成後在這裡並排顯示 training caption 與 generation prompt。")}</span>
        ) : run.state === "succeeded" ? (
          <span className="text-warning">{t("run 成功但沒有 caption.pair.v1 輸出。")}</span>
        ) : (
          <span>{t("沒有 caption 輸出：錯誤細節在檢視器的「caption run」；調整後可再產生一次（新的 run）。")}</span>
        )}
      </p>
      {run.state === "running" ? <ProgressTrack value={null} tone="running" label={t("caption 產生進度")} valueText={t("caption.compile 執行中")} /> : null}
    </div>
  );
}

/** 檢視器：輸入 Scene（另存的新檔／原 Scene／為何不能用）、caption run、元件與參數；底部「產生 caption」。 */
export function CaptionInspector({
  step,
  scene,
  captionRunId,
  captionRun,
}: {
  step: CaptionStepState;
  scene: SceneStepState;
  captionRunId: string | null;
  captionRun: UseQueryResult<WireRun>;
}) {
  const input = scene.captionScene;
  return (
    <StepInspector
      header={
        <EntityHeader
          icon={Captions}
          tone="info"
          title={t("Caption（caption.compile）")}
          status={captionRun.data ? <StatusBadge kind="run" value={captionRun.data.state} /> : null}
          description={t("從 Scene 組出 training caption 與 generation prompt。")}
          id={captionRunId}
        />
      }
      note={t("training caption 只用觀測事實；uncertain 事件預設排除；generation edits 只進入 generation prompt。")}
      actions={
        <>
          {(step.uploadError != null) ? <ErrorCallout error={step.uploadError} write title={t("無法送出 caption run")} /> : null}
          {step.create.isError ? <RunCreateError error={step.create.error} title={t("建立 caption run 失敗")} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              size="sm"
              icon={<Captions aria-hidden />}
              pending={step.pending}
              disabledReason={step.pending ? null : step.blockReason}
              onClick={() => void step.submit()}
            >
              {t("產生 caption")}
            </ActionButton>
          </div>
        </>
      }
    >
      <PropertySection title={t("輸入 Scene")} icon={<FileBraces aria-hidden />}>
        {input ? (
          <PropertyGrid>
            <PropertyRow label={t("來源")}>{scene.savedCurrent ? t("另存的新 Scene") : t("原 Scene（反推輸出）")}</PropertyRow>
            <PropertyRow label={t("傳遞")}>{"file" in input ? <IdText value={input.file.file_id} /> : <span>{t("inline Scene（依元件輸入埠需要時上傳成檔）")}</span>}</PropertyRow>
          </PropertyGrid>
        ) : (
          <p className="text-data text-warning">{scene.captionSceneBlock ?? t("沒有 Scene")}</p>
        )}
      </PropertySection>
      <RunSection title="caption run" runId={captionRunId} run={captionRun} label="caption.compile" emptyText={t("尚未產生 caption。")} errorTitle={t("無法讀取 caption run")} />
      <PropertySection title={t("元件")} icon={<Cpu aria-hidden />}>
        <KindComponentSelect id="caption-component" label={t("caption 元件（caption.compile）")} kind="caption.compile" value={step.choice} onChange={(value) => { step.setChoice(value); }} />
      </PropertySection>
      {step.descriptor ? (
        <PropertySection title={t("參數")} icon={<SlidersHorizontal aria-hidden />}>
          <ParametersEditor
            schema={step.schema}
            value={step.parameters}
            onChange={step.setParameters}
            idPrefix="caption-params"
            issues={step.issues}
            label={t("參數（language、include_uncertain 預設 false）")}
          />
        </PropertySection>
      ) : null}
    </StepInspector>
  );
}
