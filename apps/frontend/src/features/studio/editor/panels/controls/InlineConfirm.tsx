// A question asked in the row itself before an action that removes keyframes (switching a stopwatch off, putting a
// group or an effect back to its defaults): the question, the action in danger tone and Cancel. It takes the keyboard
// focus when it appears (the press that asked for it may have left the focus elsewhere); Esc cancels.
import { t } from "@/i18n";
import { TextButton } from "./rows";

export interface InlineConfirmProps {
  question: string;
  /** The label of the button that does it. */
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const focusWhenShown = (node: HTMLElement | null) => {
  node?.focus({ preventScroll: true });
};

export function InlineConfirm({ question, action, onConfirm, onCancel }: InlineConfirmProps) {
  return (
    <span /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */
      ref={focusWhenShown}
      role="group"
      aria-label={question}
      tabIndex={-1}
      data-escape-key=""
      className="flex min-w-0 flex-1 animate-fade-in items-center gap-1 outline-none"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="min-w-0 flex-1 truncate text-data text-fg" title={question}>
        {question}
      </span>
      <TextButton tone="danger" onClick={onConfirm}>
        {action}
      </TextButton>
      <TextButton onClick={onCancel}>{t("取消")}</TextButton>
    </span>
  );
}
