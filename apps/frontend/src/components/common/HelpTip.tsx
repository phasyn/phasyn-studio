import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * 說明開關（?）：點擊或 Enter 切換下方說明段落；滑鼠停留時 title 也顯示同一段文字。
 * 說明段落以 HelpText 一律掛在 DOM（收合時 hidden），所以 aria-describedby 收合時仍讀得到；展開時淡入。
 */
export function HelpButton({
  open,
  onToggle,
  controls,
  label,
  text,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  /** HelpText 的 id。 */
  controls: string;
  /** 說明的對象（例如欄位名稱），組成「{label}：說明」。 */
  label: string;
  /** 滑鼠停留提示（純文字）。 */
  text?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={t("{label}：說明", { label })}
      title={text}
      onClick={onToggle}
      className={cn(
        "pressable inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-fg active:bg-sunken aria-expanded:text-action-fg [&_svg]:size-3.5",
        className,
      )}
    >
      <CircleHelp aria-hidden />
    </button>
  );
}

export function HelpText({ id, open, children, className }: { id: string; open: boolean; children: ReactNode; className?: string }) {
  return (
    <p id={id} hidden={!open} className={cn("text-caption text-fg-tertiary animate-reveal", className)}>
      {children}
    </p>
  );
}
