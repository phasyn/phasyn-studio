// 換角介面的小元件：數字欄位（輸入期間保留草稿，Enter 或離開時才驗證並送出；不合法時保留輸入並顯示原因）、事實清單。
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export function NumberField({
  id,
  value,
  onCommit,
  min,
  max,
  integer = false,
  allowEmpty = false,
  placeholder,
  describedBy,
  className,
  label,
}: {
  id: string;
  value: number | null;
  onCommit: (value: number | null) => void;
  min: number;
  max: number;
  integer?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
  describedBy?: string;
  className?: string;
  /** 沒有可見標籤時的無障礙名稱。 */
  label?: string;
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
    <span className={cn("grid min-w-0 gap-1", className)}>
      <Input
        id={id}
        compact
        inputMode={integer ? "numeric" : "decimal"}
        value={shown}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape" && draft !== null) {
            event.stopPropagation();
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

export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-data", className)}>{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** 區段：13 px 標題列（品牌青圖示＋文字）＋內容。 */
export function Section({ title, icon, children, actions, className }: { title: string; icon: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn("grid min-w-0 gap-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="text-brand-cyan/80 [&_svg]:size-4">
          {icon}
        </span>
        <h3 className="text-data font-semibold text-fg-secondary">{title}</h3>
        {actions ? <div className="ml-auto flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** 不擋流程的提醒或擋下的原因清單（顏色之外一律有圖示與文字）。 */
export function NoteList({ tone, items, icon, title }: { tone: "warning" | "danger" | "info"; items: readonly string[]; icon: ReactNode; title?: string }) {
  if (items.length === 0) return null;
  const tones = { warning: "border-warning/40 bg-warning/10 text-warning", danger: "border-danger/40 bg-danger/10 text-danger", info: "border-line-strong bg-sunken text-fg-secondary" } as const;
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={cn("grid gap-1 rounded-lg border px-3 py-2 text-caption", tones[tone])}>
      {title ? (
        <p className="flex items-center gap-1.5 font-medium [&_svg]:size-3.5">
          {icon}
          {title}
        </p>
      ) : null}
      <ul className="grid gap-0.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-1.5 [overflow-wrap:anywhere] [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            {title ? null : icon}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
