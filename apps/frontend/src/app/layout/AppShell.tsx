import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Outlet, useLocation } from "react-router";
import { Dialog, DialogDescription, DialogTitle, SheetContent } from "@/components/ui/dialog";
import { motionTransition, runViewTransition, useContentSwapMotion } from "@/components/ui/motion";
import { CommandPalette } from "@/features/command";
import { cn } from "@/lib/cn";
import { markRouteFocusPending } from "@/components/common/routeFocus";
import { SIDEBAR_WIDTH, useSidebarMode, useStudioMemory, type SidebarMode } from "./shell/shellState";
import { SidebarEdgeHandle } from "./shell/SidebarEdgeHandle";
import { useSidebarPeek } from "./shell/useSidebarPeek";
import { BrandLoading } from "./shell/BrandLoading";
import { SidebarContent } from "./shell/Sidebar";
import { TopBar } from "./shell/TopBar";
import { t } from "@/i18n";


/**
 * 整個 App 共用的品牌漸層（userSpaceOnUse 0–24，配合 lucide 的 24 單位座標）：目前導覽項目的圖示以
 * `stroke: url(#ps-brand-gradient)` 使用。放在外殼裡，只出現一次。
 */
function SharedGradients() {
  return (
    <svg aria-hidden focusable="false" width="0" height="0" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        <linearGradient id="ps-brand-gradient" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--color-brand-cyan)" }} />
          <stop offset="0.36" style={{ stopColor: "var(--color-brand-blue)" }} />
          <stop offset="0.68" style={{ stopColor: "var(--color-brand-iris)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-brand-violet)" }} />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * 固定在最底層、非常安靜的極光背景（品牌工作產生的 /brand/backgrounds/aurora.webp；還沒有時只剩深空漸層）：
 * 只透過半透明的側欄材質被看到，內容面板都是實心的。CSS background 讀不到圖時自動忽略那一層，不影響版面。
 * 品牌時刻畫面（載入、空狀態、找不到頁面）的 three.js 極光是另一個元件：components/common/AuroraBackdrop。
 */
function ShellBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 bg-canvas"
      style={{
        backgroundImage: "url(/brand/backgrounds/aurora.webp), var(--gradient-space)",
        backgroundSize: "cover, auto",
        backgroundPosition: "center, center",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

/**
 * App 外殼（Phasyn Studio，概念板的左側導覽構圖）：
 *   左＝側欄（material-sidebar 半透明材質：品牌標誌＋字標、五個工作區、收合／全收鈕）。三種狀態存在瀏覽器
 *       （窄於 1600 px 預設收合）：展開；收合成 64 px 圖示軌（名稱改成提示）；全收＝不佔寬度，指標停在螢幕左緣 1 秒
 *       （或點左緣把手、鍵盤焦點進入）時以 Motion 彈簧覆蓋滑出，指標離開（短暫寬限）、Esc 或焦點離開時收回；
 *   右＝頂欄（目前位置、進行中的 run）＋主區（各工作區的頁面）。
 * 窄於 840 px：側欄改成左側抽屜（頂欄的「開啟導覽」），版面上下堆疊、由主區捲動。
 * 外殼固定為視窗大小、本身不捲動（relative＋overflow-clip：任何 absolute 子孫都以外殼為準、被裁切，不會撐出文件捲軸）。
 * 動作：換頁由 react-router 的 viewTransition 交叉淡化、主要內容上升（View Transition；不支援時由頁面的 WAAPI 淡入）；
 * 側欄展開／收合以 View Transition（type＝sidebar）變形；進出全收與滑出／收回由 Motion 彈簧呈現；狀態都立即提交、不等動畫。
 * 命令面板只用鍵盤開啟（Ctrl／⌘＋K，或每一頁都能用的 Ctrl／⌘＋Shift＋P；Video Studio「編輯」的 Ctrl／⌘＋K 是新增編輯點）。
 */
export function AppShell() {
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  const mainSwap = useContentSwapMotion<HTMLElement>();
  const memory = useStudioMemory();
  const [mode, setMode] = useSidebarMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const hidden = mode === "hidden";
  const peek = useSidebarPeek(hidden, sidebarRef, handleRef);
  const collapsed = mode === "collapsed";

  useLayoutEffect(() => {
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      markRouteFocusPending();
    }
  }, [location.pathname]);

  // 展開↔收合以 View Transition 變形；進出全收由 Motion 滑動（兩者同時跑會互相干擾）
  const changeMode = (next: SidebarMode) => {
    if (next === mode) return;
    if (next === "hidden" || hidden) setMode(next);
    else runViewTransition("sidebar", () => setMode(next));
    // 剛按下「全收」：焦點不留在滑出畫面的側欄裡，改到左緣把手（下一格才掛上）
    if (next === "hidden") requestAnimationFrame(() => handleRef.current?.focus({ preventScroll: true }));
  };
  const revealFromHandle = () => {
    peek.reveal();
    sidebarRef.current?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true });
  };

  return (
    <div className={cn("relative grid h-dvh overflow-clip text-fg max-md:grid-cols-1", hidden ? "grid-cols-1" : "grid-cols-[auto_minmax(0,1fr)]")}>
      <ShellBackdrop />
      <SharedGradients />
      <a
        href="#main-content"
        className="sr-only-focusable fixed top-2 left-4 z-50 rounded-md border border-focus bg-surface px-4 py-2 text-body text-fg"
      >
        {t("跳至主要內容")}
      </a>
      {hidden ? <SidebarEdgeHandle ref={handleRef} revealed={peek.revealed} onReveal={revealFromHandle} {...peek.edgeHandlers} /> : null}
      {/* 全收時固定在左側、平時移出畫面（仍在 Tab 順序裡：焦點進入就滑出），滑出時覆蓋在主區上 */}
      <motion.aside
        ref={sidebarRef}
        id="shell-sidebar"
        aria-label={t("側欄")}
        initial={false}
        animate={{ x: hidden && !peek.revealed ? "-100%" : 0 }}
        transition={hidden && !peek.revealed ? motionTransition("spring-smooth", "spring-smooth") : motionTransition("spring-snappy", "spring-snappy")}
        {...(hidden ? peek.panelHandlers : {})}
        className={cn(
          "material-sidebar flex h-full min-h-0 flex-col [view-transition-name:shell-sidebar] max-md:hidden",
          // 覆蓋在主區上時底色更實，下面的時間軸與文字不會透出來干擾閱讀
          hidden ? "fixed inset-y-0 left-0 z-40 bg-[rgb(10_15_28_/_0.9)]" : "relative z-30",
          hidden && peek.revealed && "shadow-[24px_0_48px_-12px_rgb(0_0_0_/_0.55)]",
        )}
        style={{ width: collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
      >
        <SidebarContent memory={memory} collapsed={collapsed} mode={mode} onModeChange={changeMode} />
      </motion.aside>
      {/* 頂欄（麵包屑）只在窄螢幕：開導覽抽屜用；寬螢幕省下這一列，進行中的 run 在側欄底部 */}
      <div className="relative grid min-h-0 min-w-0 grid-rows-[2.75rem_minmax(0,1fr)] bg-canvas md:grid-rows-[minmax(0,1fr)]">
        <div className="[view-transition-name:shell-topbar] md:hidden">
          <TopBar memory={memory} navOpen={drawerOpen} onOpenNav={() => setDrawerOpen(true)} />
        </div>
        <main
          ref={mainSwap}
          id="main-content"
          tabIndex={-1}
          className={cn("relative min-h-0 min-w-0 outline-none [view-transition-name:main-content]", "max-md:overflow-y-auto md:overflow-clip")}
        >
          <Suspense fallback={<BrandLoading label={t("正在載入…")} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" closeLabel={t("關閉導覽")} aria-describedby="shell-drawer-description" className="w-[min(18rem,86vw)] md:hidden">
          <DialogTitle className="sr-only">{t("導覽")}</DialogTitle>
          <DialogDescription id="shell-drawer-description" className="sr-only">
            {t("選擇工作區；點選後抽屜會關閉。")}
          </DialogDescription>
          <SidebarContent memory={memory} collapsed={false} onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Dialog>
      <CommandPalette />
    </div>
  );
}
