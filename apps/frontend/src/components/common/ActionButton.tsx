import { forwardRef, useId } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface ActionButtonProps extends ButtonProps {
  /** 不可用的原因：按鈕保持可聚焦（aria-disabled），原因以 aria-describedby 與 title 告知。 */
  disabledReason?: string | null;
}

// 不可用（原因在 title／aria-describedby）：移除主要按鈕的漸層、光暈與亮度變化，看起來不能按（仍可聚焦）。
const BLOCKED =
  "cursor-not-allowed border-line-subtle bg-raised bg-none text-fg-disabled shadow-none hover:border-line-subtle hover:bg-raised hover:text-fg-disabled hover:shadow-none hover:brightness-100 focus-visible:shadow-none active:bg-raised active:brightness-100";

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { disabledReason, onClick, className, pending, ...props },
  ref,
) {
  const reasonId = useId();
  const blocked = Boolean(disabledReason);
  return (
    <>
      <Button
        ref={ref}
        {...props}
        pending={pending}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : props["aria-describedby"]}
        title={disabledReason ?? props.title}
        className={cn(className, blocked && BLOCKED)}
        onClick={(event) => {
          if (blocked || pending) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      />
      {blocked ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
});
