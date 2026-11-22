import { withRecordValue } from "@/lib/json";
import { Activity, Gauge, Info, ScrollText, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useBlocker, useSearchParams } from "react-router";
import { componentEntries, nodeViews, useCatalog } from "@/api/catalog";
import { instanceKey } from "@/api/types";
import { AreaIcon } from "@/components/common/AreaIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/variants";
import { DocTabs } from "@/components/workbench/DocTabs";
import { ToolButton, ToolStrip } from "@/components/workbench/ToolStrip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import type { JsonObject } from "@/lib/json";
import { useSearchParamText } from "@/lib/useSearchParamText";
import {
  buildRows,
  filtersFromParams,
  groupRows,
  hasBulkValues,
  planBulk,
  planDraftSaves,
  rebaseDraft,
  RECORDER_MODES,
  RECORDER_SAVE_ID,
  replaceDraftValue,
  resultCounts,
  resultSummary,
  rowAnchorId,
  selectionFromParams,
  setDraftField,
  setSelected,
  withFilterParams,
  withSelectionParams,
  type BulkValues,
  type RowDraft,
  type TrackingFilters,
  type TrackingRow,
} from "./model";
import { RecorderInspector } from "./RecorderInspector";
import { TrackingTable } from "./TrackingTable";
import { BulkStrip, ModeLegend, SaveStrip } from "./TrackingStrips";
import { useRecordingBatch } from "./useRecordingBatch";
import { PATHS } from "@/app/paths";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const SUMMARY_ID = "tracking-save-summary";


/**
 * 追蹤設定（工作台）：中欄＝所有 Node 元件 instance 的 recorder（recording）設定表，可逐列修改或批次套用；
 * 右側檢視器＝選取元件完整的 RecorderConfig。篩選與選取都在網址（?q=&in=&mode=&node=&component=）。
 */
