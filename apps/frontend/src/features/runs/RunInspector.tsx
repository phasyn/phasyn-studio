import { Clock, Code2, ExternalLink, FileInput, ListVideo, LoaderCircle, PackageOpen } from "lucide-react";
import { Link } from "react-router";
import { asTypedValueMap, type RunStepView, type WireRun } from "@/api/types";
import { ErrorCallout, RemoteUnknownNotice } from "@/components/common/ErrorCallout";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { JsonView } from "@/components/common/JsonView";
import { StatusBadge } from "@/components/common/StatusBadge";
import { IdText, TimeText } from "@/components/common/values";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import type { DescriptorLookup } from "@/features/pipelines";
import { Elapsed } from "./Elapsed";
import { stepErrorTitle } from "./runModel";
import { TypedValueView } from "./TypedValueView";
import { recordingPath, runPath } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** Inspector：選取的步驟（狀態、時間、call、紀錄、錯誤、輸出、設定快照）。 */
export function StepInspector({
  step,
  run,
  nodeLabel,
  lookup,
}: {
  step: RunStepView;
  run: WireRun;
  nodeLabel: string;
  lookup: DescriptorLookup;
}) {
  const descriptor = (step.node_id != null && step.node_id !== "") && (step.component_id != null && step.component_id !== "") ? lookup(step.node_id, step.component_id) : null;
  const kind = providerKind(descriptor?.provider_id);
  const outputs = Object.entries(step.outputs);
  const error = step.error ? { ...step.error, remote_outcome_unknown: step.error.remote_outcome_unknown === true || step.remote_outcome_unknown } : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={kind.icon}
        {...(kind.art === undefined ? {} : { art: kind.art })}
        tone={kind.tone}
        title={<code className="machine">{step.step_id}</code>}
        status={<StatusBadge kind="step" value={step.state} />}
        description={
          <>
            {descriptor ? `${kind.label} · ` : null}
            <code className="machine">{step.component_id ?? "—"}</code> · {nodeLabel || "—"}
          </>
        }
        id={step.call_id}
      />
      <DockBody>
        <PropertySection title={t("時間與紀錄")} icon={<Clock aria-hidden />}>
          <PropertyGrid>
            <PropertyRow label={t("開始")}>
              <TimeText iso={step.started_at} />
            </PropertyRow>
            <PropertyRow label={t("結束")}>
              <TimeText iso={step.finished_at} />
            </PropertyRow>
            <PropertyRow label={t("耗時")} mono>
              <Elapsed start={step.started_at} end={step.finished_at} running={step.state === "running"} />
            </PropertyRow>
            <PropertyRow label="call_id">
              <IdText value={step.call_id} length={12} />
            </PropertyRow>
            <PropertyRow label={t("紀錄")}>
              {(step.recording_id != null && step.recording_id !== "") ? (
                <Link to={recordingPath(step.recording_id)} className="inline-flex items-center gap-1">
                  recording {step.recording_id.slice(0, 8)}
                  <ExternalLink aria-hidden className="size-3.5" />
                </Link>
              ) : (
                <span className="text-fg-tertiary">{step.state === "running" ? t("步驟結束後才有") : "—"}</span>
              )}
            </PropertyRow>
            <PropertyRow label="load revision" mono>
              {step.load_revision === null ? "—" : `#${String(step.load_revision)}`}
            </PropertyRow>
          </PropertyGrid>
          {error ? <ErrorCallout error={error} title={stepErrorTitle(step)} className="mt-3" /> : null}
          {!error && step.remote_outcome_unknown ? <RemoteUnknownNotice className="mt-3" /> : null}
        </PropertySection>
        <PropertySection title={t("輸出")} icon={<PackageOpen aria-hidden />} count={outputs.length}>
          {outputs.length > 0 ? (
            <div className="grid gap-2">
              {outputs.map(([port, value]) => (
                <TypedValueView key={port} name={`${step.step_id}.${port}`} value={value} run={run} usage="output" />
              ))}
            </div>
          ) : step.state === "running" ? (
            // 生成中只畫外框與狀態文字（沒有假的輸出）。
            <GeneratingFrame active className="bg-sunken px-3 py-4">
              <p role="status" className="flex items-center gap-2 text-caption text-fg-secondary">
                <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-info animate-spin" />
                {t("步驟完成後顯示輸出。")}
              </p>
            </GeneratingFrame>
          ) : (
            <p className="text-caption text-fg-tertiary">{step.state === "succeeded" ? t("此步驟沒有輸出。") : t("步驟完成後顯示輸出。")}</p>
          )}
        </PropertySection>
        {step.settings ? (
          <PropertySection title={t("設定快照（requested／effective／observed）")} icon={<Code2 aria-hidden />} defaultOpen={false}>
            <JsonView value={step.settings} label={`${step.step_id} effective context`} maxHeightClass="max-h-72" />
          </PropertySection>
        ) : null}
      </DockBody>
    </div>
  );
}

