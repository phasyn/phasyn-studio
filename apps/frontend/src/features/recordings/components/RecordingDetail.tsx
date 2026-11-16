// 單筆 recording 明細（中欄）：精簡標題列、四個頁籤（摘要／時間軸／部件／設定；原始事件在底部 dock），
// 內容區是唯一 scroll owner：合成示例／不完整提示與可行動結論在上方，下方是頁籤內容。
// 頁籤在 URL（?tab=）；造訪過的頁籤保持掛載（隱藏），切換時保留搜尋與載入狀態。
import { ChartNoAxesGantt, ClipboardList, FileQuestionMark, Puzzle, SlidersHorizontal, TriangleAlert, Unlink } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { pageFocusTarget } from "@/components/common/routeFocus";
import { Callout } from "@/components/ui/callout";
import { DockBody } from "@/components/workbench/DockPanel";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { isApiError } from "@/api/http";
import { useRecording } from "../api";
import type { CenterTab } from "../model/filters";
import type { Selection } from "../model/selection";
import { selectionEventKey } from "../model/selection";
import type { ChartItem } from "../model/timeline";
import { PartsTab } from "../tabs/PartsTab";
import { SettingsTab } from "../tabs/SettingsTab";
import { SummaryTab } from "../tabs/SummaryTab";
import { TimelineTab } from "../tabs/TimelineTab";
import { ConclusionPanel } from "./ConclusionPanel";
import { DetailHeader } from "./DetailHeader";
import { LoadingBlock, QueryErrorState, StaleNotice, SyntheticBanner } from "./Feedback";
import { RecoverFromNode } from "./RecoverFromNode";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const TAB_ITEMS = [
  { id: "summary", label: t("摘要"), icon: ClipboardList },
  { id: "timeline", label: t("時間軸"), icon: ChartNoAxesGantt },
  { id: "parts", label: t("部件"), icon: Puzzle },
  { id: "settings", label: t("設定"), icon: SlidersHorizontal },
] satisfies Array<{ id: CenterTab; label: string; icon: typeof ClipboardList }>;

