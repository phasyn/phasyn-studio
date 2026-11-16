import { Boxes, FolderTree, PanelLeftClose, PanelLeftOpen, ServerOff, Workflow } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { componentEntries, nodeViews, useCatalog, type ComponentEntry } from "@/api/catalog";
import { usePipelines } from "@/api/pipelines";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { DockBody, DockHeader, DockPanel } from "@/components/workbench/DockPanel";
import { NodeTabs } from "@/components/workbench/NodeTabs";
import { COMPONENTS_PATH, nodeTabItems, resolveActiveNode } from "@/components/workbench/nodeTabModel";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { setRememberedNode, useRememberedNode } from "@/components/workbench/rememberedNode";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TreeView } from "@/components/workbench/TreeView";
import { filterTree } from "@/components/workbench/treeModel";
import { cn } from "@/lib/cn";
import { ADMIN_SECTIONS, componentFolderItems, explorerSectionOf, explorerSelection, type ExplorerTab } from "./adminTree";
import { PipelinesPane } from "./PipelinesPane";
import { SearchBox } from "./SearchBox";
import { useFolderExpansion } from "./useFolderExpansion";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** 收合時的 44 px 圖示軌：元件、元件組合兩頁的連結＋展開按鈕。 */
export function ExplorerRail({ onExpand }: { onExpand: () => void }) {
  return (
    <DockPanel as="nav" aria-label={t("元件修改導覽")} className="h-full w-11 items-center gap-1 py-1.5 max-md:h-auto max-md:w-full max-md:flex-row max-md:px-1.5">
      <ToolButton label={t("展開左欄")} icon={<PanelLeftOpen aria-hidden />} data-panel-toggle="" onClick={onExpand} />
      <span aria-hidden className="my-1 h-px w-6 bg-line-subtle max-md:mx-1 max-md:my-0 max-md:h-5 max-md:w-px" />
      {ADMIN_SECTIONS.map((section) => (
        <NavLink
          key={section.id}
          to={section.path}
          viewTransition
          aria-label={section.label}
          title={t("{label}：{hint}", { label: section.label, hint: section.hint })}
          className={({ isActive }) =>
            cn(
              "pressable relative grid size-8 place-items-center rounded-md text-fg-tertiary no-underline hover:bg-raised hover:text-fg [&_svg]:size-4",
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

/** 一個 Node 的資料夾樹（以 Node 為 key 重建，展開狀態依 Node 保存）。 */
function NodeFolderTree({ nodeId, entries, query, selectedId }: { nodeId: string; entries: readonly ComponentEntry[]; query: string; selectedId: string | null }) {
  const navigate = useNavigate();
  const items = componentFolderItems(nodeId, entries);
  const filtered = filterTree(items, query);
  const { expanded, onToggle } = useFolderExpansion(`admin.explorer.collapsed.${nodeId}`, items, selectedId, filtered.expand);
  if (items.length === 0) return <p className="px-3 py-4 text-caption text-fg-tertiary">{t("這個 Node 沒有元件 instance。")}</p>;
  if (filtered.items.length === 0) return <p className="px-3 py-4 text-caption text-fg-tertiary">{t("找不到符合「{query}」的元件。", { query: query.trim() })}</p>;
  return (
    <TreeView
      items={filtered.items}
      label={t("元件資料夾")}
      selectedId={selectedId}
      expanded={expanded}
      onToggle={onToggle}
      onActivate={(item) => {
        if (item.to) void navigate(item.to);
      }}
    />
  );
}

function ComponentsPane({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const catalog = useCatalog();
  const location = useLocation();
  const navigate = useNavigate();
  const remembered = useRememberedNode();
  const nodes = nodeViews(catalog.data);
  const entries = componentEntries(catalog.data);
  const nodeIds = nodes.map((node) => node.node_id);
  const params = new URLSearchParams(location.search);
  const onComponentsPage = location.pathname.replace(/\/+$/, "") === COMPONENTS_PATH;
  // 元件頁：與中欄相同，由網址決定；其他頁：上次看的 Node。
  const activeNode = resolveActiveNode(
    onComponentsPage
      ? { nodeIds, entries, node: params.get("node"), component: params.get("component"), remembered }
      : { nodeIds, entries, node: null, component: null, remembered },
  );
  const selectedId = explorerSelection(location.pathname, params);
  const known = activeNode !== null && nodeIds.includes(activeNode);

  const chooseNode = (nodeId: string) => {
    setRememberedNode(nodeId);
    if (!onComponentsPage) return;
    // 元件頁：分頁與中欄同步（換 Node 時取消選取另一個 Node 的 instance，保留搜尋與狀態篩選）。
    const next = new URLSearchParams(location.search);
    next.set("node", nodeId);
    next.delete("in");
    if (nodeId !== activeNode) next.delete("component");
    void navigate({ pathname: COMPONENTS_PATH, search: `?${next.toString()}` }, { replace: true });
  };

  if (catalog.isPending) {
    return (
      <p role="status" className="px-3 py-4 text-caption text-fg-secondary">
        {t("正在讀取元件目錄…")}
      </p>
    );
  }
  if (catalog.isError && !catalog.data) {
    return (
      <div className="p-2">
        <ErrorCallout error={catalog.error} title={t("無法讀取元件目錄")} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <p className="flex items-start gap-2 px-3 py-4 text-caption text-fg-tertiary">
        <ServerOff aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t("目前沒有已登記的 Node；Node 啟動後會自動向主控登記。")}
      </p>
    );
  }
  return (
    <>
      <div className="shrink-0 border-b border-line-subtle p-1.5">
        <NodeTabs
          items={nodeTabItems(nodes, entries)}
          value={activeNode}
          onChange={chooseNode}
          idPrefix="admin-explorer-node"
          label="Node"
          orientation="vertical"
          panelId="admin-explorer-node-panel"
        />
      </div>
      <div className="shrink-0 border-b border-line-subtle p-2">
        <SearchBox value={query} onChange={onQuery} placeholder={t("搜尋這個 Node 的元件…")} label={t("搜尋這個 Node 的元件（ID、名稱、provider、資料夾）")} />
      </div>
      <DockBody
        role="tabpanel"
        id="admin-explorer-node-panel"
        aria-labelledby={known ? `admin-explorer-node-tab-${activeNode}` : undefined}
        aria-label={known ? undefined : t("元件資料夾")}
      >
        {activeNode && known ? (
          <NodeFolderTree key={activeNode} nodeId={activeNode} entries={entries} query={query} selectedId={selectedId} />
        ) : (
          <p className="px-3 py-4 text-caption text-fg-tertiary">
            <T source={"目錄中沒有 Node <0>{value}</0>：可能已移除或尚未登記，請選擇上方的 Node。"} values={{ value: activeNode ?? "—" }} slots={[<code className="machine" />]} />
          </p>
        )}
      </DockBody>
    </>
  );
}

/**
 * 元件修改區左欄：「元件」分頁（Node 分頁＋該 Node 的資料夾樹）與「元件組合」分頁（清單＋新增）。
 * 分頁只切換左欄內容；點項目才開啟頁面。網址換到另一頁時自動切到對應分頁。
 */
export function AdminExplorer({ onCollapse }: { onCollapse: () => void }) {
  const location = useLocation();
  const catalog = useCatalog();
  const pipelines = usePipelines();
  const section = explorerSectionOf(location.pathname);
  const [tab, setTab] = useState<ExplorerTab>(section);
  const [lastSection, setLastSection] = useState<ExplorerTab>(section);
  if (section !== lastSection) {
    setLastSection(section);
    setTab(section);
  }
  const [queries, setQueries] = useState<Record<ExplorerTab, string>>({ components: "", pipelines: "" });
  const setQuery = (value: string) => setQueries((previous) => ({ ...previous, [tab]: value }));
  const componentCount = catalog.data ? componentEntries(catalog.data).length : null;

  return (
    <DockPanel as="nav" aria-label={t("元件修改導覽")} className="min-h-0 flex-1">
      <DockHeader icon={<FolderTree aria-hidden />} title={t("元件修改")} actions={<ToolButton label={t("收合左欄")} icon={<PanelLeftClose aria-hidden />} data-panel-toggle="" onClick={onCollapse} />} />
      <div className="flex min-h-9 shrink-0 items-stretch border-b border-line-subtle">
        <PanelTabs
          tabs={[
            { id: "components", label: t("元件"), icon: Boxes, count: componentCount },
            { id: "pipelines", label: t("元件組合"), icon: Workflow, count: pipelines.data?.items.length ?? null },
          ]}
          value={tab}
          onChange={(id) => setTab(id === "pipelines" ? "pipelines" : "components")}
          idPrefix="admin-explorer"
          label={t("元件修改左欄分頁")}
          className="flex-1 [&>button]:flex-1 [&>button]:justify-center"
        />
      </div>
      <div role="tabpanel" id={`admin-explorer-panel-${tab}`} aria-labelledby={`admin-explorer-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {tab === "components" ? (
          <ComponentsPane query={queries.components} onQuery={setQuery} />
        ) : (
          <PipelinesPane query={queries.pipelines} onQuery={setQuery} />
        )}
      </div>
    </DockPanel>
  );
}
