import { StatusChip } from "@/components/workbench/StatusChip";
import { statusSpec, type StatusKind } from "./statusSpec";

const SPINNING = new Set(["loading", "running", "stopping"]);

/** 狀態 chip：點＋文字（進行中改用旋轉圖示），不只靠顏色。 */
export function StatusBadge({ kind, value, className }: { kind: StatusKind; value: string; className?: string }) {
  const spec = statusSpec(kind, value);
  return <StatusChip tone={spec.tone} label={spec.label} spinning={SPINNING.has(value)} {...(className === undefined ? {} : { className })} />;
}
