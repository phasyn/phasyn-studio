import { ChevronDown } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

// 輸入欄位：凹陷底＋控制邊界（line-control ≥ 3:1）；hover 邊框亮一階；焦點＝青色外框（取代邊框位置）＋淡淡的品牌藍光環。
const fieldBase =
  "w-full min-w-0 rounded-md border border-line-control bg-sunken text-body text-fg transition-[border-color,box-shadow,color] duration-(--duration-fast) placeholder:text-fg-tertiary hover:border-fg-tertiary focus-visible:outline-offset-0 focus-visible:shadow-[0_0_0_4px_rgb(79_123_255_/_0.18)] aria-invalid:border-danger disabled:cursor-not-allowed disabled:border-line-strong disabled:text-fg-disabled";
const textEntry = "read-only:border-line read-only:text-fg-secondary";

/** compact：工作台屬性格與工具列用的 32 px 控制（13 px 字）。 */
export interface CompactProp {
  compact?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & CompactProp>(function Input(
  { className, compact = false, ...props },
  ref,
) {
  return (
    <input ref={ref} className={cn(fieldBase, textEntry, compact ? "min-h-8 px-2.5 py-1 text-data" : "min-h-10 px-3 py-2", className)} {...props} />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & CompactProp>(function Textarea(
  { className, compact = false, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldBase, textEntry, compact ? "min-h-16 resize-y px-2.5 py-1.5 text-data" : "min-h-28 resize-y px-3 py-2 leading-7", className)}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & CompactProp>(function Select(
  { className, children, compact = false, ...props },
  ref,
) {
  return (
    <div className="relative min-w-0">
      <select
        ref={ref}
        className={cn(fieldBase, "appearance-none", compact ? "min-h-8 py-1 pr-8 pl-2.5 text-data" : "min-h-10 py-2 pr-9 pl-3", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-tertiary", compact ? "right-2.5 size-3.5" : "right-3 size-4")}
      />
    </div>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  description?: string;
}

/** 原生 checkbox；整個標籤列都是點擊目標（≥40px 高）。 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, description, id, ...props },
  ref,
) {
  return (
    <label htmlFor={id} className={cn("flex min-h-10 cursor-pointer items-start gap-3 py-2 text-body text-fg-secondary", className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className="mt-1 size-4 shrink-0 cursor-pointer accent-action disabled:cursor-not-allowed"
        {...props}
      />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        {description ? <span className="block text-caption text-fg-tertiary">{description}</span> : null}
      </span>
    </label>
  );
});

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role"> {
  label: string;
  description?: string;
  /** 屬性格內使用：標籤只給輔助技術（列的 label 欄已顯示同樣文字），高度 32 px。 */
  hideLabel?: boolean;
}

/** 以原生 checkbox 為基礎的開關（role="switch"）：開啟時軌道是深色操作漸層、白色滑塊以 snappy 彈簧滑過去（對比 ≥ 5:1）；停用且開啟時仍保留可見的滑塊。 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, label, description, id, hideLabel = false, ...props },
  ref,
) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 text-body has-disabled:cursor-not-allowed",
        hideLabel ? "min-h-8 py-1" : "min-h-10 py-2",
        className,
      )}
    >
      <span className="relative inline-flex shrink-0">
        <input ref={ref} id={id} type="checkbox" role="switch" className="peer sr-only" {...props} />
        <span
          aria-hidden
          className="h-5 w-9 rounded-full border border-line-control bg-sunken transition-[background-color,border-color] duration-(--duration-fast) peer-checked:border-transparent peer-checked:bg-action-gradient peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:border-line-subtle peer-disabled:bg-raised peer-disabled:bg-none"
        />
        <span
          aria-hidden
          className="absolute top-0.75 left-0.75 size-3.5 rounded-full bg-fg-secondary shadow-[0_1px_2px_rgb(0_0_0_/_0.4)] transition-[translate,background-color] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy) peer-checked:translate-x-4 peer-checked:bg-[#fff] peer-disabled:bg-fg-disabled"
        />
      </span>
      <span className={cn("min-w-0", hideLabel && "sr-only")}>
        <span className="text-fg">{label}</span>
        {description ? <span className="block text-caption text-fg-tertiary">{description}</span> : null}
      </span>
    </label>
  );
});
