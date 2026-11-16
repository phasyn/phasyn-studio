// 開關（role="switch" 的按鈕）：外觀與共用的 Switch 相同（開啟＝深色操作漸層軌道，滑塊以 snappy 彈簧滑過去）。
// 不能切換時保持可聚焦（aria-disabled），原因在 title 與 aria-describedby，按下不做事。
import { useId } from "react";
import { cn } from "@/lib/cn";

export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabledReason,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 無障礙名稱與 tooltip（例如「在這個專案使用「漫畫速度線」」）。 */
  label: string;
  disabledReason?: string | null;
  className?: string;
}) {
  const reasonId = useId();
  const blocked = Boolean(disabledReason);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={blocked || undefined}
      aria-describedby={blocked ? reasonId : undefined}
      title={disabledReason ?? label}
      onClick={(event) => {
        event.stopPropagation();
        if (!blocked) onChange(!checked);
      }}
      className={cn(
        "group/switch relative inline-flex h-8 w-11 shrink-0 items-center justify-center rounded-md outline-offset-0",
        blocked ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-5 w-9 rounded-full border transition-[background-color,border-color] duration-(--duration-fast)",
          checked ? "border-transparent bg-action-gradient" : "border-line-control bg-sunken",
          blocked && "border-line-subtle bg-raised bg-none",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "absolute top-2.25 left-1.75 size-3.5 rounded-full shadow-[0_1px_2px_rgb(0_0_0_/_0.4)]",
          "transition-[translate,background-color] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)",
          checked ? "translate-x-4 bg-[#fff]" : "bg-fg-secondary",
          blocked && "bg-fg-disabled",
        )}
      />
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </button>
  );
}
