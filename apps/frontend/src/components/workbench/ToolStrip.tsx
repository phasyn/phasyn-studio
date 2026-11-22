import { hasSlotContent } from "@/lib/dom";
import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/** 工具列（40 px）：篩選、搜尋、頁面動作；左右兩群用 `ml-auto` 分開。ref 指向工具列本身（例如給 useFitLevel 量寬度）。 */
export function ToolStrip({ label, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { label: string; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle px-2 py-1", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function ToolSeparator({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-0.5 h-5 w-px shrink-0 bg-line-subtle", className)} />;
}

export interface ToolButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** 無障礙名稱與 tooltip（繁中）。 */
  label: string;
  icon: ReactNode;
  /** 切換型按鈕的狀態（aria-pressed）。 */
  pressed?: boolean;
  /** 停用原因：顯示在 title，按鈕保持可聚焦（aria-disabled）。 */
  disabledReason?: string | null;
  /** 圖示旁顯示文字（工具列空間足夠時）。 */
  text?: ReactNode;
}

/** 28 px 圖示按鈕；停用時保留焦點，原因寫在 title 並以 aria-describedby 告知輔助技術。按下時縮小並以彈簧回彈（pressable）；切換中＝品牌淡底＋細框。 */
export function ToolButton(
  { ref, label, icon, pressed, disabledReason, text, className, onClick, title, type = "button", ...props }: ToolButtonProps & { ref?: Ref<HTMLButtonElement> | undefined },
) {
  const reasonId = useId();
  const blocked = Boolean(disabledReason);
  return (
    <>
      <button
        ref={ref}
        type={type}
        aria-label={hasSlotContent(text) ? undefined : label}
        aria-pressed={pressed}
        aria-disabled={blocked || undefined}
        title={blocked ? t("{label}：{value}", { label, value: disabledReason ?? "" }) : (title ?? label)}
        onClick={blocked ? undefined : onClick}
        className={cn(
          "pressable inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-data text-fg-secondary [&_svg]:size-4 [&_svg]:shrink-0",
          "hover:bg-raised hover:text-fg active:bg-sunken",
          "aria-pressed:bg-brand-soft aria-pressed:text-fg aria-pressed:shadow-[inset_0_0_0_1px_rgb(62_137_255_/_0.35)] aria-pressed:[&_svg]:text-action-fg",
          "aria-disabled:cursor-not-allowed aria-disabled:text-fg-disabled aria-disabled:hover:bg-transparent",
          className,
        )}
        {...props}
        aria-describedby={blocked ? reasonId : props["aria-describedby"]}
      >
        {icon}
        {hasSlotContent(text) ? <span className="whitespace-nowrap">{text}</span> : null}
      </button>
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}
