// The History panel: every edit of this session as a named step, oldest first, under the state the document was
// opened in. The step the document stands on is marked; choosing another one undoes or redoes up to it, and the steps
// after the marked one are dropped by the next edit.
import { History, Redo2, Undo2 } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { useEditor } from "../editorContext";
import { chordOf } from "../keymap";

/** A command's shortcut as this platform writes it (⌘ or Ctrl). */
function shortcutOf(command: "undo" | "redo"): string {
  const apple = detectApplePlatform();
  return chordOf(command)
    .split("+")
    .map((key) => modifierLabel(key, apple))
    .join("+");
}

interface StateRowProps {
  /** How many steps are applied in this state (0: the state the document was opened in). */
  position: number;
  label: string;
  current: boolean;
  /** A state after the current one: its steps were undone and can be redone. */
  undone: boolean;
  onChoose: () => void;
}

function StateRow({ position, label, current, undone, onChoose }: StateRowProps) {
  return (
    <li role="option" aria-selected={current} className="contents">
      <button
        type="button"
        data-history-state={position}
        tabIndex={current ? 0 : -1}
        aria-current={current ? "step" : undefined}
        title={current ? t("目前的狀態") : undone ? t("重做到「{label}」", { label }) : t("復原到「{label}」", { label })}
        onClick={onChoose}
        className={cn(
          "pressable flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
          current ? "bg-brand-gradient-soft font-semibold text-fg ring-1 ring-brand-blue/45 ring-inset" : undone ? "text-fg-disabled hover:bg-raised/60 hover:text-fg-secondary" : "text-fg-secondary hover:bg-raised/60 hover:text-fg",
        )}
      >
        <span className="machine w-6 shrink-0 text-right text-caption text-fg-tertiary">{position}</span>
        <span className={cn("min-w-0 flex-1 truncate", undone && "italic")}>{label}</span>
      </button>
    </li>
  );
}

export function HistoryPanel() {
  const editor = useEditor();
  const { steps, position } = editor.history;
  const list = useRef<HTMLOListElement>(null);

  // The current state stays in view when an edit, an undo or a redo moves it
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-history-state="${position}"]`)?.scrollIntoView({ block: "nearest" });
  }, [position, steps.length]);

  const focusState = (target: number) => {
    const bounded = Math.max(0, Math.min(steps.length, target));
    list.current?.querySelector<HTMLElement>(`[data-history-state="${bounded}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const focused = Number((event.target as HTMLElement).dataset.historyState ?? position);
    const next = event.key === "ArrowDown" ? focused + 1 : event.key === "ArrowUp" ? focused - 1 : event.key === "Home" ? 0 : event.key === "End" ? steps.length : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    focusState(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-keep-focus="" className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-subtle px-2">
        <ActionButton
          size="sm"
          icon={<Undo2 aria-hidden />}
          disabledReason={editor.canUndo ? null : t("沒有可以復原的步驟")}
          title={t("{label}（{shortcut}）", { label: t("復原"), shortcut: shortcutOf("undo") })}
          onClick={editor.undo}
        >
          {t("復原")}
        </ActionButton>
        <ActionButton
          size="sm"
          icon={<Redo2 aria-hidden />}
          disabledReason={editor.canRedo ? null : t("沒有可以重做的步驟")}
          title={t("{label}（{shortcut}）", { label: t("重做"), shortcut: shortcutOf("redo") })}
          onClick={editor.redo}
        >
          {t("重做")}
        </ActionButton>
        <span className="machine ml-auto shrink-0 truncate pr-1 text-caption text-fg-tertiary" title={t("目前在第 {step} 步，共 {total} 步", { step: position, total: steps.length })}>
          {position} / {steps.length}
        </span>
      </div>
      {steps.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <EmptyState
            size="compact"
            icon={<History />}
            title={t("還沒有可以復原的步驟")}
            description={t("每次剪輯都會記成一步，可以復原，也可以再重做。")}
          />
        </div>
      ) : (
        <ol ref={list} role="listbox" aria-label={t("剪輯步驟")} data-keep-focus="" onKeyDown={onKeyDown} className="grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto p-1.5">
          <StateRow position={0} label={t("開啟時的狀態")} current={position === 0} undone={false} onChoose={() => editor.travelTo(0)} />
          {steps.map((step, index) => (
            <StateRow
              key={step.id}
              position={index + 1}
              label={step.label}
              current={position === index + 1}
              undone={index + 1 > position}
              onChoose={() => editor.travelTo(index + 1)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
