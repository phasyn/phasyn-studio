import { changesPage } from "./shell/viewTransition";
import { pageTransition, hasSlotContent } from "@/lib/dom";
import { PanelLeftClose, PanelLeftOpen, Search, type LucideIcon } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useMatches, useNavigate } from "react-router";
import { Input } from "@/components/ui/controls";
import { notePanelToggle, useContentSwapMotion, usePanelEnter } from "@/components/ui/motion";
import { DockBody, DockHeader, DockPanel } from "@/components/workbench/DockPanel";
import { OutlinerSlotContext } from "@/components/workbench/outlinerContext";
import { Splitter } from "@/components/workbench/Splitter";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TreeView } from "@/components/workbench/TreeView";
import { ancestorsOf, filterTree, type TreeItem } from "@/components/workbench/treeModel";
import { cn } from "@/lib/cn";
import { usePersistentFlag, usePersistentSet, usePersistentSize } from "@/lib/usePersistentSize";
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
        <DockBody ref={swap} data-scroll-owner="area" className="relative">
          {children}
        </DockBody>
      </DockPanel>
    </div>
  );
}

/**
 * 工作區版面（「紀錄」「推理」共用，與管理區 AdminLayout 相同的 Bridge 式骨架）：
 * 左欄＝資源樹（可拖曳寬度、可收合成 44 px 圖示軌）＋頁面以 portal 放入的「大綱」；右側是頁面。
 * 寬度與收合是這台瀏覽器的偏好（`phasyn.panel.<area>.explorer`、`phasyn.flag.<area>.explorer.collapsed`）；窄於 1280 px 預設收合。
 * 動作：收合／展開時寬度立即改變，新出現的資源樹或圖示軌從左緣淡入；換頁（中欄內容整個換掉）時新頁面淡入＋上移 4 px。
 */
export function AreaLayout({
  area,
  explorer,
  rail,
}: {
  /** 偏好鍵前綴（records、inference）。 */
  area: string;
  /** 展開時的資源樹面板；onCollapse 收合成圖示軌。 */
  explorer: (onCollapse: () => void) => ReactNode;
  /** 收合時的圖示軌；onExpand 展開資源樹。 */
  rail: (onExpand: () => void) => ReactNode;
}) {
  const selfFramed = useSelfFramed();
  const [width, setWidth] = usePersistentSize(`${area}.explorer`, 272, 208, 420);
  const [collapsed, setCollapsed] = usePersistentFlag(`${area}.explorer.collapsed`, typeof window !== "undefined" && window.innerWidth < 1280);
  const [outlinerSlot, setOutlinerSlot] = useState<HTMLDivElement | null>(null);
  const page = <Suspense fallback={<PageLoading />}>{<Outlet />}</Suspense>;
  const toggleKey = `${area}.explorer`;
  const sideEnter = usePanelEnter<HTMLDivElement>(toggleKey, "left");
  const pageSwap = useContentSwapMotion<HTMLDivElement>();
  const toggle = (next: boolean) => {
    notePanelToggle(toggleKey);
    setCollapsed(next);
  };

  return (
    <OutlinerSlotContext value={collapsed ? null : outlinerSlot}>
      <div className="flex h-full min-h-0 bg-canvas max-md:h-auto max-md:flex-col">
        <div
          key={collapsed ? "rail" : "explorer"}
          ref={sideEnter}
          className="flex min-h-0 shrink-0 flex-col gap-1.5 p-1.5 pr-0 max-md:pr-1.5"
          style={collapsed ? undefined : { width }}
        >
          {collapsed ? (
            rail(() => { toggle(false); })
          ) : (
            <>
              {explorer(() => { toggle(true); })}
              <div ref={setOutlinerSlot} className="flex h-[38%] max-h-[26rem] min-h-40 shrink-0 flex-col empty:hidden" />
            </>
          )}
        </div>
        {collapsed ? (
          <div aria-hidden className="w-1.5 shrink-0" />
        ) : (
          <Splitter orientation="vertical" value={width} min={208} max={420} onChange={setWidth} label={t("調整資源樹寬度")} className="max-md:hidden" defaultValue={272} />
        )}
        <div ref={pageSwap} className="min-h-0 min-w-0 flex-1">
          {selfFramed ? page : <CenterFrame>{page}</CenterFrame>}
        </div>
      </div>
    </OutlinerSlotContext>
  );
}

export interface AreaSection {
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  /** 只在完全相同的路徑時標示為目前頁（例如 /inference 不涵蓋 /inference/semantics）。 */
  end?: boolean;
}