export function TrackingPage() {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const legendId = useId();
  const search = params.toString();
  // The search box shows local text (fast typing keeps every character); the URL follows when typing pauses
  const [query, setQuery] = useSearchParamText("q");
  const filters = { ...filtersFromParams(params), q: query };
  const selection = selectionFromParams(params);
  const inspectKey = selection ? instanceKey(selection.nodeId, selection.componentId) : null;
  const batch = useRecordingBatch();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [bulk, setBulk] = useState<BulkValues>({});
  const [legendOpen, setLegendOpen] = useState(false);
  /** 目前這一批的來源：讓觸發按鈕在進行中保持掛載（pending），焦點不掉。 */
  const [runKind, setRunKind] = useState<"bulk" | "all" | "row" | null>(null);
  /** 動作完成後按鈕消失時，把焦點移到穩定的位置（焦點已被使用者移走時不搶）。 */
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (!focusRequest) return;
    const active = document.activeElement;
    if (!active || active === document.body) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const nodes = nodeViews(catalog.data);
  const rows = buildRows(componentEntries(catalog.data), batch.local);
  const groups = groupRows(nodes, rows, filters);
  const visible = groups.flatMap((group) => group.rows);
  const targets = visible.filter((row) => selectedKeys.has(row.key) && !row.stale).map((row) => row.key);
  const selectedExisting = rows.filter((row) => selectedKeys.has(row.key)).length;
  const excluded = selectedExisting - targets.length;
  // 依表格順序（含被篩選隱藏的列）逐一儲存；草稿對應的元件已不在目錄時不計。
  const ordered = groupRows(nodes, rows, { q: "", node: "", mode: "" }).flatMap((group) => group.rows);
  const dirtyKeys = ordered.filter((row) => drafts[row.key]).map((row) => row.key);
  const hiddenDirty = dirtyKeys.filter((key) => !visible.some((row) => row.key === key)).length;
  const counts = resultCounts(batch.results);
  const summary = resultSummary(counts);
  const inspected = (inspectKey != null && inspectKey !== "") ? (rows.find((row) => row.key === inspectKey) ?? null) : null;
  const showBulk = selectedExisting > 0;
  const showSave = dirtyKeys.length > 0 || batch.running || summary !== "";

  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirtyKeys.length > 0 || batch.running) && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (dirtyKeys.length === 0 && !batch.running) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => { window.removeEventListener("beforeunload", handler); };
  }, [dirtyKeys.length, batch.running]);

  const updateFilters = (changes: Partial<TrackingFilters>) => { setParams((previous) => withFilterParams(previous, changes), { replace: true }); };
  const clearFilters = () => {
    setQuery("");
    updateFilters({ q: "", node: "", mode: "" });
  };
  const inspect = (row: TrackingRow) => { setParams((previous) => withSelectionParams(previous, { nodeId: row.nodeId, componentId: row.componentId }), { replace: true }); };

  const edit = (row: TrackingRow, key: string, value: unknown) => { setDrafts((previous) => withRecordValue(previous, row.key, setDraftField(row, previous[row.key], key, value))); };
  const replace = (row: TrackingRow, value: JsonObject) => { setDrafts((previous) => withRecordValue(previous, row.key, replaceDraftValue(row, previous[row.key], value))); };
  const revert = (row: TrackingRow, fromTable = true) => {
    setDrafts((previous) => withRecordValue(previous, row.key, undefined));
    if (fromTable) setFocusRequest({ id: rowAnchorId(row.key) });
  };

  const saveDrafts = (keys: readonly string[], kind: "all" | "row", focusId: string | null) => {
    if (batch.running) return;
    const plan = planDraftSaves(rows, drafts, keys);
    setRunKind(kind);
    void batch
      .run(plan, (item) => { setDrafts((previous) => withRecordValue(previous, item.key, undefined)); })
      .finally(() => {
        setRunKind(null);
        if (focusId != null && focusId !== "") setFocusRequest({ id: focusId });
      });
  };

  const applyBulk = () => {
    if (batch.running) return;
    setRunKind("bulk");
    void batch.run(planBulk(rows, targets, bulk, drafts)).finally(() => { setRunKind(null); });
  };

  /** 重新讀取（衝突、結果未知或失敗後由使用者觸發）：草稿套到最新版；觸發的按鈕消失時焦點回到 focusId。 */
  const reload = (row: TrackingRow, focusId: string) => {
    void batch.reload(row).then((latest) => {
      if (!latest) return;
      setDrafts((previous) => {
        const draft = previous[row.key];
        return draft ? withRecordValue(previous, row.key, rebaseDraft(draft, latest)) : previous;
      });
      setFocusRequest({ id: focusId });
    });
  };

  const bulkBlock = batch.running ? t("儲存進行中，請稍候") : targets.length === 0 ? t("勾選的元件都已被篩選隱藏或離線") : !hasBulkValues(bulk) ? t("先選擇要套用的值（模式、開關或 log）") : null;
  const liveText = batch.progress ? t("儲存中 {done}／{total}", { done: batch.progress.done, total: batch.progress.total }) : summary ? t("完成：{summary}", { summary }) : "";

  const center = (
    <>
      <DocTabs
        label={t("開啟的文件")}
        tabs={[{ id: "tracking", label: t("追蹤設定"), icon: Gauge, to: search ? `${PATHS.tracking}?${search}` : PATHS.tracking, active: true, title: t("各元件的 recorder 設定") }]}
        trailing={dirtyKeys.length > 0 ? <Badge tone="warning">{t("{dirtyKeysCount} 個元件有未儲存的變更", { dirtyKeysCount: dirtyKeys.length })}</Badge> : null}
      />
      <PageHeader
        icon={<AreaIcon area="records" size={28} />}
        title={t("追蹤設定")}
        description={t("各 Node 元件的 recorder 設定；變更於下一次呼叫生效，不需重新載入。選一列在右側檢視器編輯全部欄位。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <Link to={PATHS.recordings} className={buttonVariants({ variant: "quiet", size: "sm" })}>
            <ScrollText aria-hidden />
            {t("效能紀錄")}
          </Link>
        }
      />
      <ToolStrip label={t("篩選元件")} role="search">
        <div className="relative w-64 min-w-44">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            id="tracking-search"
            type="search"
            value={query}
            placeholder={t("搜尋 ID、名稱、provider、Node")}
            aria-label={t("搜尋元件（ID、名稱、provider、Node）")}
            autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); }}
            className="pl-8"
          />
        </div>
        <Select compact id="tracking-node" aria-label="Node" value={filters.node} onChange={(event) => { updateFilters({ node: event.target.value }); }} className="w-auto max-w-60 min-w-44">
          <option value="">{t("全部 Node")}</option>
          {nodes.map((node) => (
            <option key={node.node_id} value={node.node_id}>
              {node.label}
              {node.stale ? t("（離線）") : ""}
            </option>
          ))}
        </Select>
        <Select compact id="tracking-mode" aria-label={t("錄製模式")} value={filters.mode} onChange={(event) => { updateFilters({ mode: event.target.value }); }} className="w-auto min-w-32">
          <option value="">{t("全部模式")}</option>
          {RECORDER_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </Select>
        <ToolButton
          label={t("錄製模式說明（off／summary／detailed／trace）")}
          text={t("模式說明")}
          icon={<Info aria-hidden />}
          aria-expanded={legendOpen}
          aria-controls={legendId}
          onClick={() => { setLegendOpen(!legendOpen); }}
        />
        <p className="ml-auto pr-1 text-caption text-fg-tertiary" aria-live="polite">
          <T source={"顯示 <0>{visibleCount}</0>／<1>{rowsCount}</1> 個元件"} values={{ visibleCount: visible.length, rowsCount: rows.length }} slots={[<span key="slot-0" className="machine text-fg-secondary" />, <span key="slot-1" className="machine" />]} />
        </p>
      </ToolStrip>
      <ModeLegend id={legendId} hidden={!legendOpen} />
      {showBulk ? (
        <BulkStrip
          count={targets.length}
          hidden={excluded}
          values={bulk}
          onChange={setBulk}
          onApply={applyBulk}
          onClear={() => { setSelectedKeys(new Set()); }}
          blockReason={bulkBlock}
          pending={batch.running && runKind === "bulk"}
        />
      ) : null}
      {showSave ? (
        <SaveStrip
          summaryId={SUMMARY_ID}
          progress={batch.progress}
          dirtyCount={dirtyKeys.length}
          hiddenDirty={hiddenDirty}
          running={batch.running}
          saveAllPending={batch.running && runKind === "all"}
          showSaveAll={dirtyKeys.length > 0 || runKind === "all"}
          summary={summary}
          onSaveAll={() => { saveDrafts(dirtyKeys, "all", SUMMARY_ID); }}
          onStop={batch.stop}
          onRevertAll={() => { setDrafts({}); }}
          onClearResults={batch.clearResults}
        />
      ) : null}
      {catalog.isError && catalog.data ? (
        <div className="shrink-0 border-b border-line-subtle px-4 py-2">
          <ErrorCallout error={catalog.error} title={t("目錄更新失敗：顯示上一次的資料（可能過時）")} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {liveText}
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        {catalog.isPending ? (
          <div role="status" className="grid content-start gap-2 px-4 py-4">
            <p className="text-body text-fg-secondary">{t("正在讀取元件目錄…")}</p>
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} aria-hidden className="skeleton h-9 animate-shimmer" />
            ))}
          </div>
        ) : catalog.isError && !catalog.data ? (
          <div className="p-4">
            <ErrorCallout error={catalog.error} title={t("無法讀取元件目錄")} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching} />
          </div>
        ) : nodes.length === 0 ? (
          <EmptyState scene illustration="offline" title={t("目前沒有已登記的 Node")} description={t("Node 啟動後會自動向主控登記，元件的錄製設定會出現在這裡。")} />
        ) : rows.length === 0 ? (
          <EmptyState
            mark
            title={t("還沒有元件 instance")}
            description={t("建立元件後即可在這裡調整它的錄製設定。")}
            action={
              <Link to={PATHS.components} className={buttonVariants({ variant: "secondary" })}>
                {t("前往元件頁建立")}
              </Link>
            }
          />
        ) : (
          <>
            <TrackingTable
              groups={groups}
              drafts={drafts}
              results={batch.results}
              selected={selectedKeys}
              inspectedKey={inspectKey}
              running={batch.running}
              onSelect={(keys, on) => { setSelectedKeys((previous) => setSelected(previous, keys, on)); }}
              onEdit={edit}
              onSave={(row) => { saveDrafts([row.key], "row", rowAnchorId(row.key)); }}
              onRevert={revert}
              onInspect={inspect}
              onReload={(row) => { reload(row, rowAnchorId(row.key)); }}
            />
            {visible.length === 0 ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-subtle px-4 py-2 text-data text-fg-secondary">
                <T source={"沒有符合篩選的元件。<0>清除篩選</0>"} slots={[<Button key="slot-0" size="sm" variant="quiet" onClick={clearFilters} />]} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );

  const inspector = inspected ? (
    <RecorderInspector
      key={inspected.key}
      row={inspected}
      draft={drafts[inspected.key]}
      result={batch.results[inspected.key]}
      running={batch.running}
      onChange={replace}
      onSave={(row) => { saveDrafts([row.key], "row", null); }}
      onRevert={(row) => { revert(row, false); }}
      onReload={(row) => { reload(row, RECORDER_SAVE_ID); }}
    />
  ) : selection && catalog.isPending ? (
    <p role="status" className="px-4 py-6 text-body text-fg-secondary">
      {t("正在讀取元件目錄…")}
    </p>
  ) : selection ? (
    <EmptyState
      icon={<Info />}
      title={t("目錄中找不到這個元件")}
      description={
        <T source={"<0>{componentId}</0> 不在 Node <1>{nodeId}</1>的最新快照中：可能已被移除，或 Node 尚未回報最新快照。"} values={{ componentId: selection.componentId, nodeId: selection.nodeId }} slots={[<code key="slot-0" className="machine" />, <code key="slot-1" className="machine" />]} />
      }
    />
  ) : (
    <EmptyState mark title={t("選擇一個元件")} description={t("點表格中的元件名稱，在這裡檢視與編輯完整的錄製設定（RecorderConfig）；與表格共用同一份草稿。")} />
  );

  return (
    <>
      <WorkbenchPage
        storageKey="admin.tracking"
        centerLabel={t("追蹤設定表")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("錄製設定檢視器")}
        dockLabel={t("輸出面板")}
        dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
      />

      <Dialog open={blocker.state === "blocked"} onOpenChange={(open) => (open ? undefined : blocker.reset?.())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("離開追蹤設定？")}</DialogTitle>
            <DialogDescription>
              {batch.running ? t("批次儲存仍在進行；離開後不再送出尚未開始的請求。") : t("{dirtyKeysCount} 個元件有未儲存的錄製設定變更；離開會捨棄。", { dirtyKeysCount: dirtyKeys.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-data text-fg-secondary">{t("已儲存到 Node 的設定不受影響。")}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="quiet" onClick={() => blocker.reset?.()}>
              {t("留在此頁")}
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              {t("捨棄並離開")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
