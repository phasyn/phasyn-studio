import { hasSlotContent } from "@/lib/dom";
import { isValidElement, useEffect, useRef, type ReactNode } from "react";
import { AreaIcon } from "@/components/common/AreaIcon";
import { useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { consumeRouteFocus } from "./routeFocus";

/**
 * 工作台頁首（約 56–72 px，元件修改／紀錄／推理各頁）：圖示＋20 px 標題＋一行說明，動作靠右；細節放在頁面內的（?）或提示，不放長段落。
 * 路由切換（pathname 改變）後焦點移到標題；輪詢更新不會觸發。
 */
export function PageHeader({
  title,
  icon,
  description,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  /** lucide 圖示（16–18 px，aria-hidden）。 */
  icon?: ReactNode;
  /** 一行說明。 */
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    if (consumeRouteFocus()) headingRef.current?.focus({ preventScroll: true });
  }, [pathname]);
  return (
    <header className={cn("flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <div className="flex min-w-0 items-center gap-3">
        {hasSlotContent(icon) && isValidElement(icon) && icon.type === AreaIcon ? (
          // 工作區玻璃圖示自己就是圖塊，不再包一層框
          <span aria-hidden className="grid shrink-0 place-items-center">
            {icon}
          </span>
        ) : hasSlotContent(icon) ? (
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-action/25 bg-brand-gradient-soft text-brand-cyan shadow-edge [&_svg]:size-[18px]"
          >
            {icon}
          </span>
        ) : null}
        <div className="grid min-w-0 gap-0.5">
          <h1
            ref={headingRef}
            id="page-title"
            tabIndex={-1}
            className="text-page font-semibold text-fg outline-none [overflow-wrap:anywhere] focus-visible:outline-2"
          >
            {title}
          </h1>
          {hasSlotContent(description) ? <div className="text-data text-fg-secondary">{description}</div> : null}
          {hasSlotContent(meta) ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
      </div>
      {hasSlotContent(actions) ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 工作台頁本體：統一內距（px-5 py-4）；捲動由所在工作區的內容欄負責。 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-w-0 content-start gap-4 px-5 py-4", className)}>{children}</div>;
}
