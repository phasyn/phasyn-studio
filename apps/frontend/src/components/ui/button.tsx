import type { VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import type { Ref, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { buttonVariants } from "./variants";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * 進行中：維持按鈕寬度、圖示換成旋轉進度圖示，以 aria-busy＋aria-disabled 告知，並擋下重複點擊（含表單隱含送出）。
   * 不設 disabled 屬性：用鍵盤按下的按鈕在等待期間保留焦點（停用的元素會讓焦點掉到 body）。呼叫端仍應防止重送。
   */
  pending?: boolean;
  icon?: ReactNode;
}

export function Button(
  { ref, className, variant, size, pending = false, icon, children, type = "button", disabled, onClick, ...props }: ButtonProps & { ref?: Ref<HTMLButtonElement> | undefined },
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled}
      {...props}
      aria-disabled={pending ? true : props["aria-disabled"]}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
