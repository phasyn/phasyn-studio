import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { clampColumnWidth, columnKeyAction, dragColumnWidth, maxWidthOf, type ColumnSpec } from "./columnWidths";
import { t } from "@/i18n";

interface DragState {
  pointer: number;
  startX: number;
  startWidth: number;
  last: number;
}

function lockPage(locked: boolean): void {
  if (locked) {
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  } else {
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }
}

/**
 * 表頭欄位右緣的欄寬把手（8 px 寬、完全在欄內；放在 position 非 static 的 th 內，例如 sticky 表頭）：
 * 拖曳（pointer capture）、鍵盤（可聚焦的 separator：←／→ 調整、Shift 大步、Home 還原）、雙擊還原預設。
 */
export function ColumnResizer({
  spec,
  width,
  onPreview,
  onCommit,
  onReset,
  className,
}: {
  spec: ColumnSpec;
  width: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const dragRef = useRef<DragState | null>(null);

  // 拖曳中卸載（例如切換 Node 分頁）時還原頁面游標與選取。
  useEffect(() => () => { lockPage(false); }, []);

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (state?.pointer !== event.pointerId) return;
    dragRef.current = null;
    lockPage(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(state.last);
  };

  return (
    <div /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- This adjustable ARIA separator is operable with arrows and exposes the current value. */
      role="separator"
      aria-orientation="vertical"
      aria-label={t("調整「{label}」欄寬", { label: spec.label })}
      aria-valuenow={width}
      aria-valuemin={spec.minWidth}
      aria-valuemax={maxWidthOf(spec)}
      aria-valuetext={`${String(width)} px`}
       /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- This adjustable ARIA separator is operable with arrows and exposes the current value. */ tabIndex={0}
      title={t("拖曳調整「{label}」欄寬；雙擊或 Home 還原預設 {defaultWidth} px", { label: spec.label, defaultWidth: spec.defaultWidth })}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointer: event.pointerId, startX: event.clientX, startWidth: width, last: width };
        lockPage(true);
      }}
      onPointerMove={(event) => {
        const state = dragRef.current;
        if (state?.pointer !== event.pointerId) return;
        const next = dragColumnWidth(spec, state.startWidth, state.startX, event.clientX);
        if (next === state.last) return;
        state.last = next;
        onPreview(next);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
      onClick={(event) => { event.stopPropagation(); }}
      onKeyDown={(event) => {
        const action = columnKeyAction(event.key, event.shiftKey);
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if ("reset" in action) onReset();
        else onCommit(clampColumnWidth(spec, width + action.delta));
      }}
      className={cn("group/resizer absolute inset-y-0 right-0 z-[2] w-2 cursor-col-resize touch-none select-none", className)}
    >
      <span
        aria-hidden
        className="absolute inset-y-1.5 right-0 w-px bg-line transition-colors duration-150 group-hover/resizer:w-0.5 group-hover/resizer:bg-brand-blue group-focus-visible/resizer:w-0.5 group-focus-visible/resizer:bg-focus group-active/resizer:bg-brand-cyan"
      />
    </div>
  );
}