/** 收合時的 44 px 圖示軌：各頁的圖示連結＋展開按鈕。 */
export function AreaRail({ label, title, sections, onExpand }: { label: string; title: string; sections: readonly AreaSection[]; onExpand: () => void }) {
  return (
    // 窄螢幕（< 840 px，版面上下堆疊）時改成橫向的一列，不佔一整欄高度
    <DockPanel as="nav" aria-label={label} className="h-full w-11 items-center gap-1 py-1.5 max-md:h-auto max-md:w-full max-md:flex-row max-md:px-1.5">
      <ToolButton label={t("展開{title}", { title })} icon={<PanelLeftOpen aria-hidden />} data-panel-toggle="" onClick={onExpand} />
      <span aria-hidden className="my-1 h-px w-6 bg-line-subtle max-md:mx-1 max-md:my-0 max-md:h-5 max-md:w-px" />
      {sections.map((section) => (
        <NavLink
          key={section.id}
          to={section.path}
          {...pageTransition()}
          end={section.end ?? false}
          aria-label={section.label}
          title={t("{label}：{hint}", { label: section.label, hint: section.hint })}
          className={({ isActive }) =>
            cn(
              "pressable relative grid size-8 place-items-center rounded-md text-fg-tertiary no-underline hover:bg-raised hover:text-fg active:bg-sunken [&_svg]:size-4",
              isActive && "bg-brand-gradient-soft text-action-fg shadow-[inset_0_0_0_1px_rgb(62_137_255_/_0.3)]",
            )
          }
        >
          <section.icon aria-hidden />
        </NavLink>
      ))}
    </DockPanel>
  );
}

function findItem(items: readonly TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    const found = item.children ? findItem(item.children, id) : null;
    if (found) return found;
  }
  return null;
}

/**
 * 左欄資源樹（與管理區相同的互動）：搜尋、展開狀態（瀏覽器偏好）、依網址標示目前物件；
 * 選取改變時展開它的祖先，使用者之後手動收合的祖先在下次選取改變前保持收合。
 */
export function AreaExplorer({
  title,
  label,
  icon,
  items,
  candidates,
  storageKey,
  defaultExpanded,
  searchPlaceholder,
  onCollapse,
  footer,
}: {
  title: string;
  /**
   * Name of the navigation landmark, unique on the page: the area's navigation, the same name as its collapsed rail
   * (for example 推理 Studio 導覽, while the page's own navigation is named differently).
   */
  label: string;
  icon: ReactNode;
  items: readonly TreeItem[];
  /** 依網址算出的選取候選（由具體到一般）；第一個存在於樹上的就是選取項。 */
  candidates: readonly string[];
  storageKey: string;
  defaultExpanded: readonly string[];
  searchPlaceholder: string;
  onCollapse: () => void;
  /** 樹下方的一行狀態（例如讀取失敗）。 */
  footer?: ReactNode;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [stored, setStored] = usePersistentSet(storageKey, defaultExpanded);
  const selectedId = candidates.find((id) => findItem(items, id)) ?? null;

  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId);
    setClosed(new Set());
  }
  const ancestors = (selectedId != null && selectedId !== "") ? ancestorsOf(items, selectedId) : [];
  const filtered = filterTree(items, query);
  const expanded = new Set<string>([...stored, ...ancestors.filter((id) => !closed.has(id)), ...filtered.expand]);

  const onToggle = (id: string, open: boolean) => {
    const next = new Set(stored);
    if (open) next.add(id);
    else next.delete(id);
    setStored(next);
    if (!open && ancestors.includes(id)) setClosed(new Set([...closed, id]));
    else if (open && closed.has(id)) setClosed(new Set([...closed].filter((value) => value !== id)));
  };

  return (
    <DockPanel as="nav" aria-label={label} className="min-h-0 flex-1">
      <DockHeader
        icon={icon}
        title={title}
        actions={<ToolButton label={t("收合{title}", { title })} icon={<PanelLeftClose aria-hidden />} data-panel-toggle="" onClick={onCollapse} />}
      />
      <div className="shrink-0 border-b border-line-subtle p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder={searchPlaceholder}
            aria-label={t("搜尋{title}", { title })}
            autoComplete="off"
            className="pl-8"
          />
        </div>
      </div>
      <DockBody className="relative">
        {filtered.items.length === 0 ? (
          <p className="px-3 py-4 text-caption text-fg-tertiary">{t("找不到符合「{query}」的項目。", { query: query.trim() })}</p>
        ) : (
          <TreeView
            items={filtered.items}
            label={title}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onActivate={(item) => {
              if (item.to != null && item.to !== "") void navigate(item.to, pageTransition(changesPage(item.to, pathname)));
            }}
          />
        )}
      </DockBody>
      {hasSlotContent(footer) ? <div className="shrink-0 border-t border-line-subtle px-3 py-1.5 text-caption text-fg-tertiary">{footer}</div> : null}
    </DockPanel>
  );
}
