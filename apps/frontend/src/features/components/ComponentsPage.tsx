import { Activity, Boxes, CircleCheck, Eraser, Logs, Plus, Search, ServerOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useBlocker, useSearchParams } from "react-router";
import { componentEntries, nodeViews, useCatalog, type ComponentEntry } from "@/api/catalog";
import type { InstanceSettings, SettingsView } from "@/api/generated/contracts";
import { instanceKey } from "@/api/types";
import { AreaIcon } from "@/components/common/AreaIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { TimeText } from "@/components/common/values";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { useChangeFade } from "@/components/ui/motion";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { folderSuggestions } from "@/components/workbench/componentFolders";
import { DocTabs } from "@/components/workbench/DocTabs";
import { NodeTabs } from "@/components/workbench/NodeTabs";
import { nodeTabItems, resolveActiveNode } from "@/components/workbench/nodeTabModel";
import { setRememberedNode, useRememberedNode } from "@/components/workbench/rememberedNode";
import { ToolButton, ToolStrip } from "@/components/workbench/ToolStrip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog, ComponentEventsLog } from "@/features/activity";
import { valuesEqual } from "@/lib/json";
import { useSearchParamText } from "@/lib/useSearchParamText";
import { CloneDialog } from "./CloneDialog";
import { ComponentInspector, type DraftEntry } from "./ComponentInspector";
import { ComponentTable } from "./ComponentTable";
import { buildMetaPatch, hasActiveFilters, matchesFilters, type ComponentFilters, type MetaDraft } from "./componentsModel";
import { NewInstanceDialog } from "./NewInstanceDialog";
import { ApplyPresetDialog, SavePresetDialog, type ApplyPresetTarget, type SavePresetTarget } from "./PresetDialogs";
import { t } from "@/i18n";
import { T as Trans } from "@/i18n/T";

const STATE_OPTIONS = [
  { value: "", label: t("全部狀態") },
  { value: "ready", label: t("就緒") },
  { value: "busy", label: t("呼叫中") },
  { value: "loading", label: t("載入中") },
  { value: "stopped", label: t("已停止") },
  { value: "stopping", label: t("停止中") },
  { value: "error", label: t("錯誤") },
];

