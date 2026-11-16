// 比較：2–8 筆 recording 並排——來源是否相同、混淆因素、量測條件、設定差異與量測值。
// 更快不等於更好：不算加速比、不給勝出標記、沒有資格門檻；單次對比標 n=1、不計 p95。
// 「從此 recording 複製設定」只連到元件頁並選取該 instance，不重播指令。
// 工作台版面：中欄＝文件分頁、頁首、工具列（跳到區段、常駐比較條件）、比較內容（唯一 scroll owner）；檢視器＝比較對象。
import { Activity, ChartColumn, FileSpreadsheet, Gauge, GitCompareArrows, Scale, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import type { RecordingContext } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { AreaIcon } from "@/components/common/AreaIcon";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { Callout } from "@/components/ui/callout";
import { DockBody } from "@/components/workbench/DockPanel";
import { DocTabs } from "@/components/workbench/DocTabs";
import { ToolButton, ToolStrip } from "@/components/workbench/ToolStrip";
import { WorkbenchPage } from "@/components/workbench/WorkbenchPage";
import { ActivityLog } from "@/features/activity";
import { LoadingBlock, QueryErrorState, StaleNotice, SyntheticBanner } from "../components/Feedback";
import { comparisonHref, MAX_COMPARE, parseIds } from "../model/compareStore";
import { downloadText } from "@/lib/download";
import { useComparison, useRecordingsByIds } from "./api";
import type { ColumnState } from "./components/ColumnHead";
import { ComparabilityChips, DiffSection, MetricsSection, SourceSection } from "./components/ComparisonSections";
import { ComparisonInspector } from "./components/ComparisonInspector";
import { sectionLinks, type ComparisonSectionId } from "./model/comparability";
import { comparisonCsv } from "./model/metricsTable";
import { conditionRows, normalizeSettingsDiff } from "./model/settingsDiff";
import { t } from "@/i18n";

const SECTION_ICON: Record<ComparisonSectionId, typeof Scale> = { source: Scale, conditions: Gauge, settings: SlidersHorizontal, metrics: ChartColumn };
const sectionId = (id: ComparisonSectionId) => `comparison-section-${id}`;

/** 平滑捲到區段並把焦點交給區段標題。 */
function jumpTo(id: ComparisonSectionId) {
  const heading = document.getElementById(sectionId(id));
  if (!heading) return;
  heading.scrollIntoView({ block: "start", behavior: "smooth" });
  heading.focus({ preventScroll: true });
}

export function ComparisonsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawIds = searchParams.get("ids");
  const ids = useMemo(() => parseIds(rawIds), [rawIds]);
  const requested = rawIds ? new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean)).size : 0;
  const comparison = useComparison(ids);
  const states = useRecordingsByIds(ids);
  const byId = useMemo(() => new Map(ids.map((id, index) => [id, { id, ...(states[index] ?? { data: undefined, error: null, isPending: true }) }])), [ids, states]);
  const pickerColumns: ColumnState[] = ids.map((id) => byId.get(id) ?? { id, data: undefined, error: null, isPending: true });

  // 表格欄位依伺服器回傳的 recording_ids 排列（metrics 陣列與它同序），避免欄位錯位。
  const serverIds = comparison.data?.recording_ids ?? ids;
  const tableColumns: ColumnState[] = serverIds.map((id) => byId.get(id) ?? { id, data: undefined, error: null, isPending: false });
  const contexts = useMemo(() => {
    const map = new Map<string, RecordingContext>();
    for (const [id, column] of byId) if (column.data) map.set(id, column.data.context);
    return map;
  }, [byId]);
  const diffRows = useMemo(
    () => (comparison.data ? normalizeSettingsDiff(comparison.data.settings_diff, comparison.data.recording_ids, contexts) : []),
    [comparison.data, contexts],
  );
  const conditions = useMemo(() => conditionRows(serverIds, contexts), [serverIds, contexts]);
  const anySynthetic = pickerColumns.some((column) => column.data?.context.synthetic);

  const setIds = (next: string[]) =>
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        const clean = parseIds(next.join(","));
        if (clean.length > 0) params.set("ids", clean.join(","));
        else params.delete("ids");
        return params;
      },
      { preventScrollReset: true },
    );

  const data = comparison.data;
  const links = sectionLinks({ hasData: data !== undefined, conditionRows: conditions.length });
  const downloadCsv = () => {
    if (!data) return;
    downloadText(`comparison-${serverIds.map((id) => id.slice(0, 8)).join("-")}.csv`, comparisonCsv(serverIds, data.metrics), "text/csv;charset=utf-8");
  };
  const stale = comparison.isError && data !== undefined;
  const notices = anySynthetic || requested > MAX_COMPARE || stale;

  const center = (
    <>
      <DocTabs
        label={t("開啟的文件")}
        tabs={[{ id: "comparisons", label: t("比較"), icon: GitCompareArrows, to: comparisonHref(ids), active: true, title: t("並排 2–8 筆 recording") }]}
      />
      <PageHeader
        icon={<AreaIcon area="records" size={28} />}
        title={t("比較")}
        description={t("並排 2–8 筆 recording 的來源、混淆因素、量測條件、設定差異與量測值；更快不等於更好，不算加速比、不標勝出。")}
        className="shrink-0 border-b border-line-subtle px-4 py-3"
        actions={
          <ActionButton size="sm" icon={<FileSpreadsheet aria-hidden />} disabledReason={data ? null : t("尚無比較結果")} onClick={downloadCsv} className="pointer-coarse:min-h-11">
            {t("下載比較表 CSV")}
          </ActionButton>
        }
      />
      <ToolStrip label={t("比較工具")}>
        <span className="px-1 text-caption text-fg-tertiary">{t("跳到")}</span>
        {links.map((link) => {
          const Icon = SECTION_ICON[link.id];
          return (
            <ToolButton
              key={link.id}
              label={t("跳到「{label}」", { label: link.label })}
              text={link.label}
              icon={<Icon aria-hidden />}
              disabledReason={link.disabledReason}
              onClick={() => jumpTo(link.id)}
            />
          );
        })}
        <div className="ml-auto flex flex-wrap items-center gap-2 pr-1">{data ? <ComparabilityChips data={data} /> : null}</div>
      </ToolStrip>
      {notices ? (
        <div className="grid shrink-0 gap-2 border-b border-line-subtle px-4 py-2">
          {anySynthetic ? <SyntheticBanner>{t("比較中至少有一筆 recording 是合成示例（synthetic）：整個比較區的數值都不是實際裝置量測。")}</SyntheticBanner> : null}
          {requested > MAX_COMPARE ? (
            <Callout tone="warning" title={t("網址列出 {requested} 筆，只取前 {maxCompare} 筆", { requested, maxCompare: MAX_COMPARE })}>
              <p>{t("比較一次最多 {maxCompare} 筆 recording。", { maxCompare: MAX_COMPARE })}</p>
            </Callout>
          ) : null}
          {stale ? <StaleNotice error={comparison.error} onRetry={() => void comparison.refetch()} retrying={comparison.isFetching} /> : null}
        </div>
      ) : null}
      <DockBody role="region" aria-label={t("比較內容")} tabIndex={0} className="outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset">
        {ids.length < 2 ? (
          <EmptyState scene mark title={t("至少選 2 筆 recording 才能比較")} description={t("在「比較對象」檢視器以 recording_id 加入、從最近紀錄挑選，或在紀錄頁勾選「加入比較」。")} />
        ) : !data ? (
          comparison.isError ? (
            <QueryErrorState error={comparison.error} title={t("比較結果讀取失敗")} onRetry={() => void comparison.refetch()} retrying={comparison.isFetching} />
          ) : (
            <LoadingBlock label={t("讀取比較結果…")} rows={6} className="px-4" />
          )
        ) : (
          // 比較結果讀到時整區淡入上移一次（重新讀取不重播）
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6 px-4 pt-4 pb-8 animate-rise-in">
            <SourceSection id={sectionId("source")} data={data} columns={tableColumns} />
            {conditions.length > 0 ? (
              <DiffSection
                id={sectionId("conditions")}
                icon={<Gauge aria-hidden />}
                title={t("量測條件（由各 recording 的 context 讀出）")}
                description={t("recorder 模式、取樣頻率、trace 視窗、冷暖／compile／cache、裝置與模型身分強度；沒有記錄的格子顯示「未知」。")}
                rows={conditions}
                columns={tableColumns}
                emptyText={t("各 recording 的 context 沒有可讀出的量測條件。")}
              />
            ) : null}
            <DiffSection
              id={sectionId("settings")}
              icon={<SlidersHorizontal aria-hidden />}
              title={t("設定差異（以第 1 筆為基準）")}
              rows={diffRows}
              columns={tableColumns}
              emptyText={t("伺服器回報這些 recording 的設定沒有差異（settings_diff 為空）。")}
            />
            <MetricsSection id={sectionId("metrics")} metrics={data.metrics} columns={tableColumns} />
          </div>
        )}
      </DockBody>
    </>
  );

  return (
    <WorkbenchPage
      storageKey="admin.comparisons"
      centerLabel={t("比較結果")}
      center={center}
      inspector={<ComparisonInspector columns={pickerColumns} onChange={setIds} />}
      inspectorLabel={t("比較對象檢視器")}
      dockLabel={t("輸出面板")}
      dockTabs={[{ id: "activity", label: t("活動"), icon: Activity, render: () => <ActivityLog /> }]}
    />
  );
}
