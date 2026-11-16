import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface KvItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  tone?: "default" | "warning" | "danger" | "success" | "muted";
}

const TONE_CLASS = {
  default: "text-fg-secondary",
  warning: "text-warning",
  danger: "text-danger",
  success: "text-success",
  muted: "text-fg-tertiary",
} as const;

export function KeyValueList({ items, className, dense = false }: { items: KvItem[]; className?: string; dense?: boolean }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(6rem,0.85fr)_minmax(0,1.4fr)] gap-x-3",
        dense ? "gap-y-1 text-caption" : "gap-y-2 text-data",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="text-fg-tertiary">{item.label}</dt>
          <dd className={cn("m-0 min-w-0 [overflow-wrap:anywhere]", TONE_CLASS[item.tone ?? "default"], item.mono && "machine")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
