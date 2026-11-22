import { pageTransition, hasSlotContent } from "@/lib/dom";
import { X, type LucideIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { cn } from "@/lib/cn";
import { TEXT_TONE, type Tone } from "./tones";
import { t } from "@/i18n";

export interface DocTab {
  id: string;
  label: string;
  icon?: LucideIcon;
  iconTone?: Tone;
  to: string;
  active: boolean;
  title?: string;
  /** 有值時顯示 ×（例如關閉目前開啟的物件、回到清單）。 */
  closeTo?: string;
}

/**
 * 文件分頁（32 px）：目前頁面與開啟中的物件；active＝surface 底＋頂線（頂線在分頁之間滑動）。
 * 右側可放額外內容。
 */
export function DocTabs({ tabs, label, trailing }: { tabs: readonly DocTab[]; label: string; trailing?: ReactNode }) {
  const listRef = useRef<HTMLUListElement>(null);
  return (
    <nav aria-label={label} className="flex h-8 shrink-0 items-stretch border-b border-line-subtle bg-canvas">
      <ul ref={listRef} className="relative flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <li
              key={tab.id}
              data-active={tab.active || undefined}
              className={cn(
                "relative flex max-w-64 min-w-0 items-center border-r border-line-subtle transition-colors duration-(--duration-fast)",
                tab.active ? "bg-surface" : "bg-canvas hover:bg-raised/60",
              )}
            >
              <Link
                to={tab.to}
                {...pageTransition()}
                aria-current={tab.active ? "page" : undefined}
                title={tab.title ?? tab.label}
                className={cn(
                  "flex h-full min-w-0 items-center gap-1.5 pl-3 text-data no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                  (tab.closeTo != null && tab.closeTo !== "") ? "pr-1" : "pr-3",
                  tab.active ? "font-medium text-fg" : "text-fg-secondary hover:text-fg",
                )}
              >
                {Icon ? <Icon aria-hidden className={cn("size-3.5 shrink-0", tab.iconTone ? TEXT_TONE[tab.iconTone] : "text-fg-tertiary")} /> : null}
                <span className="truncate">{tab.label}</span>
              </Link>
              {(tab.closeTo != null && tab.closeTo !== "") ? (
                <Link
                  to={tab.closeTo}
                  aria-label={t("關閉 {label}", { label: tab.label })}
                  title={t("關閉 {label}", { label: tab.label })}
                  className="pressable mr-1.5 grid size-5 shrink-0 place-items-center rounded-sm text-fg-tertiary no-underline hover:bg-overlay hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden className="size-3.5" />
                </Link>
              ) : null}
            </li>
          );
        })}
        <ActiveIndicator container={listRef} edge="top" as="li" selector="[data-active]" />
      </ul>
      {hasSlotContent(trailing) ? <div className="ml-auto flex shrink-0 items-center gap-1 px-2">{trailing}</div> : null}
    </nav>
  );
}
