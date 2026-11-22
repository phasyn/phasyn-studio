// 效能紀錄（工作台）：左下大綱＝搜尋與篩選（URL 同步）；中欄＝文件分頁［效能紀錄（列表）＋開啟中的 recording］；
// 右側檢視器＝recording 的事實、ID、匯出、比較與選取項目細節；底部 dock＝原始事件（開啟 recording 時）。
// 路由：/records/recordings 與 /records/recordings/:recordingId；篩選、頁籤（tab）與 stream 都在 search params，可重新整理、上一頁與分享。
import { Funnel, Logs, ScrollText } from "lucide-react";
import { useCallback, use, useId, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AreaIcon } from "@/components/common/AreaIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { DocTabs, type DocTab } from "@/components/workbench/DocTabs";
import { providerKind } from "@/components/workbench/kinds";
import { Outliner } from "@/components/workbench/Outliner";
import { OutlinerSlotContext } from "@/components/workbench/outlinerContext";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { WorkbenchPage, type DockTabSpec, type WorkbenchPageHandle } from "@/components/workbench/WorkbenchPage";
import { useNodeLabels, useRecording } from "./api";
import { CompareTray } from "./components/CompareControls";
import { LoadingBlock } from "./components/Feedback";
import { FiltersForm } from "./components/FiltersForm";
import { RecordingDetail } from "./components/RecordingDetail";
import { RecordingInspector } from "./components/RecordingInspector";
import { RecordingList } from "./components/RecordingList";
import { DEFAULT_EVENT_FILTER, type EventFilter } from "./model/events";
import { activeFilterCount, filtersFromSearch, filtersKey, listSearch, parseCenterTab, withFilters, type CenterTab, type RecordingFilters } from "./model/filters";
import type { Selection } from "./model/selection";
import { RawEventsTab } from "./tabs/RawEventsTab";
import { PATHS } from "@/app/paths";
import { t } from "@/i18n";

const STORAGE_KEY = "admin.recordings";
const RAW_DOCK = "raw";

