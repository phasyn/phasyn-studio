import { hasSlotContent } from "@/lib/dom";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

const TONES = {
  info: { icon: Info, className: "text-info", border: "border-line-strong" },
  warning: { icon: TriangleAlert, className: "text-warning", border: "border-warning/40" },
  danger: { icon: CircleAlert, className: "text-danger", border: "border-danger/40" },
  success: { icon: CircleCheck, className: "text-success", border: "border-success/40" },
} as const;

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: keyof typeof TONES;
  title?: ReactNode;
  icon?: ReactNode;
}

export function Callout({ tone = "info", title, icon, className, children, ...props }: CalloutProps) {
  const config = TONES[tone];
  const Icon = config.icon;
  return (
    <div
      className={cn("flex gap-3 rounded-md border bg-sunken px-4 py-3 text-data text-fg-secondary", config.border, className)}
      {...props}
    >
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", config.className)} aria-hidden>
        {icon ?? <Icon />}
      </span>
      <div className="min-w-0 space-y-1">
        {hasSlotContent(title) ? <p className="font-semibold text-fg">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
