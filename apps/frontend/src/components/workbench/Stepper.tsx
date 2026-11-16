import { Ban, Check, CircleSlash, TriangleAlert, Unplug } from "lucide-react";
import { Fragment } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * cancelled／interrupted＝已停止：步驟沒有做完，但不是錯誤（取消、或 Controller 重新啟動而中斷）。
 * skipped＝不會執行（例如沒有選這一步，或 run 在它開始前就因失敗而停止）：不是「尚未開始」，也不是完成。
 */
export type StepState = "done" | "active" | "pending" | "error" | "cancelled" | "interrupted" | "skipped";

export interface StepperStep {
  id: string;
  label: string;
  state: StepState;
  /** 一行補充（例如「3／5 段」、失敗原因摘要）；過長時截斷，完整文字在 title。 */
  detail?: string;
}

/** 給輔助技術的狀態（每一種是一整句，方便之後翻譯）。 */
const STATE_TEXT: Record<StepState, string> = {
  done: t("（已完成）"),
  active: t("（目前步驟）"),
  pending: t("（尚未開始）"),
  error: t("（有錯誤）"),
  cancelled: t("（已取消）"),
  interrupted: t("（已中斷）"),
  skipped: t("（已略過）"),
};


/**
 * 流程步驟（概念板的 Storyboard → Generate → Render）：水平排列的 `<ol>`，每步＝圓形節點（編號／完成勾／錯誤）＋名稱。
 * 目前步驟是深色操作漸層膠囊＋白字＋輕微光暈（aria-current="step"）；完成步驟之後的連接線以亮色品牌漸層點亮（表示進度，不表示成功）；
 * 錯誤用 danger 色與圖示；已停止的步驟不是錯誤，也不是尚未開始：取消用中性色、中斷用 warning 色（與 statusSpec 的 run 狀態
 * 一致），各有自己的圖示；略過的步驟外觀同尚未開始，節點改成略過圖示。狀態永遠也以文字提供給輔助技術（sr-only）。onSelect
 * 時每一步是按鈕（Tab 依序、Enter／Space 前往），否則只是呈現。空間不足時水平捲動，不擠壓文字。
 */
export function Stepper({
  steps,
  label = t("步驟"),
  onSelect,
  size = "md",
  className,
}: {
  steps: readonly StepperStep[];
  /** 清單的無障礙名稱。 */
  label?: string;
  /** 有值時步驟可以點選（例如回到某一步）。 */
  onSelect?: (id: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const small = size === "sm";
  return (
    // min-h-fit＋shrink-0：水平捲動的容器放在高度受限的 grid／flex 裡（例如對話框內容）時不會被壓扁
    <ol aria-label={label} className={cn("flex min-h-fit min-w-0 shrink-0 items-center overflow-x-auto", small ? "gap-1.5 py-0.5" : "gap-2 py-1", className)}>
      {steps.map((step, index) => {
        const next = steps[index + 1];
        const current = step.state === "active" ? ("step" as const) : undefined;
        const content = (
          <>
            <StepNode index={index} state={step.state} small={small} />
            <span className="grid min-w-0 text-left">
              <span className={cn("truncate font-medium", small ? "text-caption" : "text-data")}>{step.label}</span>
              {step.detail && !small ? (
                <span className={cn("truncate text-[11px] leading-4", step.state === "active" ? "text-[#fff]/80" : step.state === "error" ? "text-danger" : "text-fg-tertiary")}>
                  {step.detail}
                </span>
              ) : null}
            </span>
            <span className="sr-only">{STATE_TEXT[step.state]}</span>
          </>
        );
        const shell = cn(
          "relative flex min-w-0 shrink-0 items-center rounded-full border outline-none",
          "transition-[background-color,border-color,color,box-shadow] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)",
          small ? "max-w-48 gap-1.5 py-0.5 pr-2.5 pl-0.5" : "max-w-64 gap-2 py-1 pr-3.5 pl-1",
          step.state === "active"
            ? "border-transparent bg-action-gradient text-[#fff] shadow-glow-sm"
            : step.state === "error"
              ? "border-danger/45 bg-danger/10 text-danger"
              : step.state === "done"
                ? "border-line bg-surface text-fg-secondary"
                : step.state === "interrupted"
                  ? "border-warning/45 bg-warning/10 text-warning"
                  : step.state === "cancelled"
                    ? "border-line bg-transparent text-fg-secondary"
                    : "border-line-subtle bg-transparent text-fg-tertiary",
        );
        return (
          <Fragment key={step.id}>
            <li className="flex min-w-0 shrink-0 items-center">
              {onSelect ? (
                <button
                  type="button"
                  aria-current={current}
                  onClick={() => onSelect(step.id)}
                  title={step.detail ? t("{label}：{detail}", { label: step.label, detail: step.detail }) : step.label}
                  className={cn(
                    shell,
                    "pressable cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    step.state !== "active" && "hover:border-line-strong hover:bg-raised hover:text-fg",
                  )}
                >
                  {content}
                </button>
              ) : (
                <span className={shell} aria-current={current} title={step.detail ? t("{label}：{detail}", { label: step.label, detail: step.detail }) : undefined}>
                  {content}
                </span>
              )}
            </li>
            {next ? (
              <li aria-hidden className={cn("h-px min-w-4 flex-1", small ? "max-w-10" : "max-w-16")}>
                <span
                  className={cn(
                    "block h-full rounded-full transition-colors duration-(--duration-base)",
                    step.state === "done" ? "bg-brand-gradient" : "bg-line-strong",
                  )}
                />
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ol>
  );
}

function StepNode({ index, state, small }: { index: number; state: StepState; small: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "machine grid shrink-0 place-items-center rounded-full border font-semibold [&_svg]:shrink-0",
        small ? "size-5 text-[10px] [&_svg]:size-3" : "size-6 text-[11px] [&_svg]:size-3.5",
        state === "active"
          ? "border-transparent bg-[#fff] text-action-active"
          : state === "done"
            ? "border-action/50 bg-brand-soft text-action-fg"
            : state === "error"
              ? "border-danger/50 bg-danger/15 text-danger"
              : state === "interrupted"
                ? "border-warning/50 bg-warning/15 text-warning"
                : state === "cancelled"
                  ? "border-line-strong bg-sunken text-fg-secondary"
                  : "border-line-strong bg-sunken text-fg-tertiary",
      )}
    >
      {state === "done" ? <Check /> : state === "error" ? <TriangleAlert /> : state === "cancelled" ? <Ban /> : state === "interrupted" ? <Unplug /> : state === "skipped" ? <CircleSlash /> : index + 1}
    </span>
  );
}
