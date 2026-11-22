// The pipeline editor's inspector: the selected step (edited in place), a pipeline input or output, or — with nothing
// selected — the pipeline's own properties and the front-end checks.
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { CircleAlert, Workflow } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { WirePipeline } from "@/api/types";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/controls";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { providerKind } from "@/components/workbench/kinds";
import { StatusChip } from "@/components/workbench/StatusChip";
import { InputInspector, OutputInspector } from "./PipelinePanels";
import type { DescriptorLookup, PipelineIssue } from "./pipelineModel";
import type { PipelineSelection } from "./selection";
import { StepEditor } from "./StepEditor";
import { t } from "@/i18n";

/** The StepEditor props for the step at an index (shared by the step list and the inspector). */
export type StepBinding = Omit<ComponentProps<typeof StepEditor>, "variant" | "appear">;

function StepInspector({ binding, lookup, issues }: { binding: StepBinding; lookup: DescriptorLookup; issues: readonly PipelineIssue[] }) {
  const { step } = binding;
  const descriptor = step.node_id && step.component_id ? lookup(step.node_id, step.component_id) : null;
  const kind = providerKind(descriptor?.provider_id);
  const own = issues.filter((issue) => issue.stepId === step.step_id);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={kind.icon}
        {...(kind.art === undefined ? {} : { art: kind.art })}
        tone={kind.tone}
        title={<code className="machine">{step.step_id}</code>}
        status={descriptor ? <StatusBadge kind="component" value={descriptor.state} /> : <StatusChip tone="warning" label={step.component_id ? t("未知元件") : t("未選 instance")} />}
        description={
          <>
            {descriptor ? `${kind.label} · ` : null}
            <code className="machine">{step.component_id || t("未選 instance")}</code>
            {own.length > 0 ? <span className="ml-1 text-danger">{t("· {ownCount} 個問題", { ownCount: own.length })}</span> : null}
          </>
        }
      />
      <DockBody>
        <StepEditor variant="inspector" {...binding} />
      </DockBody>
    </div>
  );
}

function PropertiesInspector({
  pipeline,
  isNew,
  idField,
  idTaken,
  onLabelChange,
  errors,
  warnings,
}: {
  pipeline: WirePipeline;
  isNew: boolean;
  idField: ReactNode;
  idTaken: boolean;
  onLabelChange: (label: string) => void;
  errors: readonly PipelineIssue[];
  warnings: readonly PipelineIssue[];
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader icon={Workflow} tone="action" title={pipeline.label || pipeline.pipeline_id} description={t("元件組合屬性；選取步驟、流程輸入或流程輸出（接點上的徽章）可在這裡編輯它。")} id={isNew ? null : pipeline.pipeline_id} />
      <DockBody>
        <PropertySection title={t("基本")}>
          <PropertyGrid>
            <PropertyRow label="pipeline_id" {...(isNew ? { htmlFor: "pipeline-id" } : {})} hint={isNew ? undefined : t("已保存的元件組合不可改 ID；可另存新元件組合。")}>
              {idField}
              {idTaken ? <span className="text-caption text-warning">{t("已有同 ID 的元件組合：儲存會覆寫它。")}</span> : null}
            </PropertyRow>
            <PropertyRow label={t("名稱")} htmlFor="pipeline-label">
              <Input compact id="pipeline-label" value={pipeline.label} onChange={(event) => { onLabelChange(event.target.value); }} />
            </PropertyRow>
            <PropertyRow label={t("步驟")} mono>
              {pipeline.steps.length}
            </PropertyRow>
            <PropertyRow label={t("輸入／輸出")} mono>
              {t("{inputsCount}／{outputsCount}", { inputsCount: pipeline.inputs.length, outputsCount: Object.keys(pipeline.outputs).length })}
            </PropertyRow>
          </PropertyGrid>
        </PropertySection>
        <PropertySection title={t("檢查")} icon={<CircleAlert aria-hidden />} count={errors.length + warnings.length}>
          {errors.length > 0 ? (
            <Callout tone="danger" title={t("{errorsCount} 個錯誤（接線或呼叫參數；執行時伺服器會以 422 拒絕，儲存前會先確認）", { errorsCount: errors.length })}>
              <ul className="grid gap-1">
                {withOccurrenceKeys(errors, (issue) => issue.message).map(({ item: issue, key }) => (
                  <li key={key}>
                    <span className="machine text-caption text-fg-tertiary">{issue.code}</span> {issue.message}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : (
            <p className="text-caption text-success">{t("前端檢查沒有發現錯誤（型別、必填、循環、呼叫參數的 parameters_schema）；伺服器仍會再檢查。")}</p>
          )}
          {warnings.length > 0 ? (
            <ul className="mt-2 grid gap-1 text-caption text-warning">
              {withOccurrenceKeys(warnings, (issue) => issue.message).map(({ item: issue, key }) => (
                <li key={key}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
        </PropertySection>
      </DockBody>
    </div>
  );
}

export function PipelineInspector({
  pipeline,
  selection,
  select,
  lookup,
  issues,
  errors,
  warnings,
  selectedStep,
  isNew,
  idField,
  idTaken,
  onChange,
}: {
  pipeline: WirePipeline;
  selection: PipelineSelection | null;
  select: (next: PipelineSelection | null) => void;
  lookup: DescriptorLookup;
  issues: readonly PipelineIssue[];
  errors: readonly PipelineIssue[];
  warnings: readonly PipelineIssue[];
  /** The selected step's binding and stable key (a rename keeps the key, so the inputs keep focus). */
  selectedStep: { key: string; binding: StepBinding } | null;
  isNew: boolean;
  idField: ReactNode;
  idTaken: boolean;
  onChange: (next: WirePipeline) => void;
}) {
  // Choosing another step remounts the inspector and fades it in.
  if (selectedStep) return <StepInspector key={selectedStep.key} binding={selectedStep.binding} lookup={lookup} issues={issues} />;
  if (selection?.kind === "input") return <InputInspector pipeline={pipeline} name={selection.id} />;
  if (selection?.kind === "output") return <OutputInspector pipeline={pipeline} name={selection.id} lookup={lookup} onChange={onChange} onSelect={select} />;
  return (
    <PropertiesInspector
      pipeline={pipeline}
      isNew={isNew}
      idField={idField}
      idTaken={idTaken}
      onLabelChange={(label) => { onChange({ ...pipeline, label }); }}
      errors={errors}
      warnings={warnings}
    />
  );
}
