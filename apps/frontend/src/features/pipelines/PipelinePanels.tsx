import { ArrowUpRight, CircleAlert, CircleCheck, FileInput, ListTree, SearchX, Trash, TriangleAlert } from "lucide-react";
import type { WirePipeline } from "@/api/types";
import { CommitInput } from "@/components/common/CommitInput";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { StatusChip } from "@/components/workbench/StatusChip";
import { DockBody } from "@/components/workbench/DockPanel";
import { EntityHeader, PropertyGrid, PropertyRow, PropertySection } from "@/components/workbench/Inspector";
import { providerKind, typeTone } from "@/components/workbench/kinds";
import { Outliner } from "@/components/workbench/Outliner";
import { CHIP_TONE } from "@/components/workbench/tones";
import { TreeView } from "@/components/workbench/TreeView";
import type { TreeItem } from "@/components/workbench/treeModel";
import { cn } from "@/lib/cn";
import { exportNameError, outputValue, parseOutputValue, removeExport, renameExport, retargetExport, type DescriptorLookup, type PipelineIssue } from "./pipelineModel";
import { selectionValue, type PipelineSelection } from "./selection";
import { tServer, t } from "@/i18n";

const GROUPS = { inputs: "group:inputs", steps: "group:steps", outputs: "group:outputs" } as const;

/** 左下「元件組合大綱」：輸入、步驟（類型圖示＋問題點）、流程輸出（標在接點上的徽章）；點選＝選取（圖、Inspector 同步）。 */
export function PipelineOutline({
  pipeline,
  lookup,
  issues,
  selection,
  onSelect,
}: {
  pipeline: WirePipeline;
  lookup: DescriptorLookup;
  issues: readonly PipelineIssue[];
  selection: PipelineSelection | null;
  onSelect: (next: PipelineSelection) => void;
}) {
  const items: TreeItem[] = [
    {
      id: GROUPS.inputs,
      label: t("輸入"),
      icon: FileInput,
      count: pipeline.inputs.length,
      children: pipeline.inputs.map((input) => ({
        id: `input:${input.name}`,
        label: input.name,
        icon: FileInput,
        iconTone: typeTone(input.type_id),
        detail: input.type_id,
        title: `${input.name} · ${input.type_id}${input.required ? t("（必填）") : ""}`,
      })),
    },
    {
      id: GROUPS.steps,
      label: t("步驟"),
      icon: ListTree,
      count: pipeline.steps.length,
      children: pipeline.steps.map((step) => {
        const kind = providerKind(lookup(step.node_id, step.component_id)?.provider_id);
        const own = issues.filter((issue) => issue.stepId === step.step_id);
        const errors = own.filter((issue) => issue.severity === "error").length;
        return {
          id: `step:${step.step_id}`,
          label: step.step_id,
          icon: kind.icon,
          iconTone: kind.tone,
          detail: step.component_id || t("未選元件"),
          title: `${step.step_id} · ${step.component_id || t("未選元件")}${own.length ? `\n${own.map((issue) => issue.message).join("\n")}` : ""}`,
          dot: errors > 0 ? "danger" : own.length > 0 ? "warning" : null,
          dotLabel: errors > 0 ? t("{errors} 個錯誤", { errors }) : own.length > 0 ? t("{ownCount} 個提醒", { ownCount: own.length }) : undefined,
        } satisfies TreeItem;
      }),
    },
    {
      id: GROUPS.outputs,
      label: t("流程輸出"),
      icon: ArrowUpRight,
      count: Object.keys(pipeline.outputs).length,
      children: Object.entries(pipeline.outputs).map(([name, target]) => {
        const missing = !pipeline.steps.some((step) => step.step_id === target.from_step);
        return {
          id: `output:${name}`,
          label: name,
          icon: ArrowUpRight,
          detail: `${target.from_step}.${target.output}`,
          title: `${name} ← ${target.from_step}.${target.output}${missing ? t("\n來源步驟不存在") : ""}`,
          dot: missing ? "danger" : null,
          dotLabel: missing ? t("來源步驟不存在") : undefined,
        } satisfies TreeItem;
      }),
    },
  ];
  return (
    <Outliner title={t("元件組合大綱")} icon={<ListTree aria-hidden />} count={pipeline.steps.length}>
      <TreeView
        items={items}
        label={t("元件組合大綱")}
        selectedId={selectionValue(selection)}
        expanded={new Set(Object.values(GROUPS))}
        onToggle={() => undefined}
        onActivate={(item) => {
          const at = item.id.indexOf(":");
          const kind = item.id.slice(0, at);
          if (kind === "input" || kind === "step" || kind === "output") onSelect({ kind, id: item.id.slice(at + 1) });
        }}
      />
    </Outliner>
  );
}

