import { isNonzeroNumber } from "@/lib/json";
import { hasSlotContent } from "@/lib/dom";
// 屬性面板的欄位：標籤列（固定的說明放在標籤旁的 ⓘ，不常駐在欄位下方）、數字欄位（輸入期間保留草稿，Enter 或離開時
// 才驗證並送出；不合法時保留輸入並說明）、分段選擇（原生 radio：方向鍵切換、Tab 一個停駐點；選取的底塊用 snappy 彈簧滑到
// 新選項，按下有 pressable 回饋）。
import { useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/controls";
import { useThumb } from "@/components/flow/useThumb";
import { cn } from "@/lib/cn";
import { InfoTip } from "./InfoTip";
import { t } from "@/i18n";

export function Row({
  label,
  htmlFor,
  children,
  hint,
  info,
  actions,
  id,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  /** 與狀態有關的一行（例如快到字數上限）；固定的說明用 info。 */
  hint?: ReactNode;
  /** 欄位的固定說明：標籤旁的 ⓘ 提示（標籤是文字時才有，提示的名稱用它）。 */
  info?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <div className="flex min-h-5 items-center gap-1">
        <label id={id} htmlFor={htmlFor} className="text-caption font-medium text-fg-secondary">
          {label}
        </label>
        {hasSlotContent(info) && typeof label === "string" ? (
          <InfoTip label={label} className="-my-0.5">
            {info}
          </InfoTip>
        ) : null}
        {hasSlotContent(actions) ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </div>
      {children}
      {hasSlotContent(hint) ? <div className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{hint}</div> : null}
    </div>
  );
}

export function NumberField({
  id,
  value,
  onCommit,
  min,
  max,
  placeholder,
  allowEmpty = false,
  integer = false,
  multiple,
  describedBy,
  disabled = false,
  className,
  label,
}: {
  id: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min: number;
  max: number;
  placeholder?: string;
  allowEmpty?: boolean;
  integer?: boolean;
  /** 必須是這個數的倍數（例如尺寸 16）。 */
  multiple?: number;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
  /** 沒有可見標籤時的無障礙名稱。 */
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  /** The value `text` stands for when it is valid (null = empty and allowed), undefined when it is not. */
  const parse = (text: string): number | null | undefined => {
    if (text === "" && allowEmpty) return null;
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed)) || (multiple !== undefined && parsed % multiple !== 0)) return undefined;
    return parsed;
  };
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (text === "" && allowEmpty) {
      onCommit(null);
    } else {
      const parsed = Number(text);
      const kind = isNonzeroNumber(multiple) ? t("{multiple} 的倍數", { multiple }) : integer ? t("整數") : t("數字");
      if (text === "" || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed)) || (multiple !== undefined && parsed % multiple !== 0)) {
        setError(t("請輸入 {min}–{max} 之間的{kind}", { min, max, kind }));
        return;
      }
      onCommit(parsed);
    }
    setDraft(null);
    setError(null);
  };
  const described = [describedBy, (error != null && error !== "") ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <span className={cn("grid gap-1", className)}>
      <Input
        id={id}
        compact
        inputMode={integer || Boolean(multiple) ? "numeric" : "decimal"}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={(error != null && error !== "") ? true : undefined}
        aria-describedby={described}
        onChange={(event) => {
          // A valid value takes effect as it is typed: "Generate" (or Ctrl+Enter) right after typing must use it, not the
          // value from before. An incomplete value stays a draft until it is valid or the field loses focus.
          const text = event.target.value;
          setDraft(text);
          const next = parse(text.trim());
          if (next !== undefined && next !== value) {
            onCommit(next);
            setError(null);
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape" && draft !== null) {
            event.stopPropagation();
            setDraft(null);
            setError(null);
          }
        }}
        className="machine"
      />
      {(error != null && error !== "") ? (
        <span id={`${id}-error`} role="alert" className="text-caption text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
}

/** 分段選擇：一組原生 radio（方向鍵切換），外觀是 macOS 式的分段控制（選取的底塊滑動）。 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
  labelledBy,
  disabled = false,
  className,
}: {
  name: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  useThumb(groupRef, thumbRef, "[data-selected]");
  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} aria-labelledby={labelledBy} className={cn("relative inline-flex min-w-0 rounded-lg border border-line-control/70 bg-sunken p-0.5", className)}>
      <span
        ref={thumbRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-md border border-white/[0.07] bg-overlay opacity-0 shadow-[0_1px_2px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.06)] transition-[transform,width,height,opacity] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)"
      />
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <label
            key={option.value}
            title={option.title}
            data-selected={selected || undefined}
            className={cn(
              "pressable relative z-[1] inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-caption whitespace-nowrap has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus has-disabled:cursor-not-allowed [&_svg]:size-3.5",
              selected ? "font-medium text-fg [&_svg]:text-brand-cyan" : "text-fg-tertiary hover:text-fg-secondary",
            )}
          >
            <input type="radio" name={name} value={option.value} checked={selected} disabled={disabled} onChange={() => { onChange(option.value); }} className="sr-only" />
            {option.icon}
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

/** 擋下生成的原因或提醒的一行（圖示＋文字）。 */
export function Hint({ tone, icon, children }: { tone: "warning" | "danger" | "info" | "muted"; icon?: ReactNode; children: ReactNode }) {
  const color = { warning: "text-warning", danger: "text-danger", info: "text-info", muted: "text-fg-tertiary" }[tone];
  return (
    <p className={cn("flex items-start gap-1.5 text-caption [overflow-wrap:anywhere] [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0", color)}>
      {icon}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