export function RecordingDetail({
  recordingId,
  tab,
  onTabChange,
  onOpenRaw,
  onShowErrors,
  selection,
  onSelect,
  nodeLabel,
}: {
  recordingId: string;
  tab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  /** 選取並展開底部「原始事件」面板（焦點移過去）。 */
  onOpenRaw: () => void;
  /** 摘要的「查看 warning／error 事件」：以 warning 以上的篩選開啟原始事件。 */
  onShowErrors: () => void;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  nodeLabel: (nodeId: string) => string | null;
}) {
  const titleId = useId();
  const idPrefix = `rec-${recordingId}`;
  const query = useRecording(recordingId);
  const [visited, setVisited] = useState<ReadonlySet<CenterTab>>(() => new Set([tab]));
  // A backfill from the "not found" view replaces that view (and the focused button) with the recording
  const recovering = useRef(false);
  const loaded = query.data !== undefined;
  useEffect(() => {
    if (!loaded || !recovering.current) return;
    recovering.current = false;
    if (document.activeElement === null || document.activeElement === document.body) pageFocusTarget()?.focus({ preventScroll: true });
  }, [loaded]);

  const changeTab = (next: CenterTab) => {
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
    onTabChange(next);
  };
  const onSelectItem = useCallback(
    (item: ChartItem) => {
      if (item.ref.kind === "event") onSelect({ kind: "event", streamId: item.ref.streamId, seq: item.ref.seq });
    },
    [onSelect],
  );

  if (!query.data) {
    const notFound = query.isError && isApiError(query.error) && query.error.status === 404;
    return (
      <section aria-label={t("recording 明細")} className="min-h-0 flex-1 overflow-auto">
        {notFound ? (
          <EmptyState
            icon={<FileQuestionMark />}
            title={t("找不到此 recording")}
            description={
              <p>
                <T source={"<0>{recordingId}</0> 不在主控的紀錄索引中：可能已從主控刪除、尚未上報、ID 不正確，或 Node 從未連上主控。"} values={{ recordingId }} slots={[<code className="machine break-all" />]} />
              </p>
            }
          >
            <RecoverFromNode
              recordingId={recordingId}
              rereading={query.isFetching}
              onReread={() => void query.refetch()}
              onSubmit={() => {
                recovering.current = true;
              }}
            />
          </EmptyState>
        ) : query.isError ? (
          <QueryErrorState error={query.error} title={t("recording 讀取失敗")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : (
          <LoadingBlock label={t("讀取 recording…")} rows={5} className="px-4" />
        )}
      </section>
    );
  }

  const recording = query.data;
  const { summary, context } = recording;
  const partialReasons = [
    summary.coverage !== "full" ? t("coverage={coverage}（部分 part 或步驟沒有被 hook 覆蓋）", { coverage: summary.coverage }) : null,
    summary.dropped_events > 0 ? t("丟失 {dropped_events} 筆事件", { dropped_events: summary.dropped_events.toLocaleString("en-US") }) : null,
    summary.detail_truncated ? t("已達細節上限，之後只保留聚合") : null,
  ].filter((reason): reason is string => reason !== null);
  const isMounted = (id: CenterTab) => id === tab || visited.has(id);
  const selectedPart = selection?.kind === "part" ? selection.part : null;
  const selectedCategory = selection?.kind === "category" ? selection.category : null;

  return (
    <section aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <DetailHeader recording={recording} nodeLabel={nodeLabel(context.node_id)} titleId={titleId} onOpenRaw={onOpenRaw} />
      <PanelTabs tabs={TAB_ITEMS} value={tab} onChange={(id) => changeTab(id as CenterTab)} idPrefix={idPrefix} label={t("recording 檢視")} variant="underline" className="px-3" />
      <DockBody>
        <div className="grid gap-3 px-4 pt-4">
          {query.isPlaceholderData ? (
            <p role="status" className="text-caption text-fg-tertiary">
              {t("顯示列表中的資料，正在讀取最新內容…")}
            </p>
          ) : null}
          {query.isError ? <StaleNotice error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
          {context.synthetic ? <SyntheticBanner /> : null}
          {!summary.context_available ? (
            <Callout tone="warning" icon={<Unlink />} title={t("context 尚未收到")}>
              <p>{t("context 還沒到：設定、模型與環境欄位是佔位，不偽補；可稍後重新讀取或補抓 Node 歷史紀錄。")}</p>
            </Callout>
          ) : null}
          {partialReasons.length > 0 ? (
            <Callout tone="warning" icon={<TriangleAlert />} title={t("紀錄不完整")}>
              <p>{t("{partialReasons}。缺少的部分保持未知，不以 0 或推算值補上。", { partialReasons: partialReasons.join(t("；")) })}</p>
            </Callout>
          ) : null}
          {summary.state === "running" ? (
            <div role="status" className="grid gap-1.5">
              <p className="text-caption text-info">{t("此 recording 仍在執行中：summary 每 3 秒更新；事件需手動重新讀取。")}</p>
              {/* 沒有可信的完成比例：不畫百分比，只用掃過的高光表示仍在進行 */}
              <span aria-hidden className="block h-1 rounded-full bg-brand-gradient-soft animate-shimmer" />
            </div>
          ) : null}
          <ConclusionPanel summary={summary} onOpenTimeline={() => changeTab("timeline")} onOpenParts={() => changeTab("parts")} />
        </div>
        {TAB_ITEMS.map((item) => (
          <div
            key={item.id}
            role="tabpanel"
            id={`${idPrefix}-panel-${item.id}`}
            aria-labelledby={`${idPrefix}-tab-${item.id}`}
            tabIndex={0}
            hidden={item.id !== tab}
            className="min-w-0 rounded-md px-4 pt-6 pb-6 focus-visible:outline-offset-[-2px]"
          >
            {!isMounted(item.id) ? null : item.id === "summary" ? (
              <SummaryTab
                recording={recording}
                selectedCategory={selectedCategory}
                onSelectCategory={(category) => onSelect({ kind: "category", category })}
                onShowErrors={onShowErrors}
              />
            ) : item.id === "timeline" ? (
              <TimelineTab recording={recording} selectedKey={selectionEventKey(selection)} onSelectItem={onSelectItem} />
            ) : item.id === "parts" ? (
              <PartsTab recording={recording} selectedPart={selectedPart} onSelectPart={(part) => onSelect({ kind: "part", part })} />
            ) : (
              <SettingsTab recording={recording} />
            )}
          </div>
        ))}
      </DockBody>
    </section>
  );
}