/** Inspector：選取的流程輸入（型別、必填、哪些步驟使用它）。 */
export function InputInspector({ pipeline, name }: { pipeline: WirePipeline; name: string }) {
  const input = pipeline.inputs.find((item) => item.name === name);
  if (!input) return <EmptyState size="compact" icon={<SearchX />} title={t("找不到流程輸入「{name}」：可能已改名或移除。", { name })} />;
  const consumers = pipeline.steps.flatMap((step) =>
    Object.entries(step.inputs)
      .filter(([, binding]) => "from_input" in binding && binding.from_input === name)
      .map(([port]) => `${step.step_id}.${port}`),
  );
  const tone = typeTone(input.type_id);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader icon={FileInput} tone={tone} title={<code className="machine">{input.name}</code>} description={t("流程輸入（建立 run 時填入）")} />
      <DockBody>
        <PropertySection title={t("定義")}>
          <PropertyGrid>
            <PropertyRow label="type_id">
              <span className={cn("machine w-fit rounded-full border px-2 text-caption", CHIP_TONE[tone])}>{input.type_id}</span>
            </PropertyRow>
            <PropertyRow label={t("必填")}>{input.required ? t("是") : t("否")}</PropertyRow>
            <PropertyRow label={t("傳輸")} mono>
              {input.transport}
            </PropertyRow>
            <PropertyRow label={t("說明")}>{tServer(input.description) || "—"}</PropertyRow>
            <PropertyRow label={t("使用者")} hint={consumers.length === 0 ? t("還沒有步驟接到這個輸入。") : undefined}>
              {consumers.length > 0 ? (
                <span className="grid gap-0.5">
                  {consumers.map((consumer) => (
                    <code key={consumer} className="machine">
                      {consumer}
                    </code>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </PropertyRow>
          </PropertyGrid>
          <p className="mt-2 text-caption text-fg-tertiary">{t("名稱、型別與說明在中間的「步驟與接線」→「流程輸入」編輯。")}</p>
        </PropertySection>
      </DockBody>
    </div>
  );
}

/**
 * Inspector：選取的流程輸出（節點圖上標在產生它的步驟輸出接點：「↗ 名稱」）。可改名、改來源步驟／輸出埠、移除；
 * 都只改草稿，按「儲存元件組合」才保存。
 */
export function OutputInspector({
  pipeline,
  name,
  lookup,
  onChange,
  onSelect,
}: {
  pipeline: WirePipeline;
  name: string;
  lookup: DescriptorLookup;
  onChange: (next: WirePipeline) => void;
  onSelect: (next: PipelineSelection | null) => void;
}) {
  const target = pipeline.outputs[name];
  if (!target) return <EmptyState size="compact" icon={<SearchX />} title={t("找不到流程輸出「{name}」：可能已改名或移除。", { name })} />;
  const source = pipeline.steps.find((step) => step.step_id === target.from_step);
  const typeId = source ? (lookup(source.node_id, source.component_id)?.outputs.find((port) => port.name === target.output)?.type_id ?? null) : null;
  const value = outputValue(target.from_step, target.output);
  const options = pipeline.steps.flatMap((step) =>
    (lookup(step.node_id, step.component_id)?.outputs ?? []).map((port) => ({ value: outputValue(step.step_id, port.name), label: `${step.step_id}.${port.name} · ${port.type_id}` })),
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col animate-rise-in">
      <EntityHeader
        icon={ArrowUpRight}
        tone={typeTone(typeId)}
        title={<code className="machine">{name}</code>}
        description={t("流程輸出：標在產生它的步驟輸出接點上；run 完成後列在 run 的輸出")}
      />
      <DockBody>
        <PropertySection title={t("定義")}>
          <PropertyGrid>
            <PropertyRow label={t("名稱")} htmlFor="output-inspector-name">
              <CommitInput
                id="output-inspector-name"
                label={t("流程輸出名稱")}
                value={name}
                onCommit={(next) => {
                  const error = exportNameError(pipeline, name, next);
                  if (error) return error;
                  onChange(renameExport(pipeline, name, next));
                  onSelect({ kind: "output", id: next });
                  return null;
                }}
              />
            </PropertyRow>
            <PropertyRow label={t("來源")} htmlFor="output-inspector-source">
              <Select
                compact
                id="output-inspector-source"
                value={value}
                onChange={(event) => {
                  const parsed = parseOutputValue(event.target.value);
                  if (parsed) onChange(retargetExport(pipeline, name, { from_step: parsed.stepId, output: parsed.output }));
                }}
              >
                {!options.some((option) => option.value === value) ? (
                  <option value={value}>
                    {t("{from_step}.{output}（{value}）", { from_step: target.from_step, output: target.output, value: source ? t("未知元件") : t("步驟不存在") })}
                  </option>
                ) : null}
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </PropertyRow>
            <PropertyRow label="type_id" mono hint={typeId ? undefined : source ? t("來源步驟是未知元件，無法確認型別。") : t("來源步驟不存在：請改選來源或移除。")}>
              {typeId ?? t("未知")}
            </PropertyRow>
          </PropertyGrid>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" disabled={!source} onClick={() => onSelect({ kind: "step", id: target.from_step })}>
              {t("選取來源步驟")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash aria-hidden />}
              onClick={() => {
                onChange(removeExport(pipeline, name));
                onSelect(null);
              }}
            >
              {t("移除流程輸出")}
            </Button>
          </div>
          <p className="mt-2 text-caption text-fg-tertiary">{t("移除只是不再列為流程輸出；步驟仍會產生這個輸出，run 明細照樣看得到。修改都在草稿中，儲存後才生效。")}</p>
        </PropertySection>
      </DockBody>
    </div>
  );
}

/** 底部「問題」分頁：前端接線檢查的錯誤與提醒；點步驟名稱即選取該步驟。 */
export function IssuesPanel({ issues, onSelectStep }: { issues: readonly PipelineIssue[]; onSelectStep: (stepId: string) => void }) {
  if (issues.length === 0) {
    return (
      <p className="flex items-start gap-2 px-4 py-3 text-data text-success animate-fade-in">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{t("前端檢查沒有發現接線問題（型別、必填、循環）；伺服器建立 run 時仍會再檢查。")}</span>
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ul aria-label={t("接線問題")} className="grid">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.stepId ?? ""}-${issue.port ?? ""}-${index}`} className="flex min-h-7 items-start gap-2 border-b border-line-subtle px-3 py-1.5 text-data">
            {issue.severity === "error" ? (
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" />
            ) : (
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            )}
            <StatusChip tone={issue.severity === "error" ? "danger" : "warning"} label={issue.severity === "error" ? t("錯誤") : t("提醒")} />
            <code className="machine shrink-0 text-caption text-fg-tertiary">{issue.code}</code>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-fg-secondary">{issue.message}</span>
            {issue.stepId ? (
              <button
                type="button"
                onClick={() => onSelectStep(issue.stepId ?? "")}
                title={t("選取步驟 {stepId}", { stepId: issue.stepId })}
                className="pressable machine shrink-0 rounded-md px-1.5 text-caption text-action-fg outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-focus active:bg-sunken"
              >
                {issue.stepId}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
