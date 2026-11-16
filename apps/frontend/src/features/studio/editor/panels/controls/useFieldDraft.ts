// The drafts behind the editor's property fields. Typing only changes local text; blur or Enter commits it once
// (one undo step), Escape puts the document value back, and text that cannot be applied stays editable with the
// reason. Every draft registers with the editor's draft registry, so Save commits whatever is still being typed.
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { t } from "@/i18n";
import { useEditorDraft } from "../../drafts";
import { formatNumber, parseNumber } from "./numbers";

/** What a commit handler answers: nothing or true = applied; false = refused; a string = refused for that reason. */
export type CommitResult = void | boolean | string;

interface DraftState<T> {
  /** The document value the text was typed over: when the document changes underneath, the draft is dropped. */
  base: T;
  text: string;
  error: string | null;
}

/** The field's ref comes back beside the draft, never inside it: what a render reads must not hold a ref. */
export type DraftBinding<E extends HTMLElement, D extends FieldDraft = FieldDraft> = readonly [RefObject<E | null>, D];

export interface FieldDraft {
  /** What the field shows: the typed text, else the document value. */
  text: string;
  error: string | null;
  setText: (text: string) => void;
  /** False when the text was refused (it stays, with the reason in `error`). */
  commit: () => boolean;
  revert: () => void;
}

function refusal(result: CommitResult): string | null {
  if (typeof result === "string") return result;
  return result === false ? t("無法套用剪輯") : null;
}

export interface NumberDraftOptions {
  value: number;
  min: number;
  max: number;
  /** Decimals shown; 0 = whole numbers only. */
  decimals: number;
  /** What an arrow key adds or takes away (Shift: ten times as much). */
  step: number;
  onCommit: (value: number) => CommitResult;
  /** Why the field is read-only; null or absent when it can be edited. */
  disabledReason?: string | null;
  /** The input's ref when the caller needs to focus the field itself. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export interface NumberDraft extends FieldDraft {
  /** Arrow keys: one step up or down, kept as a draft like typed text. */
  nudge: (direction: 1 | -1, large: boolean) => void;
}

export function useNumberDraft({
  value,
  min,
  max,
  decimals,
  step,
  onCommit,
  disabledReason,
  inputRef,
}: NumberDraftOptions): DraftBinding<HTMLInputElement, NumberDraft> {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const [draft, setDraft] = useState<DraftState<number> | null>(null);
  const active = draft?.base === value ? draft : null;
  const commit = (): boolean => {
    if (!active || disabledReason) return true;
    const next = parseNumber(active.text);
    if (!Number.isFinite(next) || next < min || next > max || (decimals === 0 && !Number.isInteger(next))) {
      const range = { min: formatNumber(min, decimals), max: formatNumber(max, decimals) };
      setDraft({ ...active, error: decimals === 0 ? t("請輸入 {min}–{max} 之間的整數", range) : t("請輸入 {min}–{max} 之間的數值", range) });
      return false;
    }
    const refused = next === value ? null : refusal(onCommit(next));
    if (refused) {
      setDraft({ ...active, error: refused });
      return false;
    }
    setDraft(null);
    return true;
  };
  const nudge = (direction: 1 | -1, large: boolean) => {
    if (disabledReason) return;
    const typed = active ? parseNumber(active.text) : value;
    const from = Number.isFinite(typed) ? typed : value;
    const next = Math.min(max, Math.max(min, from + direction * step * (large ? 10 : 1)));
    setDraft({ base: value, text: formatNumber(next, decimals), error: null });
  };
  useEditorDraft({ commit, focus: () => ref.current?.focus() });
  const field: NumberDraft = {
    text: active?.text ?? formatNumber(value, decimals),
    error: active?.error ?? null,
    setText: (text) => setDraft({ base: value, text, error: null }),
    commit,
    revert: () => setDraft(null),
    nudge,
  };
  return [ref, field];
}

/** The keys of a number field: Enter commits, Escape reverts, the up and down arrows nudge. */
export function handleNumberKey(draft: NumberDraft, event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") {
    event.preventDefault();
    draft.commit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    draft.revert();
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    draft.nudge(event.key === "ArrowUp" ? 1 : -1, event.shiftKey);
  }
}

export interface TextDraftOptions<E extends HTMLElement> {
  value: string;
  /** Why the text cannot be committed; null when it can. */
  validate?: (text: string) => string | null;
  onCommit: (text: string) => CommitResult;
  disabledReason?: string | null;
  inputRef?: RefObject<E | null>;
}

export function useTextDraft<E extends HTMLElement>({ value, validate, onCommit, disabledReason, inputRef }: TextDraftOptions<E>): DraftBinding<E> {
  const own = useRef<E>(null);
  const ref = inputRef ?? own;
  const [draft, setDraft] = useState<DraftState<string> | null>(null);
  const active = draft?.base === value ? draft : null;
  const commit = (): boolean => {
    if (!active || disabledReason) return true;
    const refused = active.text === value ? null : (validate?.(active.text) ?? refusal(onCommit(active.text)));
    if (refused) {
      setDraft({ ...active, error: refused });
      return false;
    }
    setDraft(null);
    return true;
  };
  useEditorDraft({ commit, focus: () => ref.current?.focus() });
  const field: FieldDraft = {
    text: active?.text ?? value,
    error: active?.error ?? null,
    setText: (text) => setDraft({ base: value, text, error: null }),
    commit,
    revert: () => setDraft(null),
  };
  return [ref, field];
}
