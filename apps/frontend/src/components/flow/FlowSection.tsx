import { hasSlotContent } from "@/lib/dom";
// 反推頁的流程區段：輸入 → 分析 → 結果。左側一條細的流程線串起區段，每段有節點與「輸入／分析／結果」眉標，
// 讓「放什麼進去、模型在做什麼、得到什麼」一眼分清。結果有內容時節點亮起（品牌漸層＋柔和光暈），其他維持中性；
// 區段內容本身（表單、表格、圖片）維持清晰，不加光暈。
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { EN_LABEL } from "@/components/ui/look";
import { t } from "@/i18n";

export type FlowPhase = "input" | "analysis" | "result";

const PHASE: Record<FlowPhase, { label: string; en: string }> = {
  input: { label: t("輸入"), en: "Input" },
  analysis: { label: t("分析"), en: "Analysis" },
  result: { label: t("結果"), en: "Result" },
};

export function FlowSection({
  id,
  phase,
  title,
  lit = false,
  last = false,
  actions,
  children,
  className,
}: {
  /** 標題的 id（區段以 aria-labelledby 命名）。 */
  id: string;
  phase: FlowPhase;
  title: ReactNode;
  /** 這一段已有內容（例如反推已產生 Scene）：節點亮起。 */
  lit?: boolean;
  /** 最後一段：流程線不往下延伸。 */
  last?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const spec = PHASE[phase];
  return (
    <section aria-labelledby={id} className={cn("relative grid min-w-0 gap-3 pb-6 pl-7", last && "pb-0", className)}>
      {last ? null : <span aria-hidden className="absolute top-5 bottom-0 left-[7px] w-px bg-linear-to-b from-line-strong to-line-subtle" />}
      <span
        aria-hidden
        className={cn(
          "absolute top-1 left-0 grid size-[15px] place-items-center rounded-full border transition-[background-color,border-color,box-shadow] duration-(--duration-base)",
          lit ? "border-transparent bg-brand-gradient shadow-glow-sm" : "border-line-strong bg-surface",
        )}
      >
        <span className={cn("size-1.5 rounded-full", lit ? "bg-on-accent" : "bg-line-strong")} />
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-baseline gap-1.5 text-caption font-medium text-fg-tertiary">
          {spec.label}
          <span aria-hidden className={cn(EN_LABEL, lit ? "text-brand-cyan/80" : "text-fg-disabled")}>
            {spec.en}
          </span>
        </p>
        <h2 id={id} className="min-w-0 text-section font-semibold text-fg [overflow-wrap:anywhere]">
          {title}
        </h2>
        {hasSlotContent(actions) ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="grid min-w-0 gap-3">{children}</div>
    </section>
  );
}
