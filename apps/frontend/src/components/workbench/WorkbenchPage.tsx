import { PanelBottomClose, PanelBottomOpen, PanelRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { notePanelToggle, usePanelEnter } from "@/components/ui/motion";
import { usePersistentChoice, usePersistentFlag, usePersistentSize } from "@/lib/usePersistentSize";
import { DockPanel } from "./DockPanel";
import { PanelTabs, type PanelTabItem } from "./PanelTabs";
import { Splitter } from "./Splitter";
import { ToolButton } from "./ToolStrip";
import { t } from "@/i18n";

export interface DockTabSpec extends PanelTabItem {
  /** 分頁內容：填滿 `flex min-h-0 flex-1 flex-col` 的容器，自己負責捲動。 */
  render: () => ReactNode;
}

export interface WorkbenchPageHandle {
  /** 選取並展開底部 dock 的分頁，焦點移到分頁按鈕（從事件處理器呼叫）。 */
  openDockTab: (id: string) => void;
}

/**
 * 管理頁的工作台骨架（AdminLayout 的資源樹右側）：
 *   中欄＝文件面板（文件分頁、工具列、內容）＋可收合的底部 dock；右欄＝Inspector。
 * 寬度／高度／開合／dock 分頁是這台瀏覽器的偏好；窄於 840 px 時改為上下堆疊、由頁面捲動。
 * 開合：尺寸立即改變，新出現的面板內容（Inspector、窄軌、dock 內容）從所在邊緣以 smooth 彈簧滑入 16 px 並淡入
 * （usePanelEnter，Motion 播放）。
 */
export function WorkbenchPage({
  storageKey,
  center,
  centerLabel,
  inspector,
  inspectorLabel = t("屬性檢視器"),
  dockTabs,
  dockLabel = t("輸出面板"),
  ref,
}: {
  storageKey: string;
  center: ReactNode;
  centerLabel: string;
  inspector?: ReactNode;
  inspectorLabel?: string;
  dockTabs?: readonly DockTabSpec[];
  dockLabel?: string;
  ref?: Ref<WorkbenchPageHandle>;
}) {
  const [inspectorWidth, setInspectorWidth] = usePersistentSize(`${storageKey}.inspector`, 384, 280, 600);
  const [dockHeight, setDockHeight] = usePersistentSize(`${storageKey}.dock`, 240, 120, 600);
  const [dockOpen, setDockOpen] = usePersistentFlag(`${storageKey}.dockOpen`, true);
  const [inspectorOpen, setInspectorOpen] = usePersistentFlag(`${storageKey}.inspectorOpen`, true);
  const dockIds = (dockTabs ?? []).map((tab) => tab.id);
  const [dockTab, setDockTab] = usePersistentChoice(`${storageKey}.dockTab`, dockIds[0] ?? "", dockIds);
  const activeDock = dockTabs?.find((tab) => tab.id === dockTab) ?? dockTabs?.[0];
  const dockPrefix = `${storageKey}-dock`;
  const inspectorKey = `${storageKey}.inspector`;
  const dockKey = `${storageKey}.dock`;
  const inspectorEnter = usePanelEnter<HTMLElement>(inspectorKey, "right");
  const railEnter = usePanelEnter<HTMLElement>(inspectorKey, "none");
  const dockEnter = usePanelEnter<HTMLDivElement>(dockKey, "bottom");
  const toggleInspector = (open: boolean) => {
    notePanelToggle(inspectorKey);
    setInspectorOpen(open);
  };
  const openDock = () => {
    if (dockOpen) return;
    // dock 的開合鈕與分頁都留在原處，焦點不需要轉交
    notePanelToggle(dockKey, { refocus: false });
    setDockOpen(true);
  };
  useImperativeHandle(ref, () => ({
    openDockTab: (id) => {
      if (!dockIds.includes(id)) return;
      setDockTab(id);
      openDock();
      document.getElementById(`${dockPrefix}-tab-${id}`)?.focus();
    },
  }));

  return (
    <div className="flex h-full min-h-0 min-w-0 p-1.5 pl-0 max-md:h-auto max-md:flex-col max-md:gap-1.5 max-md:pl-1.5">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col max-md:min-h-[70dvh]">
        <DockPanel aria-label={centerLabel} raised className="flex-1">
          {center}
        </DockPanel>
        {dockTabs && activeDock ? (
          <>
            {dockOpen ? (
              <Splitter orientation="horizontal" invert value={dockHeight} min={120} max={600} onChange={setDockHeight} label={t("調整輸出面板高度")} defaultValue={240} />
            ) : (
              <div aria-hidden className="h-1.5 shrink-0" />
            )}
            <DockPanel aria-label={dockLabel} className="shrink-0" style={dockOpen ? { height: dockHeight } : undefined}>
              {/* 分頁佔滿這一列的剩餘寬度（量測後收合）；換成多列時這一列跟著長高 */}
              <div className="flex min-h-9 shrink-0 items-stretch border-b border-line-subtle pr-1">
                <PanelTabs
                  tabs={dockTabs}
                  value={activeDock.id}
                  onChange={(id) => {
                    setDockTab(id);
                    openDock();
                  }}
                  idPrefix={dockPrefix}
                  label={dockLabel}
                  className="flex-1"
                />
                <div className="ml-auto flex items-center">
                  <ToolButton
                    label={dockOpen ? t("收合輸出面板") : t("展開輸出面板")}
                    icon={dockOpen ? <PanelBottomClose aria-hidden /> : <PanelBottomOpen aria-hidden />}
                    onClick={() => (dockOpen ? setDockOpen(false) : openDock())}
                  />
                </div>
              </div>
              {dockOpen ? (
                <div
                  ref={dockEnter}
                  role="tabpanel"
                  id={`${dockPrefix}-panel-${activeDock.id}`}
                  aria-labelledby={`${dockPrefix}-tab-${activeDock.id}`}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {activeDock.render()}
                </div>
              ) : null}
            </DockPanel>
          </>
        ) : null}
      </div>
      {inspector && inspectorOpen ? (
        <>
          <Splitter
            orientation="vertical"
            invert
            value={inspectorWidth}
            min={280}
            max={600}
            onChange={setInspectorWidth}
            label={t("調整{inspectorLabel}寬度", { inspectorLabel })}
            defaultValue={384}
            className="max-md:hidden"
          />
          <DockPanel
            key="inspector"
            ref={inspectorEnter}
            as="aside"
            aria-label={inspectorLabel}
            raised
            className="shrink-0 max-md:w-auto!"
            style={{ width: inspectorWidth }}
          >
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-subtle bg-canvas/60 pr-1 pl-3">
              <PanelRight aria-hidden className="size-3.5 shrink-0 text-fg-tertiary" />
              <p className="min-w-0 flex-1 truncate text-caption font-semibold text-fg-secondary">{inspectorLabel}</p>
              <ToolButton label={t("收合{inspectorLabel}", { inspectorLabel })} icon={<PanelRightClose aria-hidden />} data-panel-toggle="" onClick={() => toggleInspector(false)} />
            </div>
            {inspector}
          </DockPanel>
        </>
      ) : inspector ? (
        <>
          <div aria-hidden className="w-1.5 shrink-0 max-md:hidden" />
          <DockPanel key="inspector-rail" ref={railEnter} as="aside" aria-label={inspectorLabel} className="w-10 shrink-0 max-md:w-auto">
            <button
              type="button"
              onClick={() => toggleInspector(true)}
              title={t("展開{inspectorLabel}", { inspectorLabel })}
              data-panel-toggle=""
              className="flex min-h-0 flex-1 flex-col items-center gap-2 py-2 text-fg-tertiary transition-colors duration-(--duration-fast) outline-none hover:bg-brand-gradient-soft hover:text-fg active:bg-sunken active:duration-0 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset max-md:flex-row max-md:px-3"
            >
              <PanelRightOpen aria-hidden className="size-4 shrink-0" />
              <span className="text-caption [writing-mode:vertical-rl] max-md:[writing-mode:horizontal-tb]">{t("展開{inspectorLabel}", { inspectorLabel })}</span>
            </button>
          </DockPanel>
        </>
      ) : null}
    </div>
  );
}
