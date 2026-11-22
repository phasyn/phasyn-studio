import { hasSlotContent } from "@/lib/dom";
import type { HTMLAttributes, ReactNode, RefCallback } from "react";
import { cn } from "@/lib/cn";

/**
 * 工作台面板：圓角、細邊、內緣；面板之間的縫隙由外層 grid 的 gap 形成（露出 canvas 底色）。
 * 內容區自己負責捲動（`DockBody`），面板本身不捲動。raised 每個 view 最多兩處。
 */
export function DockPanel({
  as: Tag = "section",
  raised = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "section" | "aside" | "nav" | "div"; raised?: boolean; ref?: RefCallback<HTMLElement> }) {
  return (
    <Tag
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-edge",
        raised && "panel-raised",
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}

/** 面板標題列（36 px）：圖示＋13 px 標題＋計數，右側放 28 px 圖示動作。 */
export function DockHeader({
  icon,
  title,
  titleId,
  count,
  actions,
  className,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  titleId?: string;
  count?: number | null;
  actions?: ReactNode;
  className?: string;
  /** 標題與動作之間的額外內容（例如精簡分頁）。 */
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3", className)}>
      <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-data font-semibold text-fg [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-tertiary">
        {icon}
        <span className="truncate">{title}</span>
        {count !== undefined && count !== null ? <span className="machine text-caption font-normal text-fg-tertiary">{count}</span> : null}
      </h2>
      {children}
      {hasSlotContent(actions) ? <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}

/** 面板內容區：唯一的 scroll owner。 */
export function DockBody({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: RefCallback<HTMLDivElement> }) {
  return (
    <div className={cn("relative min-h-0 flex-1 overflow-auto", className)} {...props}>
      {children}
    </div>
  );
}
