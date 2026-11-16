// 鏡頭設定表單共用的欄位：標籤列與數字欄位（屬性面板與渲染引擎的生成設定共用）。
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

// Seed 與時長：各占半欄並排；時長選單最長的選項在半欄放不下時（依實際文字寬度，不分語言）時長換到下一列，兩欄都改為整列寬。
// 兩欄的 basis 都是半欄（扣掉一半 gap），時長另以 min-w-max 要求選單完整寬度：放得下＝並排且等寬，放不下＝換行。
export const HALF_FIELD = "grow basis-[calc(50%-0.25rem)]";

export function Row({ label, htmlFor, children, hint, className }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  // content-start：並排的欄位被同列較高的欄位撐高時，列不跟著拉長，標籤與輸入框維持對齊
  return (
    <div className={cn("grid min-w-0 content-start gap-1", className)}>
      <label htmlFor={htmlFor} className="text-caption font-medium text-fg-secondary">
        {label}
      </label>
      {children}
      {hint ? <div className="text-caption text-fg-tertiary">{hint}</div> : null}
    </div>
  );
}

/** 數字欄位：輸入期間保留草稿，Enter 或離開時才驗證並送出；不合法時保留輸入並顯示原因。 */
export function NumberField({
  id,
  value,
  onCommit,
  min,
  max,
  placeholder,
  allowEmpty = false,
  integer = false,
  className,
  describedBy,
}: {
  id: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min: number;
  max: number;
  placeholder?: string;
  allowEmpty?: boolean;
  integer?: boolean;
  className?: string;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (text === "" && allowEmpty) {
      onCommit(null);
    } else {
      const parsed = Number(text);
      if (text === "" || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
        setError(t("請輸入 {min}–{max} 之間的{value}", { min, max, value: integer ? t("整數") : t("數字") }));
        return;
      }
      onCommit(parsed);
    }
    setDraft(null);
    setError(null);
  };
  const described = [describedBy, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <span className={cn("grid gap-1", className)}>
      <Input
        id={id}
        compact
        inputMode={integer ? "numeric" : "decimal"}
        value={shown}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(null);
            setError(null);
          }
        }}
        className="machine"
      />
      {error ? (
        <span id={`${id}-error`} className="text-caption text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
