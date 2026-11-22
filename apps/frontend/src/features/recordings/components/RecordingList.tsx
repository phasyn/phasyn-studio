// 紀錄列表（中欄文件）：created_at DESC 的 cursor 分頁；「載入更多」把新列接在後面、焦點留在按鈕、以 recording_id 去重。
// 表格容器是 scroll owner、表頭固定。開啟某筆 recording 時列表只是隱藏（保持掛載）：回到列表時已載入的頁與捲動位置都還在。
import { Inbox, ListFilter, RefreshCw, Rows3 } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import type { Recording } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { ToolStrip } from "@/components/workbench/ToolStrip";
import { formatTime } from "@/i18n/format";
import { formatTimestamp } from "@/lib/format";
import { useRecordingList } from "../api";
import { useRecordingHref } from "../hooks";
import { MAX_COMPARE, useCompareSelection } from "../model/compareStore";
import { activeFilterCount, filtersKey, type RecordingFilters } from "../model/filters";
import { missingMetric } from "../model/metrics";
import { OperationBadge, RecordingFlags, RecordingStateBadge } from "./Badges";
import { LoadingBlock, LoadMoreButton, QueryErrorState, StaleNotice } from "./Feedback";
import { MetricValue } from "./MetricValue";
import { STAGGER_LIMIT, reveal } from "@/components/ui/motion";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

const FAILED = new Set(["failed", "interrupted", "unknown", "cancelled"]);

function uniqueRecordings(pages: readonly { items: Recording[] }[]): Recording[] {
  const seen = new Set<string>();
  const out: Recording[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.context.recording_id)) continue;
      seen.add(item.context.recording_id);
      out.push(item);
    }
  }
  return out;
}

function clockOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatTimestamp(iso);
}

