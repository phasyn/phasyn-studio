import { pageTransition } from "@/lib/dom";
import { ChevronRight, Menu } from "lucide-react";
import { Link, useLocation } from "react-router";
import { areaLink, type StudioMemory } from "@/app/areas";
import { BrandMark } from "@/components/common/BrandMark";
import { cn } from "@/lib/cn";
import { ActiveRun } from "./ActiveRun";
import { shellCrumbs } from "./crumbs";
import { t } from "@/i18n";

/**
 * 頂欄（44 px）：目前位置（工作區 › 頁面 › 物件）與進行中的 run；頁面自己的標題與動作仍在各頁的頁首／工具列。
 * 窄於 840 px 時左側多一顆「開啟導覽」（側欄改成抽屜）。底緣一條淡淡的品牌漸層細線（裝飾）。
 */
export function TopBar({ memory, onOpenNav, navOpen }: { memory: StudioMemory; onOpenNav: () => void; navOpen: boolean }) {
  const { pathname } = useLocation();
  const crumbs = shellCrumbs(pathname);
  const AreaIcon = crumbs.area?.icon;
  return (
    <header className="relative flex h-11 min-w-0 items-center gap-2 border-b border-line-subtle bg-canvas px-3 md:px-4">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-brand-gradient opacity-25" />
      <button
        type="button"
        onClick={onOpenNav}
        aria-label={t("開啟導覽")}
        aria-haspopup="dialog"
        aria-expanded={navOpen}
        className="pressable grid size-9 shrink-0 place-items-center rounded-lg text-fg-secondary hover:bg-raised hover:text-fg md:hidden"
      >
        <Menu aria-hidden className="size-4" />
      </button>
      <BrandMark size={22} className="md:hidden" />
      <nav aria-label={t("目前位置")} className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-data">
          {crumbs.area ? (
            <li className="flex min-w-0 items-center">
              <Link
                to={areaLink(crumbs.area, memory)}
                {...pageTransition()}
                aria-current={(crumbs.page != null && crumbs.page !== "") ? undefined : "page"}
                className={cn(
                  "pressable flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 no-underline hover:bg-raised hover:text-fg",
                  (crumbs.page != null && crumbs.page !== "") ? "text-fg-secondary" : "font-medium text-fg",
                )}
              >
                {AreaIcon ? <AreaIcon aria-hidden className="size-4 shrink-0 text-brand-cyan" /> : null}
                {/* On a phone the area is its icon when a page follows, so the page name stays readable */}
                <span className={cn("truncate", (crumbs.page != null && crumbs.page !== "") && "max-sm:sr-only")}>{crumbs.area.label}</span>
              </Link>
            </li>
          ) : (
            <li className="truncate px-1.5 text-fg-secondary">Phasyn Studio</li>
          )}
          {(crumbs.page != null && crumbs.page !== "") ? (
            <>
              <li aria-hidden className="shrink-0 text-fg-disabled">
                <ChevronRight className="size-3.5" />
              </li>
              <li aria-current={(crumbs.detail != null && crumbs.detail !== "") ? undefined : "page"} className={cn("min-w-0 truncate", (crumbs.detail != null && crumbs.detail !== "") ? "text-fg-secondary" : "font-medium text-fg")}>
                {crumbs.page}
              </li>
            </>
          ) : null}
          {(crumbs.detail != null && crumbs.detail !== "") ? (
            <>
              <li aria-hidden className="shrink-0 text-fg-disabled">
                <ChevronRight className="size-3.5" />
              </li>
              <li aria-current="page" className="machine min-w-0 truncate text-caption text-fg" title={crumbs.detail}>
                {crumbs.detail}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      {/* The running run's chip truncates (at most 55 %) instead of sliding over the location on a phone */}
      <div className="ml-auto flex min-w-0 max-w-[55%] items-center justify-end gap-1.5">
        <ActiveRun />
      </div>
    </header>
  );
}
