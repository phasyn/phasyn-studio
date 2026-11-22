import { hasSlotContent } from "@/lib/dom";
// The fields of the editor's property panels: numbers and text that commit on blur or Enter (and with Save, through
// the draft registry), choices, switches, segmented controls and colors, in the density of the panel they stand in.
// A field of a locked track is read-only and says why in its tooltip. A refused value keeps its text; the reason
// takes a line of its own under the row (the fields render it as a sibling, so the row's flex or grid places it).
import { use, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Input, Select, Switch, Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { DensityContext, FieldLockContext, type Density } from "./controlsContext";
import { handleNumberKey, useNumberDraft, useTextDraft, type CommitHandler } from "./useFieldDraft";

/** Quieter than a form field: rows of these sit close together. */
const QUIET = "border-line-strong";
const INPUT_SIZE: Record<Density, string> = { compact: "h-6.5 min-h-0 px-1.5 py-0 text-data", comfortable: "h-8 min-h-0 px-2 py-0 text-data" };
const SELECT_SIZE: Record<Density, string> = { compact: "h-6.5 min-h-0 py-0 pr-7 pl-1.5 text-data", comfortable: "h-8 min-h-0 py-0 pr-8 pl-2 text-data" };
const NUMBER_WIDTH: Record<Density, string> = { compact: "w-18", comfortable: "w-20" };
const SUFFIX = "w-6 shrink-0 text-caption whitespace-nowrap text-fg-tertiary";

function FieldError({ id, error }: { id: string; error: string }) {
  return (
    <p id={id} role="alert" className="order-last col-span-full basis-full text-caption text-danger">
      {t("{error}（Esc 還原）", { error })}
    </p>
  );
}

function tooltip(label: string, reason: string | null, hint: string | undefined): string {
  return reason ?? ((hint != null && hint !== "") ? t("{label}：{hint}", { label, hint }) : label);
}

export interface NumberFieldProps {
  /** The field's name (assistive technology and tooltip). */
  label: string;
  value: number;
  min: number;
  max: number;
  /** Decimals shown; 0 (the default) accepts whole numbers only. */
  decimals?: number;
  /** What an arrow key adds or takes away. */
  step?: number;
  /** The unit after the field; "" keeps its place empty so a column of fields stays aligned. */
  suffix?: string;
  onCommit: CommitHandler<number>;
  disabledReason?: string | null;
  /** A fact about the field, shown in its tooltip. */
  hint?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Width of the input when the default does not fit. */
  className?: string;
}

export function NumberField({ label, value, min, max, decimals = 0, step = 1, suffix, onCommit, disabledReason, hint, inputRef, className }: NumberFieldProps) {
  const id = useId();
  const density = use(DensityContext);
  const locked = use(FieldLockContext);
  const reason = locked ?? disabledReason ?? null;
  const [fieldRef, draft] = useNumberDraft({ value, min, max, decimals, step, onCommit, disabledReason: reason, ...(inputRef === undefined ? {} : { inputRef }) });
  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1">
        <Input
          ref={fieldRef}
          compact
          aria-label={label}
          title={tooltip(label, reason, hint)}
          inputMode={decimals === 0 ? "numeric" : "decimal"}
          value={draft.text}
          className={cn("machine text-right", QUIET, INPUT_SIZE[density], NUMBER_WIDTH[density], ((reason != null && reason !== "") ? "cursor-not-allowed" : reason), className)}
          readOnly={reason !== null}
          aria-disabled={(reason != null && reason !== "") ? true : undefined}
          aria-invalid={(draft.error != null && draft.error !== "") ? true : undefined}
          aria-describedby={(draft.error != null && draft.error !== "") ? `${id}-error` : undefined}
          onChange={(event) => { draft.setText(event.target.value); }}
          onBlur={() => { draft.commit(); }}
          onKeyDown={(event) => { handleNumberKey(draft, event); }}
        />
        {suffix !== undefined ? (
          <span aria-hidden className={SUFFIX}>
            {suffix}
          </span>
        ) : null}
      </span>
      {(draft.error != null && draft.error !== "") ? <FieldError id={`${id}-error`} error={draft.error} /> : null}
    </>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  /** Why the text cannot be committed; null when it can. */
  validate?: (text: string) => string | null;
  onCommit: CommitHandler<string>;
  inputRef?: RefObject<HTMLInputElement | null>;
  mono?: boolean;
  className?: string;
}

export function TextField({ label, value, validate, onCommit, inputRef, mono = false, className }: TextFieldProps) {
  const id = useId();
  const density = use(DensityContext);
  const locked = use(FieldLockContext);
  const [fieldRef, draft] = useTextDraft<HTMLInputElement>({ value, ...(validate === undefined ? {} : { validate }), onCommit, disabledReason: locked, ...(inputRef === undefined ? {} : { inputRef }) });
  return (
    <>
      <Input
        ref={fieldRef}
        compact
        aria-label={label}
        title={locked ?? label}
        value={draft.text}
        className={cn("min-w-0 flex-1", QUIET, INPUT_SIZE[density], mono && "machine", ((locked != null && locked !== "") ? "cursor-not-allowed" : locked), className)}
        readOnly={locked !== null}
        aria-disabled={(locked != null && locked !== "") ? true : undefined}
        aria-invalid={(draft.error != null && draft.error !== "") ? true : undefined}
        aria-describedby={(draft.error != null && draft.error !== "") ? `${id}-error` : undefined}
        onChange={(event) => { draft.setText(event.target.value); }}
        onBlur={() => { draft.commit(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            draft.commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            draft.revert();
          }
        }}
      />
      {(draft.error != null && draft.error !== "") ? <FieldError id={`${id}-error`} error={draft.error} /> : null}
    </>
  );
}

export interface TextAreaFieldProps {
  label: string;
  value: string;
  validate?: (text: string) => string | null;
  onCommit: CommitHandler<string>;
  rows?: number;
}

/** Several lines of text: Enter adds a line, Ctrl/⌘+Enter (or leaving the field) commits. */
export function TextAreaField({ label, value, validate, onCommit, rows = 3 }: TextAreaFieldProps) {
  const id = useId();
  const locked = use(FieldLockContext);
  const [fieldRef, draft] = useTextDraft<HTMLTextAreaElement>({ value, ...(validate === undefined ? {} : { validate }), onCommit, disabledReason: locked });
  return (
    <>
      <Textarea
        ref={fieldRef}
        compact
        rows={rows}
        aria-label={label}
        title={locked ?? undefined}
        value={draft.text}
        className={cn("min-h-0 resize-none", QUIET, ((locked != null && locked !== "") ? "cursor-not-allowed" : locked))}
        readOnly={locked !== null}
        aria-disabled={(locked != null && locked !== "") ? true : undefined}
        aria-invalid={(draft.error != null && draft.error !== "") ? true : undefined}
        aria-describedby={(draft.error != null && draft.error !== "") ? `${id}-error` : undefined}
        onChange={(event) => { draft.setText(event.target.value); }}
        onBlur={() => { draft.commit(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            draft.commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            draft.revert();
          }
        }}
      />
      {(draft.error != null && draft.error !== "") ? <FieldError id={`${id}-error`} error={draft.error} /> : null}
    </>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Tooltip of a segment (the fact a hint line used to carry). */
  title?: string;
  /** Shown instead of the label in a segmented control; the label stays the accessible name. */
  icon?: ReactNode;
}

export interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  /** Width of the control. */
  className?: string;
}

export function SelectField<T extends string>({ label, value, options, onChange, hint, className }: SelectFieldProps<T>) {
  const density = use(DensityContext);
  const locked = use(FieldLockContext);
  const pointer = usePointerRelease();
  return (
    <span className={cn("block min-w-0", className)} {...pointer.handlers}>
      <Select
        compact
        aria-label={label}
        title={tooltip(label, locked, hint)}
        aria-disabled={(locked != null && locked !== "") ? true : undefined}
        value={value}
        className={cn(QUIET, SELECT_SIZE[density], ((locked != null && locked !== "") ? "cursor-not-allowed" : locked))}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value);
          if (next && !(locked != null && locked !== "")) onChange(next.value);
          pointer.release(event.target);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

export interface SwitchFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

export function SwitchField({ label, checked, onChange, hint }: SwitchFieldProps) {
  const locked = use(FieldLockContext);
  const pointer = usePointerRelease();
  return (
    <span className="inline-flex shrink-0" title={tooltip(label, locked, hint)} {...pointer.handlers}>
      <Switch
        label={label}
        hideLabel
        className="min-h-0 py-0"
        checked={checked}
        aria-disabled={(locked != null && locked !== "") ? true : undefined}
        onChange={(event) => {
          if (!(locked != null && locked !== "")) onChange(event.target.checked);
          pointer.release(event.target);
        }}
      />
    </span>
  );
}

/**
 * A switch or a select that was used with the pointer gives the keyboard back once its value is taken: these panels
 * keep the timeline's focus, where Space plays and the arrows step, and a control that kept the focus would take
 * those keys (Space would flip the switch back, an arrow would change the select). Used from the keyboard, the
 * control keeps the focus.
 */
function usePointerRelease() {
  const byPointerRef = useRef(false);
  return {
    handlers: {
      onPointerDown: () => {
        byPointerRef.current = true;
      },
      onKeyDown: () => {
        byPointerRef.current = false;
      },
    },
    release: (control: HTMLElement) => {
      if (!byPointerRef.current) return;
      byPointerRef.current = false;
      control.blur();
    },
  };
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

/** A small radio group in one frame: one Tab stop, the arrow keys move and choose. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const density = use(DensityContext);
  const locked = use(FieldLockContext);
  // From the keyboard the chosen radio takes the focus (one Tab stop, the arrows move and choose). A click chooses
  // without taking it: in a panel that keeps the timeline's focus, the arrows and Space stay transport keys
  const choose = (index: number, byKeyboard: boolean) => {
    const next = options[(index + options.length) % options.length];
    if (!next || (locked != null && locked !== "")) return;
    onChange(next.value);
    if (byKeyboard) listRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div ref={listRef} role="radiogroup" aria-label={label} className={cn("inline-flex shrink-0 items-stretch gap-0.5 rounded-md border border-line-strong bg-sunken p-0.5", density === "compact" ? "h-6.5" : "h-8", className)}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            aria-label={hasSlotContent(option.icon) ? option.label : undefined}
            aria-disabled={(locked != null && locked !== "") ? true : undefined}
            title={locked ?? option.title ?? option.label}
            tabIndex={selected ? 0 : -1}
            onClick={(event) => { choose(index, event.detail === 0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") choose(index + 1, true);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") choose(index - 1, true);
              else return;
              event.preventDefault();
            }}
            className={cn(
              "pressable inline-flex min-w-6 flex-1 items-center justify-center rounded-[5px] px-1.5 text-caption whitespace-nowrap [&_svg]:size-3.5",
              selected ? "bg-brand-gradient-soft text-fg ring-1 ring-brand-blue/50 ring-inset [&_svg]:text-brand-cyan" : "text-fg-tertiary hover:bg-raised hover:text-fg",
              ((locked != null && locked !== "") ? "cursor-not-allowed" : locked),
            )}
          >
            {option.icon ?? option.label}
          </button>
        );
      })}
    </div>
  );
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface ColorFieldProps {
  label: string;
  /** #rrggbb. */
  value: string;
  onCommit: CommitHandler<string>;
}

/** A color as a swatch (the system picker; the color applies once, when the picker closes) and as #RRGGBB text. */
export function ColorField({ label, value, onCommit }: ColorFieldProps) {
  const density = use(DensityContext);
  const locked = use(FieldLockContext);
  const swatchRef = useRef<HTMLInputElement>(null);
  // The color under the pointer while the picker is open, over the document color it started from
  const [picking, setPicking] = useState<{ base: string; color: string } | null>(null);
  const picked = useEffectEvent(() => {
    const color = swatchRef.current?.value.toLowerCase();
    if ((color != null && color !== "") && color !== value && !(locked != null && locked !== "")) onCommit(color);
  });
  // React's onChange follows every move inside the picker; the native change event fires once, when it closes
  useEffect(() => {
    const node = swatchRef.current;
    if (!node) return;
    const onChange = () => { picked(); };
    node.addEventListener("change", onChange);
    return () => { node.removeEventListener("change", onChange); };
  }, []);
  return (
    <>
      <input
        ref={swatchRef}
        type="color"
        aria-label={label}
        title={locked ?? label}
        aria-disabled={(locked != null && locked !== "") ? true : undefined}
        value={picking?.base === value ? picking.color : value}
        onChange={(event) => {
          if (!(locked != null && locked !== "")) setPicking({ base: value, color: event.target.value });
        }}
        onBlur={() => { setPicking(null); }}
        className={cn("pressable w-9 shrink-0 cursor-pointer rounded-md border border-line-strong bg-sunken p-0.5", density === "compact" ? "h-6.5" : "h-8", ((locked != null && locked !== "") ? "cursor-not-allowed" : locked))}
      />
      <TextField
        label={t("{label}（#RRGGBB）", { label })}
        value={value}
        mono
        className="max-w-24"
        validate={(text) => (HEX_COLOR.test(text) ? null : t("請輸入 #RRGGBB 格式的色彩"))}
        onCommit={(text) => onCommit(text.toLowerCase())}
      />
    </>
  );
}