export function RecordingList({
  filters,
  nodeLabel,
  hidden = false,
  toolbarStart,
  filterRegion,
}: {
  filters: RecordingFilters;
  nodeLabel: (nodeId: string) => string | null;
  /** 開啟某筆 recording 時隱藏（保持掛載，回來時恢復捲動位置）。 */
  hidden?: boolean;
  /** 工具列最前面的控制（例如大綱不可用時的「搜尋與篩選」切換）。 */
  toolbarStart?: ReactNode;
  /** 工具列下方的內嵌區域（例如大綱不可用時的篩選表單）。 */
  filterRegion?: ReactNode;
}) {
  const titleId = useId();
  const moreId = useId();
  const list = useRecordingList(filters);
  const compare = useCompareSelection();
  const hrefFor = useRecordingHref();
  const items = useMemo(() => uniqueRecordings(list.data?.pages ?? []), [list.data]);
  const filterCount = activeFilterCount(filters);
  const updatedAt = list.dataUpdatedAt ? formatTime(list.dataUpdatedAt) : null;
  const listKey = JSON.stringify(filtersKey(filters));
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef<{ key: string; top: number }>({ key: "", top: 0 });

  // display:none 會讓瀏覽器丟掉捲動位置：可見時記錄 scrollTop，重新顯示同一份篩選結果時還原。
  useLayoutEffect(() => {
    if (hidden) return;
    const element = scrollRef.current;
    const saved = savedScrollRef.current;
    if (element && saved.key === listKey && saved.top > 0) element.scrollTop = saved.top;
  }, [hidden, listKey]);

  return (
    <section aria-labelledby={titleId} hidden={hidden} className="flex min-h-0 flex-1 flex-col">
      <ToolStrip label={t("紀錄列表")} className="px-3">
        {toolbarStart}
        <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-data font-semibold text-fg">
          <Rows3 aria-hidden className="size-4 text-fg-tertiary" />
          <T source={"紀錄列表{span}"} values={{ span: <span className="text-caption font-normal text-fg-tertiary">
            {list.data ? t("已載入 {itemsCount} 筆{value}", { itemsCount: items.length.toLocaleString("en-US"), value: list.hasNextPage ? t("，尚有更多") : "" }) : ""}
            {filterCount > 0 ? t(" · 篩選 {filterCount} 項", { filterCount }) : ""}
          </span> }} />
        </h2>
        <div className="ml-auto flex items-center gap-2 text-caption text-fg-tertiary">
          {(updatedAt != null && updatedAt !== "") ? <span>{t("更新於 {updatedAt}", { updatedAt })}</span> : null}
          <Button
            size="sm"
            variant="quiet"
            icon={<RefreshCw aria-hidden />}
            onClick={() => void list.refetch()}
            pending={list.isRefetching && !list.isFetchingNextPage}
            className="pointer-coarse:min-h-11"
          >
            {t("重新整理")}
          </Button>
        </div>
      </ToolStrip>
      {filterRegion}
      {list.isError && list.data ? (
        <div className="shrink-0 border-b border-line-subtle px-4 py-2">
          <StaleNotice error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        </div>
      ) : null}
      {!list.data ? (
        list.isError ? (
          <QueryErrorState error={list.error} title={t("紀錄列表讀取失敗")} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <LoadingBlock label={t("讀取紀錄列表…")} rows={6} className="px-4" />
        )
      ) : items.length === 0 ? (
        filterCount > 0 ? (
          <EmptyState icon={<ListFilter />} title={t("沒有符合篩選的紀錄")} description={t("放寬或清除篩選條件。since／until 以 UTC 傳給主控，輸入框顯示的是本地時間。")} />
        ) : (
          <EmptyState
            illustration="timeline"
            icon={<Inbox />}
            title={t("還沒有任何紀錄")}
            description={t("元件每次 load、invoke、unload 都會建立 recording；啟動元件或執行流程後，這裡會出現紀錄。")}
          />
        )
      ) : (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            if (!hidden) savedScrollRef.current = { key: listKey, top: event.currentTarget.scrollTop };
          }}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          role="region"
          aria-label={t("紀錄列表（可捲動）")}
           /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- Keyboard users can focus this scrollable region and scroll its overflow. */ tabIndex={0}
        >
          <Table className="[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]">
            <thead>
              <tr>
                <Th scope="col" className="w-12">
                  <span className="sr-only">{t("加入比較")}</span>
                </Th>
                <Th scope="col">{t("建立時間")}</Th>
                <Th scope="col">{t("元件 · Node · provider")}</Th>
                <Th scope="col">operation</Th>
                <Th scope="col">{t("狀態")}</Th>
                <Th scope="col">wall</Th>
                <Th scope="col">{t("錯誤")}</Th>
                <Th scope="col">{t("紀錄標記")}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const { context, summary } = item;
                const id = context.recording_id;
                const inCompare = compare.has(id);
                const blocked = !inCompare && compare.full;
                const failed = FAILED.has(summary.state);
                const wall = summary.metrics["host_wall_ms"] ?? missingMetric("host_wall_ms");
                return (
                  <Tr
                    key={id}
                    // 第一次出現的前 10 列錯開進場；之後「載入更多」接上的列直接出現。
                    ref={index < STAGGER_LIMIT ? reveal(index) : undefined}
                  >
                    <Td className="py-1">
                      <label className="pressable inline-flex size-8 cursor-pointer items-center justify-center rounded-md hover:bg-raised active:bg-sunken pointer-coarse:size-11">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer accent-action disabled:cursor-not-allowed"
                          checked={inCompare}
                          disabled={blocked}
                          title={blocked ? t("比較清單已滿 {maxCompare} 筆", { maxCompare: MAX_COMPARE }) : undefined}
                          onChange={() => { compare.toggle(id); }}
                          aria-label={t("加入比較：{component_id} {created_at}", { component_id: context.component_id, created_at: clockOf(context.created_at) })}
                        />
                      </label>
                    </Td>
                    <Td className="machine text-caption whitespace-nowrap text-fg-secondary">
                      <time dateTime={context.created_at} title={t("{created_at}（UTC）", { created_at: context.created_at })}>
                        {clockOf(context.created_at)}
                      </time>
                    </Td>
                    <Td className="min-w-[12rem]">
                      <Link to={hrefFor(id)} className="machine font-medium break-all">
                        {context.component_id || t("（未知元件）")}
                      </Link>
                      {/* 單行（過長截斷，完整內容在 title 與檢視器），維持密集列高 */}
                      <span
                        className="block max-w-[16rem] truncate text-caption text-fg-tertiary"
                        title={`${nodeLabel(context.node_id) ?? context.node_id} · ${context.provider_id || "—"}`}
                      >
                        {nodeLabel(context.node_id) ?? context.node_id.slice(0, 8)} · <span className="machine">{context.provider_id || "—"}</span>
                      </span>
                    </Td>
                    <Td>
                      <OperationBadge operation={context.operation} />
                    </Td>
                    <Td>
                      <RecordingStateBadge state={summary.state} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <MetricValue metric={wall} />
                    </Td>
                    <Td className="max-w-[16rem] text-caption">
                      {failed && (summary.notes[0] != null && summary.notes[0] !== "") ? (
                        <span className="line-clamp-2 break-words text-danger" title={tServer(summary.notes[0])}>
                          {tServer(summary.notes[0])}
                        </span>
                      ) : failed ? (
                        <span className="text-fg-tertiary">{t("未附說明")}</span>
                      ) : (
                        <span className="text-fg-tertiary">—</span>
                      )}
                    </Td>
                    <Td>
                      <RecordingFlags recording={item} compact />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <LoadMoreButton
              onLoad={() => void list.fetchNextPage()}
              pending={list.isFetchingNextPage}
              hasMore={list.hasNextPage}
              describedBy={moreId}
              doneLabel={t("已載入全部符合的紀錄")}
            />
            <span id={moreId} className="text-caption text-fg-tertiary">
              {list.isFetchNextPageError ? t("下一頁讀取失敗，請再按一次（不會自動重試）。") : t("依 created_at 由新到舊；新列接在下方，不重複。")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