export function RecordingsPage() {
  const filtersRegionId = useId();
  const workbenchRef = useRef<WorkbenchPageHandle>(null);
  const { recordingId } = useParams<{ recordingId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  /** 左欄收合（或不在有資源樹的工作區）時沒有大綱：改在列表工具列提供篩選切換。 */
  const outlinerAvailable = use(OutlinerSlotContext) !== null;
  const filters = useMemo(() => filtersFromSearch(searchParams), [searchParams]);
  const filterSignature = JSON.stringify(filtersKey(filters));
  const tab = parseCenterTab(searchParams.get("tab"));
  const streamParam = searchParams.get("stream");
  const [selectionState, setSelectionState] = useState<{ recordingId: string; selection: Selection } | null>(null);
  const [rawPresetState, setRawPresetState] = useState<{ recordingId: string; filter: EventFilter; version: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const nodeLabels = useNodeLabels();
  const selected = useRecording(recordingId);
  const selection = (recordingId != null && recordingId !== "") && selectionState?.recordingId === recordingId ? selectionState.selection : null;
  const rawPreset = (recordingId != null && recordingId !== "") && rawPresetState?.recordingId === recordingId ? rawPresetState : null;
  const listHref = `${PATHS.recordings}${listSearch(searchParams)}`;
  const filterCount = activeFilterCount(filters);

  const labels = nodeLabels.data;
  const nodeLabel = (nodeId: string) => labels?.get(nodeId) ?? null;
  const nodeOptions = useMemo(() => [...(labels?.entries() ?? [])].map(([id, label]) => ({ id, label })), [labels]);

  const updateParams = (mutate: (params: URLSearchParams) => void) => { setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        mutate(next);
        return next;
      },
      { replace: true, preventScrollReset: true },
    ); };

  /** 篩選只作用在列表：開啟 recording 時套用＝帶著新篩選回到列表。 */
  const applyFilters = (next: RecordingFilters) => {
    if (recordingId != null && recordingId !== "") {
      const query = withFilters(new URLSearchParams(), next).toString();
      void navigate(query ? `${PATHS.recordings}?${query}` : PATHS.recordings);
    } else {
      setSearchParams((previous) => withFilters(previous, next), { preventScrollReset: true });
    }
  };

  const changeTab = (next: CenterTab) => { updateParams((params) => {
      if (next === "summary") params.delete("tab");
      else params.set("tab", next);
    }); };

  const changeStream = (streamId: string) => { updateParams((params) => { params.set("stream", streamId); }); };

  const select = useCallback(
    (next: Selection) => {
      if (recordingId != null && recordingId !== "") setSelectionState({ recordingId, selection: next });
    },
    [recordingId],
  );

  /** 選取並展開底部「原始事件」。 */
  const openRaw = () => workbenchRef.current?.openDockTab(RAW_DOCK);

  /** 摘要的「查看 warning／error 事件」：以 warning 以上的篩選重新開啟原始事件面板。 */
  const showErrors = () => {
    if (!(recordingId != null && recordingId !== "")) return;
    setRawPresetState({ recordingId, filter: { ...DEFAULT_EVENT_FILTER, level: "warning+" }, version: (rawPreset?.version ?? 0) + 1 });
    workbenchRef.current?.openDockTab(RAW_DOCK);
  };

  const recording = (recordingId != null && recordingId !== "") ? selected.data : undefined;
  const kind = providerKind(recording?.context.provider_id);
  const docTabs: DocTab[] = [
    {
      id: "list",
      label: t("效能紀錄"),
      icon: ScrollText,
      to: listHref,
      active: !(recordingId != null && recordingId !== ""),
      title: filterCount > 0 ? t("紀錄列表（篩選 {filterCount} 項）", { filterCount }) : t("紀錄列表"),
    },
  ];
  if (recordingId != null && recordingId !== "") {
    docTabs.push({
      id: "recording",
      label: recording ? `${recording.context.component_id || t("（未知元件）")} · ${recording.context.operation}` : `recording ${recordingId.slice(0, 8)}`,
      icon: kind.icon,
      iconTone: kind.tone,
      to: `${location.pathname}${location.search}`,
      active: true,
      title: `recording ${recordingId}`,
      closeTo: listHref,
    });
  }

  const center = (
    <>
      <DocTabs label={t("開啟的文件")} tabs={docTabs} />
      <PageHeader
        icon={<AreaIcon area="records" size={28} />}
        title={t("效能紀錄")}
        description={t("load／invoke／unload 的量測、設定快照與原始事件（主控副本，離線 Node 仍可查）；未量測的值保持未知。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={<CompareTray />}
      />
      <RecordingList
        filters={filters}
        nodeLabel={nodeLabel}
        hidden={Boolean(recordingId)}
        toolbarStart={
          outlinerAvailable ? null : (
            <ToolButton
              label={t("搜尋與篩選")}
              text={t("搜尋與篩選{value}", { value: filterCount > 0 ? t("（{filterCount}）", { filterCount }) : "" })}
              icon={<Funnel aria-hidden />}
              aria-expanded={filtersOpen}
              aria-controls={filtersRegionId}
              onClick={() => { setFiltersOpen(!filtersOpen); }}
            />
          )
        }
        filterRegion={
          outlinerAvailable ? null : (
            <div id={filtersRegionId} hidden={!filtersOpen} className="max-h-72 shrink-0 overflow-auto border-b border-line-subtle bg-sunken/40">
              <FiltersForm filters={filters} signature={filterSignature} onApply={applyFilters} nodeOptions={nodeOptions} layout="grid" />
            </div>
          )
        }
      />
      {(recordingId != null && recordingId !== "") ? (
        <RecordingDetail
          key={recordingId}
          recordingId={recordingId}
          tab={tab}
          onTabChange={changeTab}
          onOpenRaw={openRaw}
          onShowErrors={showErrors}
          selection={selection}
          onSelect={select}
          nodeLabel={nodeLabel}
        />
      ) : null}
    </>
  );

  const inspector = (recordingId != null && recordingId !== "") ? (
    <RecordingInspector
      key={recordingId}
      recordingId={recordingId}
      selection={selection}
      onSelect={select}
      onClearSelection={() => { setSelectionState(null); }}
      nodeLabel={nodeLabel}
    />
  ) : (
    <EmptyState mark title={t("選一筆 recording 檢視明細")} description={t("結論、摘要、時間軸、部件、設定與原始事件；可匯出或加入比較。")} />
  );

  const dockTabs: DockTabSpec[] | undefined = (recordingId != null && recordingId !== "")
    ? [
        {
          id: RAW_DOCK,
          label: t("原始事件"),
          icon: Logs,
          render: () =>
            selected.data ? (
              <RawEventsTab
                key={`${recordingId}:${String(rawPreset?.version ?? 0)}`}
                recording={selected.data}
                streamParam={streamParam}
                onStreamChange={changeStream}
                initialFilter={rawPreset?.filter ?? DEFAULT_EVENT_FILTER}
              />
            ) : selected.isError ? (
              <p className="px-3 py-3 text-caption text-fg-tertiary">{t("recording 讀取失敗，無法列出事件；錯誤與「重新讀取」在上方明細。")}</p>
            ) : (
              <LoadingBlock label={t("讀取 recording…")} rows={4} className="px-3" />
            ),
        },
      ]
    : undefined;

  return (
    <>
      <WorkbenchPage
        ref={workbenchRef}
        storageKey={STORAGE_KEY}
        centerLabel={(recordingId != null && recordingId !== "") ? t("recording 明細") : t("紀錄列表")}
        center={center}
        inspector={inspector}
        inspectorLabel={t("紀錄檢視器")}
        {...(dockTabs === undefined ? {} : { dockTabs })}
      />
      <Outliner title={t("篩選")} icon={<Funnel aria-hidden />} count={filterCount > 0 ? filterCount : null}>
        <FiltersForm
          filters={filters}
          signature={filterSignature}
          onApply={applyFilters}
          nodeOptions={nodeOptions}
          layout="column"
          submitLabel={(recordingId != null && recordingId !== "") ? t("套用並回到列表") : t("套用")}
          note={(recordingId != null && recordingId !== "") ? t("篩選只作用在紀錄列表：套用或清除後回到列表。") : undefined}
        />
      </Outliner>
    </>
  );
}
