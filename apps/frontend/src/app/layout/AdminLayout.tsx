import { Suspense, useState, type ReactNode } from "react";
import { Outlet, useMatches } from "react-router";
import { notePanelToggle, useContentSwapMotion, usePanelEnter } from "@/components/ui/motion";
import { DockBody, DockPanel } from "@/components/workbench/DockPanel";
import { OutlinerSlotContext } from "@/components/workbench/outlinerContext";
import { Splitter } from "@/components/workbench/Splitter";
import { usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { AdminExplorer, ExplorerRail } from "./admin/AdminExplorer";
import { BrandLoading } from "./shell/BrandLoading";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

/** 路由 handle：`{ frame: "self" }` 的頁面自己渲染工作台骨架（WorkbenchPage）；其他頁面放進單一中欄面板。 */
function useSelfFramed(): boolean {
  const matches = useMatches();
  const last = matches[matches.length - 1];
  const handle = last?.handle;
  return isRecord(handle) && handle["frame"] === "self";
}

function PageLoading() {
  return <BrandLoading label={t("正在載入頁面…")} />;
}

function CenterFrame({ children }: { children: ReactNode }) {
  const swap = useContentSwapMotion<HTMLDivElement>();
  return (
    <div className="h-full min-h-0 p-1.5 pl-0 max-md:pl-1.5">
      <DockPanel raised className="h-full">
        <DockBody ref={swap} data-scroll-owner="admin">
          {children}
        </DockBody>
      </DockPanel>
    </div>
  );
}

/**
 * 元件修改區（Bridge 式工作台）：左欄＝「元件／元件組合」分頁的導覽＋頁面提供的「大綱」（例如元件組合的步驟大綱），右側是頁面。
 * 左欄寬度與收合是瀏覽器偏好；窄於 1280 px 預設收合成圖示軌。
 * 寬螢幕時整個區域以 overflow: clip 固定在視窗內：頁面內容只在各面板自己的 scroll owner 內捲動，
 * 不會因為焦點移動或內容暫時變高而把整個 App 捲上去（留下大片空白）。
 * 動作：收合／展開時寬度立即改變，新出現的左欄或圖示軌從左緣淡入；換頁（中欄內容整個換掉）時新頁面淡入＋上移 4 px。
 */
export function AdminLayout() {
  const selfFramed = useSelfFramed();
  const [width, setWidth] = usePersistentSize("admin.explorer", 272, 208, 420);
  const [collapsed, setCollapsed] = usePersistentFlag("admin.explorer.collapsed", typeof window !== "undefined" && window.innerWidth < 1280);
  const [outlinerSlot, setOutlinerSlot] = useState<HTMLDivElement | null>(null);
  const page = <Suspense fallback={<PageLoading />}>{<Outlet />}</Suspense>;
  const sideEnter = usePanelEnter<HTMLDivElement>("admin.explorer", "left");
  const pageSwap = useContentSwapMotion<HTMLDivElement>();
  const toggle = (next: boolean) => {
    notePanelToggle("admin.explorer");
    setCollapsed(next);
  };

  return (
    <OutlinerSlotContext value={collapsed ? null : outlinerSlot}>
      <div className="flex h-full min-h-0 bg-canvas md:overflow-clip max-md:h-auto max-md:flex-col">
        <div
          key={collapsed ? "rail" : "explorer"}
          ref={sideEnter}
          className="flex min-h-0 shrink-0 flex-col gap-1.5 p-1.5 pr-0 max-md:pr-1.5"
          style={collapsed ? undefined : { width }}
        >
          {collapsed ? (
            <ExplorerRail onExpand={() => { toggle(false); }} />
          ) : (
            <>
              <AdminExplorer onCollapse={() => { toggle(true); }} />
              <div ref={setOutlinerSlot} className="flex h-[38%] max-h-[26rem] min-h-40 shrink-0 flex-col empty:hidden" />
            </>
          )}
        </div>
        {collapsed ? (
          <div aria-hidden className="w-1.5 shrink-0" />
        ) : (
          <Splitter orientation="vertical" value={width} min={208} max={420} onChange={setWidth} label={t("調整左欄寬度")} className="max-md:hidden" defaultValue={272} />
        )}
        <div ref={pageSwap} className="min-h-0 min-w-0 flex-1 md:overflow-clip">
          {selfFramed ? page : <CenterFrame>{page}</CenterFrame>}
        </div>
      </div>
    </OutlinerSlotContext>
  );
}
