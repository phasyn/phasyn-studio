import { hasSlotContent } from "@/lib/dom";
// The schema form's leaf inputs: numbers and scalar lists that keep the typed text while it does not parse yet, and the
// explicit null switches (beside an input, or in a field or fieldset header).
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { formatScalarList, parseScalarList } from "@/lib/schema";
import { t } from "@/i18n";

export function NumberControl({
  id,
  value,
  integer,
  emptyValue,
  onChange,
  disabled,
  describedBy,
  invalid,
  placeholder,
  compact = false,
}: {
  id: string;
  value: unknown;
  integer: boolean;
  emptyValue: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  describedBy?: string;
  invalid: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  const external = typeof value === "number" || typeof value === "string" ? String(value) : "";
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft?.base === external ? draft.text : external;
  return (
    <Input
      id={id}
      compact={compact}
      inputMode={integer ? "numeric" : "decimal"}
      className="machine"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        const raw = event.target.value;
        const trimmed = raw.trim();
        let next: unknown;
        if (trimmed === "") next = emptyValue;
        else {
          const parsed = Number(trimmed);
          next = Number.isFinite(parsed) ? parsed : raw;
        }
        setDraft({ base: typeof next === "number" || typeof next === "string" ? String(next) : "", text: raw });
        onChange(next);
      }}
    />
  );
}

/**
 * A scalar array as one comma-separated line. While typing, the raw text stays (a trailing comma included); a number
 * that does not parse stays a string for the schema check to flag.
 */
export function ListControl({
  id,
  value,
  itemKind,
  onChange,
  disabled,
  describedBy,
  invalid,
  placeholder,
  compact = false,
}: {
  id: string;
  value: unknown;
  itemKind: "string" | "integer" | "number";
  onChange: (next: unknown) => void;
  disabled?: boolean;
  describedBy?: string;
  invalid: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  const external = formatScalarList(value);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft?.base === external ? draft.text : external;
  return (
    <Input
      id={id}
      compact={compact}
      className="machine"
      value={text}
      disabled={disabled}
      placeholder={placeholder ?? (itemKind === "string" ? t("以逗號分隔，空白＝空陣列") : t("例如 0, 1（逗號分隔）"))}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => {
        const next = parseScalarList(event.target.value, itemKind);
        setDraft({ base: formatScalarList(next), text: event.target.value });
        onChange(next);
      }}
    />
  );
}

/** The explicit "null" switch beside a nullable scalar's input; while null, the input is disabled and shows null. */
export function NullToggle({
  checked,
  onChange,
  name,
  disabled,
  compact = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  name: string;
  disabled: boolean;
  compact?: boolean;
}) {
  return (
    <label
      className={cn(
        compact ? "min-h-8" : "min-h-10",
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 text-caption text-fg-secondary transition-colors duration-150 hover:border-line-strong",
        "has-[:checked]:border-action/60 has-[:checked]:bg-action/10 has-[:checked]:text-fg has-[:disabled]:cursor-not-allowed has-[:disabled]:text-fg-disabled",
      )}
    >
      <input
        type="checkbox"
        className="size-3.5 accent-action"
        checked={checked}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.checked); }}
        aria-label={t("{name} 設為 null", { name })}
      />
      <span className="machine">null</span>
    </label>
  );
}

/** The quieter "null" checkbox of a header (a JSON field's label row, a nullable object's legend). */
export function NullCheckbox({ checked, onChange, name, disabled }: { checked: boolean; onChange: (checked: boolean) => void; name: string; disabled: boolean }) {
  return (
    <label className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 text-caption font-normal text-fg-tertiary">
      <input
        type="checkbox"
        className="size-3.5 accent-action"
        checked={checked}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.checked); }}
        aria-label={t("{name} 設為 null", { name })}
      />
      <span className="machine">null</span>
    </label>
  );
}

/** An input with its null toggle beside it, or the input alone. */
export function NullableRow({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  if (!hasSlotContent(toggle)) return children;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      {toggle}
    </div>
  );
}
