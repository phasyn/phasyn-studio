import { PanelLeftClose, PanelLeftDashed, PanelLeftOpen, Pin } from "lucide-react";
import { useRef } from "react";
import { Link, useLocation } from "react-router";
import { AREAS, areaLink, areaOf, type AreaSpec, type StudioMemory } from "@/app/areas";
import { PATHS } from "@/app/paths";
import { BrandMark } from "@/components/common/BrandMark";
import { Wordmark } from "@/components/common/Wordmark";
import { ActiveIndicator } from "@/components/ui/active-indicator";
import { pageOwnsPlainShortcut, shortcutLabel } from "@/features/command";
import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import { cn } from "@/lib/cn";
import type { FitMeasure } from "@/lib/fitLevel";
import { detectApplePlatform } from "@/lib/keyboard";
import { useFitLevel } from "@/lib/useFitLevel";
import { t } from "@/i18n";
import { ActiveRun } from "./ActiveRun";
import type { SidebarMode } from "./shellState";

/** 側欄頂端：Phasyn 標誌（光暈）＋字標；收合時只有標誌。連到 Video Studio。 */
function SidebarBrand({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  // The chord that opens the palette on this page (the Edit workspace uses Ctrl+K for edit points)
  const keys = shortcutLabel(detectApplePlatform(), !pageOwnsPlainShortcut(pathname));
  return (
    <div className="relative flex h-16 shrink-0 items-center overflow-hidden px-3">
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_120%_at_20%_-20%,rgb(62_137_255_/_0.2),transparent_70%)]" />
      <Link
        to={PATHS.studio}
        viewTransition
        onClick={onNavigate}
        aria-label={t("Phasyn Studio 首頁（Video Studio）")}
        title={t("Phasyn Studio（{keys} 開啟命令面板）", { keys })}
        className={cn(
          "pressable relative flex min-w-0 items-center gap-2.5 rounded-lg py-1.5 text-fg no-underline outline-none focus-visible:outline-2 focus-visible:outline-focus",
          collapsed ? "mx-auto justify-center px-1" : "px-1.5",
        )}
      >
        <BrandMark size={collapsed ? 34 : 32} glow />
        {collapsed ? null : <Wordmark width={108} decorative className="animate-fade-in" />}
      </Link>
    </div>
  );
}

/**
 * 工作區連結放不下時（依量測，不分語言）：先收掉右側的英文小字，再讓名稱截斷（完整名稱在 title 與可存取名稱）。
 * 五個連結同寬（同一欄），所以一起收合：量最寬的那個。連結可以用到清單右側的留白，但不能超出側欄（超出的部分會被裁掉）。
 */
const AREA_FIT_LEVELS = 2;

function measureAreaLinks(list: HTMLElement): FitMeasure {
  const available = list.clientWidth - (parseFloat(getComputedStyle(list).paddingLeft) || 0);
  let required = 0;
  for (const link of Array.from(list.querySelectorAll<HTMLElement>(":scope > li > a"))) required = Math.max(required, link.offsetWidth);
  return { required, available };
}

