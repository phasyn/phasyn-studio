// 狀態與類型標記（圖示＋文字，顏色只是第二線索）：圖片狀態、take 狀態、路由能力與精度、Qwen-Image 元件類型。
import { Ban, CircleCheck, CircleDashed, CircleX, ImagePlus, LoaderCircle, RefreshCcwDot, TriangleAlert, Type, type LucideIcon } from "lucide-react";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { MODE_LABELS, variantLabel } from "../model/constants";
import { IMAGE_STATUS_LABELS, type ImageShotStatus } from "../model/shots";
import type { ImageMode, ImageTakeState } from "../types";
import { t } from "@/i18n";

const STATUS_STYLE: Record<ImageShotStatus, { icon: LucideIcon; className: string }> = {
  empty: { icon: CircleDashed, className: "text-fg-tertiary" },
  rendering: { icon: LoaderCircle, className: "text-info [&_svg]:animate-spin" },
  ready: { icon: CircleCheck, className: "text-success" },
  stale: { icon: RefreshCcwDot, className: "text-warning" },
  // As the run states show everywhere (components/common/statusSpec.ts): cancelled is neutral, interrupted a warning
  cancelled: { icon: Ban, className: "text-fg-secondary" },
  interrupted: { icon: TriangleAlert, className: "text-warning" },
  failed: { icon: CircleX, className: "text-danger" },
  not_sent: { icon: TriangleAlert, className: "text-danger" },
};

export function ShotStatusMark({ status, compact = false, className }: { status: ImageShotStatus; compact?: boolean; className?: string }) {
  const style = STATUS_STYLE[status];
  const fade = useChangeFade<HTMLSpanElement>(status);
  return (
    <span ref={fade} className={cn("inline-flex shrink-0 items-center gap-1 text-caption whitespace-nowrap transition-colors duration-(--duration-base) [&_svg]:size-3.5", style.className, className)}>
      <style.icon aria-hidden />
      <span className={compact ? "sr-only" : undefined}>{IMAGE_STATUS_LABELS[status]}</span>
    </span>
  );
}

const TAKE_STATE: Record<ImageTakeState, { label: string; status: ImageShotStatus }> = {
  rendering: { label: t("生成中"), status: "rendering" },
  succeeded: { label: t("完成"), status: "ready" },
  failed: { label: t("失敗"), status: "failed" },
  cancelled: { label: t("已取消"), status: "cancelled" },
  interrupted: { label: t("已中斷"), status: "interrupted" },
};

export function TakeStateMark({ state, compact = false, className }: { state: ImageTakeState; compact?: boolean; className?: string }) {
  const spec = TAKE_STATE[state];
  const style = STATUS_STYLE[spec.status];
  const fade = useChangeFade<HTMLSpanElement>(state);
  return (
    <span ref={fade} className={cn("inline-flex shrink-0 items-center gap-1 text-caption whitespace-nowrap transition-colors duration-(--duration-base) [&_svg]:size-3.5", style.className, className)}>
      <style.icon aria-hidden />
      <span className={compact ? "sr-only" : undefined}>{spec.label}</span>
    </span>
  );
}

/** 文生圖／圖生圖的能力標記（mono 名稱＋圖示，title 是中文）。 */
export function ModeBadge({ mode, className }: { mode: ImageMode; className?: string }) {
  const Icon = mode === "i2i" ? ImagePlus : Type;
  return (
    <span title={t("{mode}：{mode2}", { mode, mode2: MODE_LABELS[mode] })} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-1.5 text-caption text-fg-secondary [&_svg]:size-3", className)}>
      <Icon aria-hidden />
      <span className="machine">{mode}</span>
      <span className="sr-only">{t("（{mode}）", { mode: MODE_LABELS[mode] })}</span>
    </span>
  );
}

/** DiT 精度（BF16／GGUF）。 */
export function VariantBadge({ variant, className }: { variant: string | null; className?: string }) {
  return (
    <span title={t("DiT 元件的精度設定（provider_options.variant）")} className={cn("inline-flex shrink-0 items-center rounded-full border border-entity/30 bg-entity/12 px-1.5 text-caption text-entity", className)}>
      <span className="machine">{variantLabel(variant)}</span>
    </span>
  );
}

export function ReadyDot({ ready, className }: { ready: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full transition-[background-color,box-shadow] duration-(--duration-base)",
        ready ? "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-success)_18%,transparent)]" : "bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-warning)_16%,transparent)]",
        className,
      )}
    />
  );
}