/** Inspector：沒有選取步驟時顯示 run 本身（請求、來源、輸入）。 */
export function RunFacts({ run, title }: { run: WireRun; title: string }) {
  const inputs = Object.entries(asTypedValueMap(run.request.inputs));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={ListVideo}
        tone="action"
        title={title}
        status={<StatusBadge kind="run" value={run.state} />}
        description={
          <T source={"流程 <0>{pipeline_id}</0> · {stepsCount} 個步驟"} values={{ pipeline_id: run.request.pipeline.pipeline_id, stepsCount: run.request.pipeline.steps.length }} slots={[<code key="slot-0" className="machine" />]} />
        }
        id={run.run_id}
      />
      <DockBody>
        <PropertySection title={t("請求")} icon={<ListVideo aria-hidden />}>
          <PropertyGrid>
            <PropertyRow label={t("流程名稱")}>{run.request.pipeline.label || "—"}</PropertyRow>
            <PropertyRow label={t("建立")}>
              <TimeText iso={run.created_at} />
            </PropertyRow>
            <PropertyRow label={t("結束")}>
              <TimeText iso={run.finished_at} />
            </PropertyRow>
            <PropertyRow label="recordings" mono>
              {t("{recording_idsCount} 筆", { recording_idsCount: run.recording_ids.length })}
            </PropertyRow>
            <PropertyRow label={t("來源（origin）")}>
              {run.request.origin ? (
                <span className="grid gap-0.5">
                  {(run.request.origin.source_run_id != null && run.request.origin.source_run_id !== "") ? (
                    <Link to={runPath(run.request.origin.source_run_id)}>{t("來源 run {source_run_id}", { source_run_id: run.request.origin.source_run_id.slice(0, 8) })}</Link>
                  ) : null}
                  {(run.request.origin.preview_asset_id != null && run.request.origin.preview_asset_id !== "") ? <span className="machine">{t("草稿 asset {preview_asset_id}", { preview_asset_id: run.request.origin.preview_asset_id.slice(0, 8) })}</span> : null}
                  {(run.request.origin.note != null && run.request.origin.note !== "") ? <span>{t("備註：{note}", { note: run.request.origin.note })}</span> : null}
                </span>
              ) : (
                "—"
              )}
            </PropertyRow>
          </PropertyGrid>
        </PropertySection>
        <PropertySection title={t("輸入")} icon={<FileInput aria-hidden />} count={inputs.length}>
          {inputs.length === 0 ? (
            <p className="text-caption text-fg-tertiary">{t("沒有輸入。")}</p>
          ) : (
            <div className="grid gap-2">
              {inputs.map(([name, value]) => (
                <TypedValueView key={name} name={name} value={value} run={run} usage="input" />
              ))}
            </div>
          )}
        </PropertySection>
        <p className="px-3 py-3 text-caption text-fg-tertiary">{t("在中間的圖、清單或左下的步驟大綱選一個步驟，這裡會顯示它的時間、紀錄與輸出。")}</p>
      </DockBody>
    </div>
  );
}
