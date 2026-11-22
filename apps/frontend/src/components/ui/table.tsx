import type { ComponentProps, HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** 表格只在自身容器內水平捲動（具名、可鍵盤聚焦），不造成整頁 x-overflow。 */
export function TableScroll({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="region" aria-label={label}  /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- Keyboard users can focus this scrollable region and scroll its overflow. */ tabIndex={0} className={cn("relative max-w-full min-w-0 overflow-x-auto", className)}>
      {children}
    </div>
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-left text-data", className)} {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("border-b border-line bg-sunken/80 px-3 py-2 text-caption font-medium whitespace-nowrap text-fg-tertiary first:pl-4", className)}
      {...props}
    />
  );
}

/** compact 密度：單行列約 36 px（13 px 資料文字）。 */
export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-line-subtle px-3 py-2 align-top first:pl-4", className)} {...props} />;
}

export function Tr({ className, selected, ...props }: ComponentProps<"tr"> & { selected?: boolean }) {
  return (
    <tr
      data-selected={(selected ?? false) || undefined}
      className={cn(
        "transition-[color,background-color,box-shadow] duration-(--duration-fast) ease-standard hover:bg-raised/60 data-selected:bg-selection data-selected:shadow-[inset_3px_0_0_var(--color-action)]",
        className,
      )}
      {...props}
    />
  );
}
