// The thin DiT step meter shared by the stage matrix cell and the DiT cards: completed steps of the total, drawn only
// with both known (never a made-up share). Running = brand gradient (with a sweeping highlight when live); ended = the
// state colour (only a failure is red; cancelled and interrupted are warnings, as on the queue's segmented bar).
import { METER_FILL, METER_TRACK, SHIMMER } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import type { DitProgress } from "../../model/progress";
import { t } from "@/i18n";

export type MeterTone = "info" | "success" | "warning" | "danger";

/**
 * 已完成步數／總步數的細進度條；總步數或完成數未知時不畫（不顯示假的進度）。執行中＝品牌漸層（live 時 shimmer 高光掃過）；
 * 結束後依結果用狀態色。
 */
export function StepMeter({ progress, tone, label, live = false, className }: { progress: DitProgress; tone: MeterTone; label: string; live?: boolean; className?: string }) {
  if (progress.total === null || progress.completed === null) return null;
  const done = Math.min(progress.completed, progress.total);
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={done}
      aria-valuetext={t("已完成 {done}／{total} 步", { done, total: progress.total })}
      className={cn(METER_TRACK, className)}
    >
      <span
        className={cn(METER_FILL, tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning/60" : cn("bg-brand-gradient", live && SHIMMER))}
        style={{ width: `${(done / progress.total) * 100}%` }}
      />
    </span>
  );
}
