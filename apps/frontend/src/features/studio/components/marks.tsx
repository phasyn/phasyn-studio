// State marks of Video Studio: a shot's status (empty, rendering, ready, needs update, failed, cancelled, interrupted)
// and a take's run state, as an icon plus label in the status colour; a change fades in.
import { Ban, CircleCheck, CircleDashed, CircleX, LoaderCircle, RefreshCcwDot, TriangleAlert, type LucideIcon } from "lucide-react";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { SHOT_STATUS_LABELS, type ShotStatus } from "../model/project";
import { t } from "@/i18n";

const STATUS_STYLE: Record<ShotStatus, { icon: LucideIcon; className: string }> = {
  empty: { icon: CircleDashed, className: "text-fg-tertiary" },
  rendering: { icon: LoaderCircle, className: "text-info [&_svg]:animate-spin" },
  ready: { icon: CircleCheck, className: "text-success" },
  stale: { icon: RefreshCcwDot, className: "text-warning" },
  failed: { icon: CircleX, className: "text-danger" },
  // As the run states show everywhere (components/common/statusSpec.ts): cancelled is neutral, interrupted a warning
  cancelled: { icon: Ban, className: "text-fg-secondary" },
  interrupted: { icon: TriangleAlert, className: "text-warning" },
};

export function ShotStatusMark({ status, compact = false, className }: { status: ShotStatus; compact?: boolean; className?: string }) {
  const style = STATUS_STYLE[status];
  const fade = useChangeFade<HTMLSpanElement>(status);
  return (
    <span ref={fade} className={cn("inline-flex shrink-0 items-center gap-1 text-caption whitespace-nowrap transition-colors duration-(--duration-base) [&_svg]:size-3.5", style.className, className)}>
      <style.icon aria-hidden />
      <span className={compact ? "sr-only" : undefined}>{SHOT_STATUS_LABELS[status]}</span>
    </span>
  );
}

const TAKE_STATE: Record<string, { label: string; status: ShotStatus }> = {
  rendering: { label: t("渲染中"), status: "rendering" },
  succeeded: { label: t("完成"), status: "ready" },
  failed: { label: t("失敗"), status: "failed" },
  cancelled: { label: t("已取消"), status: "cancelled" },
  interrupted: { label: t("已中斷"), status: "interrupted" },
};

export function TakeStateMark({ state, className }: { state: string; className?: string }) {
  const spec = TAKE_STATE[state] ?? { label: state, status: "empty" as ShotStatus };
  const style = STATUS_STYLE[spec.status];
  const fade = useChangeFade<HTMLSpanElement>(state);
  return (
    <span ref={fade} className={cn("inline-flex shrink-0 items-center gap-1 text-caption whitespace-nowrap transition-colors duration-(--duration-base) [&_svg]:size-3.5", style.className, className)}>
      <style.icon aria-hidden />
      {spec.label}
    </span>
  );
}
