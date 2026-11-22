import { ListOrdered } from "lucide-react";
import type { RunStepView } from "@/api/types";
import { statusSpec } from "@/components/common/statusSpec";
import { providerKind } from "@/components/workbench/kinds";
import { Outliner } from "@/components/workbench/Outliner";
import { TreeView } from "@/components/workbench/TreeView";
import type { TreeItem } from "@/components/workbench/treeModel";
import type { DescriptorLookup } from "@/features/pipelines";
import { elapsedMs, formatElapsed, useNow } from "@/lib/time";
import { t } from "@/i18n";

/**
 * 左下「步驟」大綱：依開始時間排序的步驟（未開始的排最後），狀態點＋實測耗時；點選即在 Inspector 顯示。
 * 有步驟在執行時只有這個大綱每秒更新耗時（頁面其他部分不跟著重繪）。
 */
export function RunStepsOutliner({
  steps,
  lookup,
  selectedStepId,
  onSelect,
}: {
  steps: readonly RunStepView[];
  lookup: DescriptorLookup;
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
}) {
  const now = useNow(steps.some((step) => step.state === "running"));
  const ordered = [...steps].sort((a, b) => {
    if ((a.started_at != null && a.started_at !== "") && (b.started_at != null && b.started_at !== "")) return a.started_at.localeCompare(b.started_at);
    if (a.started_at != null && a.started_at !== "") return -1;
    if (b.started_at != null && b.started_at !== "") return 1;
    return 0;
  });
  const items: TreeItem[] = ordered.map((step) => {
    const descriptor = (step.node_id != null && step.node_id !== "") && (step.component_id != null && step.component_id !== "") ? lookup(step.node_id, step.component_id) : null;
    const kind = providerKind(descriptor?.provider_id);
    const state = statusSpec("step", step.state);
    const ms = elapsedMs(step.started_at, step.finished_at, step.state === "running" ? now : null);
    return {
      id: step.step_id,
      label: step.step_id,
      icon: kind.icon,
      iconTone: kind.tone,
      ...(ms === null ? {} : { detail: formatElapsed(ms) }),
      title: `${step.step_id} · ${step.component_id ?? "—"} · ${state.label}`,
      dot: state.tone,
      dotLabel: state.label,
    };
  });
  return (
    <Outliner title={t("步驟")} icon={<ListOrdered aria-hidden />} count={steps.length}>
      <TreeView items={items} label={t("run 的步驟")} selectedId={selectedStepId} expanded={new Set()} onToggle={() => undefined} onActivate={(item) => { onSelect(item.id); }} />
    </Outliner>
  );
}
