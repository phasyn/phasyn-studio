import { isListed } from "@/lib/json";
// 原始事件（底部 dock 的「原始事件」分頁）：依 stream 分頁讀取（after_seq → next_seq），缺段插入「缺段」列、不假裝連續；
// 已載入範圍內文字搜尋、level／kind 篩選、換行切換、複製單列或 JSON、下載已載入事件。
// 版面填滿 dock：上＝stream 分頁＋篩選列、中＝事件表（scroll owner、表頭固定）、下＝狀態與分頁讀取。
import { Bug, CircleX, Download, Info, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import type { Recording, RecordingEvent, RecordingStream } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select, Switch } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { ToolSeparator } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { useEventStreams, useStreamEvents } from "../api";
import { CopyButton, LoadingBlock, LoadMoreButton, QueryErrorCallout } from "../components/Feedback";
import { downloadText } from "@/lib/download";
import { safeFilePart } from "../model/download";
import { eventSummary } from "@/lib/recordingEvents";
import { eventLine, eventListWithGaps, filterEventList, flattenPages, type EventFilter } from "../model/events";
import { t } from "@/i18n";

const RENDER_STEP = 500;

const LEVEL_SPEC: Record<RecordingEvent["level"], { icon: typeof Info; className: string; label: string }> = {
  debug: { icon: Bug, className: "text-fg-tertiary", label: "debug" },
  info: { icon: Info, className: "text-info", label: "info" },
  warning: { icon: TriangleAlert, className: "text-warning", label: "warning" },
  error: { icon: CircleX, className: "text-danger", label: "error" },
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 本地時間 HH:mm:ss.SSS（完整 UTC 值放在 title）。 */
function clockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function StreamEvents({
  recordingId,
  stream,
  filter,
  wrap,
  statusId,
}: {
  recordingId: string;
  stream: RecordingStream;
  filter: EventFilter;
  wrap: boolean;
  /** 狀態列 id（搜尋框以 aria-describedby 關聯）。 */
  statusId: string;
}) {
  const events = useStreamEvents(recordingId, stream.stream_id);
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  const deferredQuery = useDeferredValue(filter.query);
  const pages = useMemo(() => events.data?.pages ?? [], [events.data]);
  const items = useMemo(() => eventListWithGaps(pages), [pages]);
  const flat = useMemo(() => flattenPages(pages), [pages]);
  const filtered = useMemo(() => filterEventList(items, { ...filter, query: deferredQuery }), [items, filter, deferredQuery]);
  const matchCount = filtered.filter((item) => item.type === "event").length;
  const gapCount = items.filter((item) => item.type !== "event").length;
  const visible = filtered.slice(0, renderLimit);
  const lastSeq = flat.at(-1)?.seq ?? null;

  const downloadLoaded = () => {
    const text = flat.map((event) => JSON.stringify(event)).join("\n");
    downloadText(`events-${safeFilePart(recordingId)}-${safeFilePart(stream.stream_id)}-loaded.jsonl`, `${text}\n`, "application/x-ndjson");
  };

  return (
    <>
      {!events.data ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {(events.error != null) ? (
            <QueryErrorCallout error={events.error} title={t("stream {stream_id} 讀取失敗", { stream_id: stream.stream_id })} onRetry={() => void events.refetch()} />
          ) : (
            <LoadingBlock label={t("讀取 stream {stream_id}…", { stream_id: stream.stream_id })} rows={4} className="py-3" />
          )}
        </div>
      ) : flat.length === 0 && gapCount === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <p className="rounded-md border border-line-subtle bg-sunken px-3 py-3 text-data text-fg-secondary">{t("此 stream 目前沒有事件。")}</p>
        </div>
      ) : (
        <TableScroll label={t("stream {stream_id} 的事件", { stream_id: stream.stream_id })} className="relative min-h-0 flex-1 overflow-auto">
          <Table className={cn("[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1] [&_thead_th]:py-1.5", !wrap && "whitespace-nowrap")}>
            <thead>
              <tr>
                <Th scope="col">{t("時間（本地）")}</Th>
                <Th scope="col">level</Th>
                <Th scope="col">{t("stream／seq")}</Th>
                <Th scope="col">kind</Th>
                <Th scope="col">{t("訊息／摘要")}</Th>
                <Th scope="col">
                  <span className="sr-only">{t("複製")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                if (item.type !== "event") {
                  return (
                    <tr key={item.key}>
                      <td colSpan={6} className="border-b border-line-subtle bg-warning/8 px-4 py-1 text-data text-warning">
                        <span className="inline-flex items-center gap-2">
                          <TriangleAlert aria-hidden className="size-4" />
                          {item.type === "gap"
                            ? t("缺段：seq {fromSeq}–{toSeq} 未取得（不補畫、不假裝連續）", { fromSeq: item.fromSeq, toSeq: item.toSeq })
                            : t("缺段：伺服器回報 seq {afterSeq} 之後有缺漏", { afterSeq: item.afterSeq })}
                        </span>
                      </td>
                    </tr>
                  );
                }
                const event = item.event;
                const level = LEVEL_SPEC[event.level];
                const LevelIcon = level.icon;
                const summary = eventSummary(event);
                return (
                  <Tr key={item.key}>
                    <Td className="machine py-1 text-caption whitespace-nowrap text-fg-secondary">
                      <time dateTime={event.occurred_at} title={t("{occurred_at}（UTC）· monotonic_ns {monotonic_ns}", { occurred_at: event.occurred_at, monotonic_ns: event.monotonic_ns })}>
                        {clockText(event.occurred_at)}
                      </time>
                    </Td>
                    <Td className={cn("py-1 whitespace-nowrap", level.className)}>
                      <span className="inline-flex items-center gap-1">
                        <LevelIcon aria-hidden className="size-3.5" />
                        {level.label}
                      </span>
                    </Td>
                    <Td className="machine py-1 text-caption whitespace-nowrap text-fg-tertiary">
                      {event.stream_id}#{event.seq}
                    </Td>
                    <Td className="machine py-1 text-caption whitespace-nowrap text-fg-secondary">{event.kind}</Td>
                    <Td className={cn("min-w-[18rem] py-1 text-data", wrap ? "whitespace-pre-wrap break-words" : "whitespace-nowrap")}>
                      <details className="group">
                        <summary className="cursor-pointer list-none rounded-sm text-fg transition-colors duration-(--duration-fast) hover:text-action-fg [&::-webkit-details-marker]:hidden">
                          {summary}
                          <span className="sr-only">{t("，展開完整 JSON")}</span>
                        </summary>
                        <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line-subtle bg-sunken p-2 text-caption whitespace-pre text-fg-secondary animate-reveal">
                          {JSON.stringify(event, null, 2)}
                        </pre>
                      </details>
                    </Td>
                    <Td className="py-0.5 whitespace-nowrap">
                      <span className="inline-flex">
                        <CopyButton text={eventLine(event)} label={t("複製 seq {seq} 這一列", { seq: event.seq })} className="size-7" />
                        <CopyButton text={JSON.stringify(event)} label={t("複製 seq {seq} 的 JSON", { seq: event.seq })} className="size-7 text-file" />
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-subtle px-3 py-1">
        <p id={statusId} className="min-w-0 flex-1 text-caption text-fg-tertiary" aria-live="polite">
          {events.data
            ? t("已載入 {flatCount} 筆{value}，符合 {matchCount} 筆{value2}{value3}", { flatCount: flat.length.toLocaleString("en-US"), value: lastSeq !== null ? t("（至 seq {lastSeq}）", { lastSeq }) : "", matchCount: matchCount.toLocaleString("en-US"), value2: gapCount > 0 ? t("，缺段 {gapCount} 處", { gapCount }) : "", value3: events.hasNextPage ? t("；尚有更多") : t("；已到目前最後一筆") })
            : ""}
          {t("；伺服器回報此 stream 最後 seq {last_seq}", { last_seq: stream.last_seq })}
          {events.isFetchNextPageError ? <span className="text-danger">{t("；下一頁讀取失敗，請再按一次（不會自動重試）。")}</span> : null}
        </p>
        <Button
          size="sm"
          variant="quiet"
          icon={<RefreshCw aria-hidden />}
          onClick={() => void events.refetch()}
          pending={events.isRefetching && !events.isFetchingNextPage}
          className="pointer-coarse:min-h-11"
        >
          {t("重新讀取")}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          icon={<Download aria-hidden />}
          onClick={downloadLoaded}
          disabled={flat.length === 0}
          title={flat.length === 0 ? t("尚未載入任何事件") : t("下載此 stream 已載入的事件（JSON Lines）；完整匯出請用右側檢視器的「匯出」")}
          className="pointer-coarse:min-h-11"
        >
          {t("下載已載入（.jsonl）")}
        </Button>
        {filtered.length > RENDER_STEP ? (
          <LoadMoreButton
            onLoad={() => { setRenderLimit((current) => current + RENDER_STEP); }}
            pending={false}
            hasMore={filtered.length > renderLimit}
            label={t("顯示更多已載入列（{min}）", { min: Math.min(RENDER_STEP, Math.max(0, filtered.length - renderLimit)) })}
            doneLabel={t("已顯示全部已載入列")}
          />
        ) : null}
        <LoadMoreButton
          onLoad={() => void events.fetchNextPage()}
          pending={events.isFetchingNextPage}
          hasMore={events.hasNextPage}
          label={t("載入下一頁（after_seq）")}
          doneLabel={t("已到目前最後一筆")}
        />
      </div>
    </>
  );
}

export function RawEventsTab({
  recording,
  streamParam,
  onStreamChange,
  initialFilter,
}: {
  recording: Recording;
  streamParam: string | null;
  onStreamChange: (streamId: string) => void;
  /** 初始篩選（例如摘要頁的「查看 warning／error」）；之後的搜尋狀態只在本面板內。 */
  initialFilter: EventFilter;
}) {
  const id = recording.context.recording_id;
  const streams = useEventStreams(id);
  const [filter, setFilter] = useState<EventFilter>(initialFilter);
  const [wrap, setWrap] = useState(true);
  const searchId = useId();
  const levelId = useId();
  const kindId = useId();
  const wrapId = useId();
  const statusId = useId();

  if (!streams.data) {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {(streams.error != null) ? (
          <QueryErrorCallout error={streams.error} title={t("無法列出事件 stream")} onRetry={() => void streams.refetch()} />
        ) : (
          <LoadingBlock label={t("列出事件 stream…")} className="py-3" />
        )}
      </div>
    );
  }
  const list = streams.data.streams;
  if (list.length === 0) return <p className="px-3 py-3 text-data text-fg-secondary">{t("此 recording 沒有任何事件 stream。")}</p>;
  const active = list.find((stream) => stream.stream_id === streamParam) ?? list[0];
  if (!active) return null;
  const prefix = `${id}-streams`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-subtle pr-2">
        <PanelTabs
          tabs={list.map((stream) => ({ id: stream.stream_id, label: stream.stream_id }))}
          value={active.stream_id}
          onChange={onStreamChange}
          idPrefix={prefix}
          label={t("事件 stream")}
          variant="underline"
          className="h-10 border-b-0"
        />
        <ToolSeparator />
        <div className="relative w-56 min-w-40">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            id={searchId}
            type="search"
            value={filter.query}
            onChange={(event) => { setFilter({ ...filter, query: event.target.value }); }}
            placeholder={t("例如 GPU_OOM 或 transformer.blocks.3")}
            aria-label={t("搜尋已載入的事件（訊息、kind、seq、JSON 內容）")}
            aria-describedby={statusId}
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor={levelId} className="text-caption text-fg-tertiary">
            level
          </label>
          <Select compact id={levelId} value={filter.level} onChange={(event) => { const value = event.target.value; if (isListed(value, ["all", "warning+", "error", "warning", "info", "debug"] as const)) setFilter({ ...filter, level: value }); }} className="w-auto min-w-28">
            <option value="all">{t("全部")}</option>
            <option value="warning+">{t("warning 以上")}</option>
            <option value="error">error</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor={kindId} className="text-caption text-fg-tertiary">
            kind
          </label>
          <Select compact id={kindId} value={filter.kind} onChange={(event) => { const value = event.target.value; if (isListed(value, ["all", "log", "notice", "span", "step", "transfer", "sample"] as const)) setFilter({ ...filter, kind: value }); }} className="w-auto min-w-24">
            <option value="all">{t("全部")}</option>
            <option value="log">log</option>
            <option value="notice">notice</option>
            <option value="span">span</option>
            <option value="step">step</option>
            <option value="transfer">transfer</option>
            <option value="sample">sample</option>
          </Select>
        </div>
        <Switch id={wrapId} label={t("自動換行")} checked={wrap} onChange={(event) => { setWrap(event.target.checked); }} className="min-h-8 gap-2 py-1 text-data" />
        {streams.data.ambiguous ? (
          <span className="text-caption text-fg-tertiary" title={t("這筆 recording 有多個 event stream（主控列出）")}>
            {t("{listCount} 個 stream：seq 各自從 1 開始，彼此沒有全序", { listCount: list.length })}
          </span>
        ) : null}
      </div>
      <div role="tabpanel" id={`${prefix}-panel-${active.stream_id}`} aria-labelledby={`${prefix}-tab-${active.stream_id}`} className="flex min-h-0 flex-1 flex-col">
        <StreamEvents key={active.stream_id} recordingId={id} stream={active} filter={filter} wrap={wrap} statusId={statusId} />
      </div>
    </div>
  );
}