function isDirty(entry: DraftEntry | undefined): boolean {
  return entry !== undefined && !valuesEqual(entry.base.stored, entry.draft);
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

/**
 * 元件頁：Node 分頁（與左欄同步，網址 ?node=＆component=）→ 該 Node 的 instance 表（依資料夾分組、欄寬可調）＋右側檢視器。
 * 未儲存的設定與基本資料草稿依 instance 保留，離開頁面前確認。
 */
export function ComponentsPage() {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  // The search box shows local text (fast typing keeps every character); the URL follows when typing pauses
  const [query, setQuery] = useSearchParamText("q");
  const remembered = useRememberedNode();
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const [metaDrafts, setMetaDrafts] = useState<Record<string, MetaDraft>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<ComponentEntry | null>(null);
  const [presetSave, setPresetSave] = useState<SavePresetTarget | null>(null);
  const [presetApply, setPresetApply] = useState<(ApplyPresetTarget & { key: string; base: SettingsView }) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filters: ComponentFilters = { q: query, state: params.get("state") ?? "" };
  const filtering = hasActiveFilters(filters);
  const nodes = nodeViews(catalog.data);
  const entries = componentEntries(catalog.data);
  const nodeIds = nodes.map((node) => node.node_id);
  const selectedComponent = params.get("component");
  const activeNodeId = resolveActiveNode({ nodeIds, entries, node: params.get("node"), component: selectedComponent, remembered });
  const activeNode = nodes.find((node) => node.node_id === activeNodeId) ?? null;
  // Another Node's components replace the table: they fade in like every other tab panel (not on the first load)
  const nodePanel = useChangeFade<HTMLDivElement>(activeNodeId);
  const nodeEntries = entries.filter((entry) => entry.node.node_id === activeNodeId);
  const shownEntries = nodeEntries.filter((entry) => matchesFilters(entry, filters));
  const selectedKey = (activeNodeId != null && activeNodeId !== "") && (selectedComponent != null && selectedComponent !== "") ? instanceKey(activeNodeId, selectedComponent) : null;
  const selected = (selectedKey != null && selectedKey !== "") ? (entries.find((entry) => entry.key === selectedKey) ?? null) : null;
  const dirtyKeys = [
    ...new Set([
      ...Object.keys(drafts).filter((key) => isDirty(drafts[key])),
      ...Object.keys(metaDrafts).filter((key) => {
        const entry = entries.find((item) => item.key === key);
        const draft = metaDrafts[key];
        return entry !== undefined && draft !== undefined && buildMetaPatch(entry.descriptor, draft).dirty;
      }),
    ]),
  ];

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyKeys.length > 0 && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => { window.removeEventListener("beforeunload", handler); };
  }, [dirtyKeys.length]);

  const updateParams = (changes: Record<string, string | null>, options: { flushSync?: boolean } = {}) => { setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value != null && value !== "") next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true, ...options },
    ); };

  // 網址是 Node 的狀態來源：沒有 ?node= 時寫入目前採用的 Node（replace），左欄與中欄因此一致；並記住這台瀏覽器上次看的 Node。
  const urlNode = params.get("node");
  const knownActive = activeNodeId !== null && nodeIds.includes(activeNodeId);
  useEffect(() => {
    if ((activeNodeId != null && activeNodeId !== "") && urlNode !== activeNodeId) {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("node", activeNodeId);
          next.delete("in");
          return next;
        },
        { replace: true },
      );
    }
  }, [activeNodeId, urlNode, setParams]);
  useEffect(() => {
    if ((activeNodeId != null && activeNodeId !== "") && knownActive) setRememberedNode(activeNodeId);
  }, [activeNodeId, knownActive]);

  const clearFilters = () => {
    setQuery("");
    updateParams({ q: null, state: null });
  };

  const chooseNode = (nodeId: string) => { updateParams({ node: nodeId, component: nodeId === activeNodeId ? selectedComponent : null, in: null }); };
  const select = (nodeId: string, componentId: string) => { updateParams({ node: nodeId, component: componentId, in: null }); };

  const setDraftEntry = (key: string, next: DraftEntry | null) => { setDrafts((previous) => (next === null ? withoutKey(previous, key) : { ...previous, [key]: next })); };
  const setMetaDraft = (key: string, next: MetaDraft | null) => { setMetaDrafts((previous) => (next === null ? withoutKey(previous, key) : { ...previous, [key]: next })); };

  const nodeTabs = nodeTabItems(nodes, entries);
  const suggestions = folderSuggestions(nodeEntries.map((entry) => entry.descriptor));

  const tablePanel = !(activeNodeId != null && activeNodeId !== "") ? null : !knownActive ? (
    <EmptyState
      icon={<ServerOff />}
      title={t("目錄中沒有這個 Node")}
      description={
        <Trans source={"<0>{activeNodeId}</0> 不在目前的目錄中：可能已移除或尚未登記。請選擇上方的 Node 分頁。"} values={{ activeNodeId }} slots={[<code key="slot-0" className="machine" />]} />
      }
    />
  ) : nodeEntries.length === 0 ? (
    <EmptyState
      mark
      title={t("這個 Node 沒有元件 instance")}
      description={activeNode?.snapshot ? t("Node 已回報快照，但沒有任何 instance。") : t("尚未收到這個 Node 的元件快照（Node 啟動後會自動上報）。")}
      action={
        <Button size="sm" icon={<Plus aria-hidden />} onClick={() => { setNewOpen(true); }}>
          {t("新建 instance")}
        </Button>
      }
    />
  ) : shownEntries.length === 0 ? (
    <EmptyState
      icon={<Search />}
      title={t("篩選後沒有符合的元件")}
      description={t("目前的搜尋與狀態篩選只套用在這個 Node。")}
      action={
        <Button size="sm" icon={<Eraser aria-hidden />} onClick={clearFilters}>
          {t("清除篩選")}
        </Button>
      }
    />
  ) : (
    <ComponentTable
      key={activeNodeId}
      nodeId={activeNodeId}
      entries={shownEntries}
      filtering={filtering}
      selectedKey={selectedKey}
      onSelect={(entry) => { select(entry.node.node_id, entry.descriptor.component_id); }}
    />
  );

  const center = (
    <>
      <DocTabs
        label={t("開啟的文件")}
        tabs={[{ id: "components", label: t("元件"), icon: Boxes, to: "/admin/components", active: true, title: t("各 Node 的元件 instance") }]}
        trailing={dirtyKeys.length > 0 ? <Badge tone="warning">{t("{dirtyKeysCount} 個 instance 有未儲存的草稿", { dirtyKeysCount: dirtyKeys.length })}</Badge> : null}
      />
      <PageHeader
        icon={<AreaIcon area="components" size={28} />}
        title={t("元件")}
        description={t("依 Node 分頁、依資料夾分組的元件 instance；選一列在右側檢視器編輯名稱、分類、設定與啟停。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <Button variant="primary" size="sm" icon={<Plus aria-hidden />} onClick={() => { setNewOpen(true); }}>
            {t("新建 instance")}
          </Button>
        }
      />
      {nodes.length > 0 ? (
        <div className="flex shrink-0 items-stretch border-b border-line-subtle pl-1.5">
          <NodeTabs items={nodeTabs} value={knownActive ? activeNodeId : null} onChange={chooseNode} idPrefix="components-node" label="Node" panelId="components-node-panel" className="min-w-0 flex-1" />
        </div>
      ) : null}
      <ToolStrip label={t("篩選這個 Node 的元件")} role="search">
        <div className="relative w-64 min-w-44">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            id="component-search"
            type="search"
            value={query}
            placeholder={t("搜尋 ID、名稱、provider、資料夾")}
            aria-label={t("搜尋這個 Node 的元件（ID、名稱、provider、device、資料夾）")}
            autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); }}
            className="pl-8"
          />
        </div>
        <Select compact id="component-state-filter" aria-label={t("狀態")} value={filters.state} onChange={(event) => { updateParams({ state: event.target.value }); }} className="w-32">
          {STATE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {filtering ? <ToolButton label={t("清除篩選")} text={t("清除")} icon={<Eraser aria-hidden />} onClick={clearFilters} /> : null}
        <p className="ml-auto flex flex-wrap items-center gap-x-2 pr-1 text-caption text-fg-tertiary" aria-live="polite">
          {activeNode?.snapshot ? (
            <span className="hidden xl:inline">
              {t("{platform} · 快照", { platform: activeNode.snapshot.platform })} <TimeText iso={activeNode.snapshot.observed_at} />
            </span>
          ) : null}
          {(activeNode?.stale === true) ? <span className="text-warning">{t("Node 離線：顯示最後快照，狀態可能已改變")}</span> : null}
          <span>
            <Trans source={"顯示 <0>{shownEntriesCount}</0>／<1>{nodeEntriesCount}</1> 個 instance"} values={{ shownEntriesCount: shownEntries.length, nodeEntriesCount: nodeEntries.length }} slots={[<span key="slot-0" className="machine text-fg-secondary" />, <span key="slot-1" className="machine" />]} />
          </span>
        </p>
      </ToolStrip>
      {(notice ?? "") || (catalog.isError && catalog.data) ? (
        <div className="grid shrink-0 gap-2 border-b border-line-subtle px-4 py-2">
          {(notice != null && notice !== "") ? (
            <p key={notice} role="status" className="flex min-w-0 items-start gap-1.5 text-data text-success animate-rise-in">
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{notice}</span>
            </p>
          ) : null}
          {catalog.isError && catalog.data ? (
            <ErrorCallout error={catalog.error} title={t("目錄更新失敗：顯示上一次的資料（可能過時）")} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
          ) : null}
        </div>
      ) : null}
      <div
        ref={nodePanel}
        role={knownActive ? "tabpanel" : undefined}
        id="components-node-panel"
        aria-labelledby={knownActive ? `components-node-tab-${activeNodeId}` : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {catalog.isPending ? (
          <div role="status" className="grid gap-1.5 px-4 py-4">
            <p className="pb-1 text-data text-fg-secondary">{t("正在讀取元件目錄…")}</p>
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index} aria-hidden className="skeleton h-7 animate-shimmer" />
            ))}
          </div>
        ) : catalog.isError && !catalog.data ? (
          <div className="p-4">
            <ErrorCallout error={catalog.error} title={t("無法讀取元件目錄")} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
          </div>
        ) : nodes.length === 0 ? (
          <EmptyState scene illustration="offline" title={t("目前沒有已登記的 Node")} description={t("Node 啟動後會自動向主控登記，元件會出現在這裡；不需要先手動加入。")} />
        ) : (
          tablePanel
        )}
      </div>
    </>
  );

  const inspector =
    selected && (selectedKey != null && selectedKey !== "") ? (
      <ComponentInspector
        key={selectedKey}
        entry={selected}
        draftEntry={drafts[selectedKey] ?? null}
        onDraftEntryChange={(next) => { setDraftEntry(selectedKey, next); }}
        metaDraft={metaDrafts[selectedKey] ?? null}
        onMetaDraftChange={(next) => { setMetaDraft(selectedKey, next); }}
        folderSuggestions={suggestions}
        onClone={() => { setCloneSource(selected); }}
        onSavePreset={(settings) => { setPresetSave({ componentId: selected.descriptor.component_id, providerId: selected.descriptor.provider_id, settings }); }}
        onApplyPreset={(base, draft) => { setPresetApply({ key: selectedKey, base, providerId: selected.descriptor.provider_id, draft }); }}
        onDeleted={(nodeId, componentId) => {
          const key = instanceKey(nodeId, componentId);
          setDraftEntry(key, null);
          setMetaDraft(key, null);
          setNotice(t("已刪除 {componentId}：定義已從 Node 移除，效能紀錄與檔案保留。", { componentId }));
          // 同步提交網址（不等 transition），避免目錄更新先讓檢視器顯示「找不到」；觸發刪除的按鈕已消失，焦點移到這個 Node 的分頁。
          updateParams({ node: nodeId, component: null }, { flushSync: true });
          document.getElementById(`components-node-tab-${nodeId}`)?.focus();
        }}
      />
    ) : (selectedKey != null && selectedKey !== "") ? (
      <EmptyState
        icon={<Boxes />}
        title={t("目錄中找不到此 instance")}
        description={
          <Trans source={"<0>{selectedComponent}</0> 不在 Node <1>{value}</1>的最新快照中：可能已刪除，或剛建立、等待 Node 回報（數秒內更新）。"} values={{ selectedComponent, value: activeNode?.label ?? activeNodeId }} slots={[<code key="slot-0" className="machine" />, <code key="slot-1" className="machine" />]} />
        }
      />
    ) : (
      <EmptyState
        mark
        title={t("選擇一個 instance")}
        description={t("基本資料（名稱、資料夾、自動啟動）、設定、子部件、輸入輸出、已保存與目前載入的對照，以及啟停與刪除。")}
      />
    );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.components"
        centerLabel={t("元件清單")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("元件檢視器")}
        dockLabel={t("元件輸出面板")}
        dockTabs={[
          {
            id: "events",
            label: selected ? t("事件・{component_id}", { component_id: selected.descriptor.component_id }) : t("事件"),
            icon: Logs,
            render: () => <ComponentEventsLog nodeId={selected?.node.node_id ?? ""} componentId={selected?.descriptor.component_id ?? ""} />,
          },
          { id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> },
        ]}
      />

      <NewInstanceDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        nodes={nodes}
        entries={entries}
        initialNodeId={knownActive ? activeNodeId : null}
        onCreated={(nodeId, componentId) => {
          setNewOpen(false);
          setNotice(t("已建立 {componentId}；元件尚未啟動。", { componentId }));
          select(nodeId, componentId);
        }}
      />
      <CloneDialog
        source={cloneSource}
        nodes={nodes}
        entries={entries}
        onOpenChange={(open) => { if (!(open)) { setCloneSource(null); } }}
        onCreated={(nodeId, componentId) => {
          setCloneSource(null);
          setNotice(t("已複製為 {componentId}；元件尚未啟動。", { componentId }));
          select(nodeId, componentId);
        }}
      />
      <SavePresetDialog
        target={presetSave}
        onOpenChange={(open) => { if (!(open)) { setPresetSave(null); } }}
        onDone={(preset) => {
          setPresetSave(null);
          setNotice(t("已保存 preset「{label}」（{preset_id}）。", { label: preset.label, preset_id: preset.preset_id }));
        }}
      />
      <ApplyPresetDialog
        target={presetApply}
        onOpenChange={(open) => { if (!(open)) { setPresetApply(null); } }}
        onApply={(next: InstanceSettings) => {
          if (presetApply) setDraftEntry(presetApply.key, { base: presetApply.base, draft: next });
          setPresetApply(null);
          setNotice(t("preset 已套用到草稿；檢視差異後按「儲存設定」才會保存。"));
        }}
      />

      <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => (open ? undefined : blocker.reset?.())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("離開元件頁？")}</DialogTitle>
            <DialogDescription>{t("{dirtyKeysCount} 個 instance 有未儲存的草稿（設定或基本資料）；離開會捨棄這些草稿。", { dirtyKeysCount: dirtyKeys.length })}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-data text-fg-secondary">{t("草稿只存在這個頁面；Node 上已保存的設定與基本資料不受影響。")}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet" onClick={() => blocker.reset?.()}>
              {t("留在此頁")}
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              {t("捨棄草稿並離開")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