function AreaLink({ area, memory, active, collapsed, fit, onNavigate }: { area: AreaSpec; memory: StudioMemory; active: boolean; collapsed: boolean; fit: number; onNavigate?: () => void }) {
  return (
    <li>
      <Link
        to={areaLink(area, memory)}
        viewTransition
        onClick={onNavigate}
        title={collapsed ? undefined : t("{label}：{hint}", { label: area.label, hint: area.hint })}
        aria-current={active ? "page" : undefined}
        className={cn(
          "pressable group/area relative flex h-10 items-center rounded-lg border text-data no-underline outline-none",
          "focus-visible:outline-2 focus-visible:outline-focus",
          collapsed ? "mx-auto w-10 justify-center" : "gap-3 px-3",
          active
            ? "border-action/25 bg-brand-gradient-soft font-medium text-fg shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05)]"
            : "border-transparent text-fg-secondary hover:bg-raised/80 hover:text-fg",
        )}
      >
        {/* 目前項目的圖示以外殼共用的品牌漸層描邊（#ps-brand-gradient；找不到時退回品牌青） */}
        <area.icon
          aria-hidden
          className={cn(
            "size-[18px] shrink-0 transition-colors duration-(--duration-fast)",
            active ? "text-brand-cyan [stroke:url(#ps-brand-gradient)_var(--color-brand-cyan)]" : "text-fg-tertiary group-hover/area:text-fg-secondary",
          )}
        />
        <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate animate-fade-in"}>{area.label}</span>
        {!collapsed && area.brand && fit < 1 ? (
          <span aria-hidden className={cn("shrink-0 text-[9px] font-semibold tracking-[0.22em]", active ? "text-brand-gradient" : "text-fg-tertiary/70")}>
            {area.brand}
          </span>
        ) : null}
        {collapsed ? (
          // 收合時的提示（滑過 300 ms 後或鍵盤焦點時出現）；名稱已在 sr-only 文字裡，這裡只是視覺上的重複
          <span
            aria-hidden
            className={cn(
              "material-popover pointer-events-none absolute top-1/2 left-full z-50 ml-3 -translate-y-1/2 rounded-md px-2.5 py-1 text-caption whitespace-nowrap text-fg",
              "opacity-0 transition-opacity duration-(--duration-fast) group-hover/area:opacity-100 group-hover/area:delay-300 group-focus-visible/area:opacity-100 group-focus-visible/area:delay-0",
            )}
          >
            {area.label}
            {area.brand ? <span className="ml-2 text-[9px] font-semibold tracking-[0.22em] text-fg-tertiary">{area.brand}</span> : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * 工作區導覽（側欄與行動版抽屜共用）：五個工作區，目前工作區＝品牌漸層淡底＋細框＋青色圖示，左緣一條品牌漸層標記
 * （換工作區時沿側欄滑過去）。創作類（Image／Video／推理 Studio）與工程類（元件修改、紀錄）
 * 之間有一條分隔線。目前工作區的連結帶 aria-current="page"。
 */
export function AreaNav({ memory, collapsed, onNavigate }: { memory: StudioMemory; collapsed: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const current = areaOf(pathname);
  const listRef = useRef<HTMLUListElement>(null);
  const fit = useFitLevel(listRef, AREA_FIT_LEVELS, collapsed, measureAreaLinks);
  const creative = AREAS.filter((area) => area.id === "image" || area.id === "studio" || area.id === "inference");
  const system = AREAS.filter((area) => !creative.includes(area));
  return (
    // 收合時不捲動（overflow 會裁掉向右展開的提示）；只有 5 個工作區，桌面高度一定放得下
    <nav aria-label={t("工作區")} className={cn("min-h-0 flex-1 py-2", collapsed ? "overflow-visible" : "overflow-x-hidden overflow-y-auto")}>
      {/* 第 2 級：欄寬固定為清單寬度，名稱改為截斷（之前的層級由連結內容決定欄寬） */}
      <ul ref={listRef} data-fit={fit} className={cn("relative grid gap-1 px-3", fit >= 2 && "grid-cols-1")}>
        {creative.map((area) => (
          <AreaLink key={area.id} area={area} memory={memory} active={area.id === current} collapsed={collapsed} fit={fit} onNavigate={onNavigate} />
        ))}
        <li aria-hidden className={cn("my-1.5 h-px bg-line-subtle", collapsed ? "mx-2" : "mx-1")} />
        {system.map((area) => (
          <AreaLink key={area.id} area={area} memory={memory} active={area.id === current} collapsed={collapsed} fit={fit} onNavigate={onNavigate} />
        ))}
        <ActiveIndicator container={listRef} edge="left" inset={8} as="li" className="w-[3px]" />
      </ul>
    </nav>
  );
}

const FOOTER_BUTTON = cn(
  "pressable relative flex h-9 items-center rounded-lg text-caption text-fg-tertiary outline-none hover:bg-raised/80 hover:text-fg",
  "focus-visible:outline-2 focus-visible:outline-focus",
);

/**
 * 側欄狀態按鈕：展開時「收合側欄」＋一顆「全收」小鈕；收合（圖示軌）時「展開側欄」與「全收」上下排；
 * 全收而滑出時一顆「固定側欄」（回到展開）。
 */
function SidebarModeButtons({ mode, onModeChange }: { mode: SidebarMode; onModeChange: (mode: SidebarMode) => void }) {
  if (mode === "hidden") {
    return (
      <button type="button" onClick={() => onModeChange("expanded")} title={t("固定側欄（不再自動收起）")} className={cn(FOOTER_BUTTON, "gap-2.5 px-3")}>
        <Pin aria-hidden className="size-4 shrink-0" />
        <span className="animate-fade-in">{t("固定側欄")}</span>
      </button>
    );
  }
  const collapsed = mode === "collapsed";
  const hide = (
    <button
      type="button"
      onClick={() => onModeChange("hidden")}
      aria-label={t("全收側欄")}
      title={t("全收側欄（指標停在螢幕左緣 1 秒後滑出）")}
      className={cn(FOOTER_BUTTON, "w-10 shrink-0 justify-center", collapsed && "mx-auto")}
    >
      <PanelLeftDashed aria-hidden className="size-4 shrink-0" />
    </button>
  );
  return (
    <div className={cn("flex", collapsed ? "flex-col gap-1" : "items-center gap-1")}>
      <button
        type="button"
        onClick={() => onModeChange(collapsed ? "expanded" : "collapsed")}
        aria-label={collapsed ? t("展開側欄") : t("收合側欄")}
        aria-expanded={!collapsed}
        title={collapsed ? t("展開側欄（顯示工作區名稱）") : t("收合側欄（只顯示圖示）")}
        className={cn(FOOTER_BUTTON, collapsed ? "mx-auto w-10 justify-center" : "min-w-0 flex-1 gap-2.5 px-3")}
      >
        {collapsed ? <PanelLeftOpen aria-hidden className="size-4 shrink-0" /> : <PanelLeftClose aria-hidden className="size-4 shrink-0" />}
        {collapsed ? null : <span className="truncate animate-fade-in">{t("收合側欄")}</span>}
      </button>
      {hide}
    </div>
  );
}

/** 側欄底部：進行中的 run（寬螢幕；窄螢幕在頂欄）、介面語言與側欄狀態按鈕。 */
function SidebarFooter({ collapsed, mode, onModeChange }: { collapsed: boolean; mode?: SidebarMode; onModeChange?: (mode: SidebarMode) => void }) {
  return (
    <div className="grid shrink-0 gap-1 border-t border-line-subtle px-3 py-2">
      {collapsed ? null : (
        <div className="hidden min-w-0 md:flex">
          <ActiveRun />
        </div>
      )}
      <LanguageSwitcher collapsed={collapsed} />
      {mode && onModeChange ? <SidebarModeButtons mode={mode} onModeChange={onModeChange} /> : null}
    </div>
  );
}

/** 側欄內容（品牌、工作區、底部）；抽屜傳 onNavigate（點了連結就關閉），不傳 mode／onModeChange。 */
export function SidebarContent({
  memory,
  collapsed,
  mode,
  onModeChange,
  onNavigate,
}: {
  memory: StudioMemory;
  collapsed: boolean;
  mode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  onNavigate?: () => void;
}) {
  return (
    <>
      <SidebarBrand collapsed={collapsed} onNavigate={onNavigate} />
      <AreaNav memory={memory} collapsed={collapsed} onNavigate={onNavigate} />
      <SidebarFooter collapsed={collapsed} mode={mode} onModeChange={onModeChange} />
    </>
  );
}
