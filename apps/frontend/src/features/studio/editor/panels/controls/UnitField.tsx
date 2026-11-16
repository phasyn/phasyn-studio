// Fields the property panels add to the shared ones (fields.tsx takes plain numbers and is used by other panels too).
// UnitField: a number kept in document form and typed in a unit (percent of 1, pixels of the frame, a balance around
// 0). SliderField: the same value as a slider for the docks; the thumb previews while it is dragged and the value is
// committed once, on release, so one move is one undo step.
import { useContext, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { FieldLockContext } from "./controlsContext";
import { NumberField } from "./fields";
import { shownValue, storedValue, type Unit } from "./properties";
import type { CommitResult } from "./useFieldDraft";

export interface UnitFieldProps {
  label: string;
  unit: Unit;
  /** In document form, like min and max. */
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => CommitResult;
  hint?: string;
  disabledReason?: string | null;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function UnitField({ label, unit, value, min, max, onCommit, hint, disabledReason, inputRef }: UnitFieldProps) {
  return (
    <NumberField
      label={label}
      value={shownValue(unit, value)}
      min={shownValue(unit, min)}
      max={shownValue(unit, max)}
      decimals={unit.decimals}
      step={unit.step}
      suffix={unit.suffix}
      hint={hint}
      disabledReason={disabledReason}
      inputRef={inputRef}
      onCommit={(shown) => onCommit(storedValue(unit, shown, min, max))}
    />
  );
}

export interface SliderFieldProps {
  label: string;
  unit: Unit;
  /** In document form, like min and max. */
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}

export function SliderField({ label, unit, value, min, max, onCommit }: SliderFieldProps) {
  const locked = useContext(FieldLockContext);
  const current = shownValue(unit, value);
  // Where the thumb is while it is dragged, over the shown value it started from
  const [drag, setDrag] = useState<{ base: number; shown: number } | null>(null);
  const active = drag?.base === current ? drag : null;
  const settle = () => {
    setDrag(null);
    if (active && active.shown !== current) onCommit(storedValue(unit, active.shown, min, max));
  };
  return (
    <input
      type="range"
      aria-label={label}
      aria-disabled={locked ? true : undefined}
      title={locked ?? label}
      min={shownValue(unit, min)}
      max={shownValue(unit, max)}
      step={unit.step}
      value={active?.shown ?? current}
      onChange={(event) => {
        if (!locked) setDrag({ base: current, shown: Number(event.target.value) });
      }}
      // Captured, so the release is seen wherever the pointer is by then
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerUp={settle}
      onKeyUp={settle}
      onBlur={settle}
      className={cn("h-8 min-w-16 flex-1 accent-playhead", locked && "cursor-not-allowed")}
    />
  );
}
