// The numeric gain readout under a fader. It shows the gain and can be typed into: Enter or leaving the field commits,
// Esc restores the value. Text that is not a gain inside the range keeps the field open and marked, with the reason in
// its tooltip; leaving the field then restores the value. A typed gain also counts as an editor draft, so saving
// (Ctrl / ⌘ + S) commits it first.
import { useRef, useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useEditorDraft } from "../../drafts";
import { formatDb, GAIN_MAX_DB, GAIN_MIN_DB, parseDb } from "./decibels";

export interface GainFieldProps {
  /** Name of what the gain belongs to (the field's accessible name). */
  label: string;
  /** Gain in dB. */
  value: number;
  onCommit: (db: number) => void;
  className?: string;
}

interface Draft {
  text: string;
  invalid: boolean;
}

/** The typed gain when it is one inside the range, else null. */
function typedGain(text: string): number | null {
  const db = parseDb(text);
  return db !== null && db >= GAIN_MIN_DB && db <= GAIN_MAX_DB ? db : null;
}

export function GainField({ label, value, onCommit, className }: GainFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Set while Enter or Esc has already settled the draft, so the blur that follows does not apply it again
  const settledRef = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  /** Commits the draft; false (and the field marked) when it is not a valid gain. */
  const apply = (): boolean => {
    if (!draft) return true;
    const db = typedGain(draft.text);
    if (db === null) {
      setDraft({ ...draft, invalid: true });
      return false;
    }
    setDraft(null);
    if (db !== value) onCommit(db);
    return true;
  };
  const leave = () => {
    settledRef.current = true;
    inputRef.current?.blur();
  };
  useEditorDraft({ commit: apply, focus: () => inputRef.current?.focus() });

  return (
    <input
      ref={inputRef}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={t("{label}（dB）", { label })}
      aria-invalid={(draft?.invalid === true) ? true : undefined}
      title={(draft?.invalid === true) ? t("請輸入 {min} 到 +{max} 之間的 dB 值", { min: formatDb(GAIN_MIN_DB), max: GAIN_MAX_DB }) : t("{label}：{value} dB（可直接輸入）", { label, value: formatDb(value) })}
      value={draft ? draft.text : formatDb(value)}
      onFocus={(event) => {
        settledRef.current = false;
        setDraft({ text: formatDb(value).replace("−", "-"), invalid: false });
        event.currentTarget.select();
      }}
      onChange={(event) => { setDraft({ text: event.target.value, invalid: false }); }}
      onBlur={() => {
        if (settledRef.current) return;
        if (!apply()) setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (apply()) leave();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
          leave();
        }
      }}
      className={cn(
        "machine h-7 w-full min-w-0 rounded-md border border-line-subtle bg-sunken px-1 text-center text-caption text-fg outline-none transition-colors duration-(--duration-fast)",
        "hover:border-line-strong focus-visible:border-focus aria-invalid:border-danger aria-invalid:text-danger",
        className,
      )}
    />
  );
}
