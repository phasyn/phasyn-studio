// 時間軸：每個 event stream 一節，節內每個 clock domain 一張泳道圖（相對本機，絕不共用假時間軸）。
// GPU kernel 只在 recorder 為 trace 模式且 trace 檔存在時顯示；否則明示不可得。
import { ChartColumn, ChartNoAxesGantt, Cpu, Table2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Recording, RecordingEvent, StepData } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatBytes, formatMs } from "@/lib/format";
import { isTraceMissing, useEventStreams, useStreamEvents, useTraceModel } from "../api";
import { ChartItemsTable } from "../components/ChartItemsTable";
import { LoadingBlock, LoadMoreButton, QueryErrorCallout } from "../components/Feedback";
import { TimelineChart } from "../components/TimelineChart";
import { eventListWithGaps, flattenPages } from "../model/events";
import { buildTimeline, type ChartItem } from "../model/timeline";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const BULK_PAGE_LIMIT = 20;

function StepEventsTable({ steps }: { steps: Array<{ seq: number; data: StepData }> }) {
  const [limit, setLimit] = useState(100);
  return (
    <div className="grid gap-2">
      <TableScroll label={t("每 step 事件")}>
        <Table>
          <thead>
            <tr>
              <Th scope="col">step</Th>
              <Th scope="col">scheduler update</Th>
              <Th scope="col">forward</Th>
              <Th scope="col">{t("CFG 分支")}</Th>
              <Th scope="col">sigma</Th>
              <Th scope="col">
                <T source={"host 時間<0>host monotonic</0>"} slots={[<span className="block font-normal" />]} />
              </Th>
              <Th scope="col">
                <T source={"GPU event 區間<0>cuda_event，非 kernel 時間</0>"} slots={[<span className="block font-normal" />]} />
              </Th>
              <Th scope="col">seq</Th>
            </tr>
          </thead>
          <tbody>
            {steps.slice(0, limit).map(({ seq, data }) => (
              <Tr key={seq}>
                <Td className="machine">{data.step_index}</Td>
                <Td className="machine">{data.scheduler_update_index ?? "—"}</Td>
                <Td className="machine">{data.forward_index ?? "—"}</Td>
                <Td className="machine">{data.cfg_branch ?? "—"}</Td>
                <Td className="machine">{data.sigma ?? "—"}</Td>
                <Td className="machine whitespace-nowrap">{formatMs(data.host_ms)}</Td>
                <Td className="machine whitespace-nowrap">{data.gpu_event_ms === null ? <span className="text-warning">{t("未量測")}</span> : formatMs(data.gpu_event_ms)}</Td>
                <Td className="machine text-caption text-fg-tertiary">#{seq}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {steps.length > 100 ? (
        <LoadMoreButton
          className="justify-self-start"
          onLoad={() => setLimit((current) => current + 200)}
          pending={false}
          hasMore={steps.length > limit}
          label={t("再顯示 {min} 筆（共 {stepsCount}）", { min: Math.min(200, Math.max(0, steps.length - limit)), stepsCount: steps.length })}
          doneLabel={t("已顯示全部 {stepsCount} 筆", { stepsCount: steps.length })}
        />
      ) : null}
    </div>
  );
}

function StreamTimeline({
  recordingId,
  streamId,
  multiStream,
  selectedKey,
  onSelect,
}: {
  recordingId: string;
  streamId: string;
  multiStream: boolean;
  selectedKey: string | null;
  onSelect: (item: ChartItem) => void;
}) {
  const events = useStreamEvents(recordingId, streamId);
  const [asTable, setAsTable] = useState(false);
  const [bulk, setBulk] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pages = useMemo(() => events.data?.pages ?? [], [events.data]);
  const flat = useMemo(() => flattenPages(pages), [pages]);
  const model = useMemo(() => buildTimeline(flat, streamId), [flat, streamId]);
  const gaps = useMemo(() => eventListWithGaps(pages).filter((item) => item.type !== "event"), [pages]);
  const steps = useMemo(
    () => flat.filter((event): event is Extract<RecordingEvent, { kind: "step" }> => event.kind === "step").map((event) => ({ seq: event.seq, data: event.data })),
    [flat],
  );

  const loadAll = async () => {
    setBulk(true);
    try {
      let result = await events.fetchNextPage();
      let count = 1;
      while (alive.current && result.hasNextPage && !result.isError && count < BULK_PAGE_LIMIT) {
        result = await result.fetchNextPage();
        count += 1;
      }
    } finally {
      if (alive.current) setBulk(false);
    }
  };

  if (!events.data) {
    if (events.error) return <QueryErrorCallout error={events.error} title={t("stream {streamId} 讀取失敗", { streamId })} onRetry={() => void events.refetch()} />;
    return <LoadingBlock label={t("讀取 stream {streamId} 的事件…", { streamId })} rows={3} />;
  }
  const firstSeq = flat[0]?.seq;
  const lastSeq = flat.at(-1)?.seq;
  const multiDomain = multiStream || model.groups.length > 1;

  return (
    <section aria-labelledby={`${recordingId}-${streamId}-tl`} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${recordingId}-${streamId}-tl`} className="flex flex-wrap items-center gap-2 text-section font-semibold text-fg">
          <ChartNoAxesGantt aria-hidden className="size-4 text-fg-tertiary" />
          stream <code className="machine">{streamId}</code>
          <span className="text-caption font-normal text-fg-tertiary">
            {t("已載入 {flatCount} 筆{value}{value2}", { flatCount: flat.length.toLocaleString("en-US"), value: firstSeq !== undefined ? t("（seq {firstSeq}–{value}）", { firstSeq, value: lastSeq ?? firstSeq }) : "", value2: events.hasNextPage ? t("，尚有更多") : t("，已到目前最後一筆") })}
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <LoadMoreButton
            onLoad={() => void events.fetchNextPage()}
            pending={events.isFetchingNextPage && !bulk}
            hasMore={events.hasNextPage && !bulk}
            label={t("載入下一頁事件")}
            doneLabel={bulk ? t("連續載入中…") : t("沒有更多事件")}
          />
          <LoadMoreButton
            onLoad={() => void loadAll()}
            pending={bulk}
            hasMore={events.hasNextPage}
            label={t("連續載入（最多 {bulkPageLimit} 頁）", { bulkPageLimit: BULK_PAGE_LIMIT })}
            doneLabel={t("已載入全部事件")}
          />
          <Button
            size="sm"
            variant="quiet"
            aria-pressed={asTable}
            icon={asTable ? <ChartColumn aria-hidden /> : <Table2 aria-hidden />}
            onClick={() => setAsTable((current) => !current)}
            className="pointer-coarse:min-h-11"
          >
            {asTable ? t("以圖表檢視") : t("以表格檢視")}
          </Button>
        </div>
      </div>
      {gaps.length > 0 ? (
        <Callout tone="warning" title={t("此 stream 有缺段")}>
          <p>
            {t("{map}{value}。時間軸不補畫缺段內容；可用「讀取此 Node 歷史紀錄」明確補抓 log。", { map: formatList(gaps
              .slice(0, 6)
              .map((gap) => (gap.type === "gap" ? `seq ${gap.fromSeq}–${gap.toSeq}` : t("seq {afterSeq} 之後（伺服器回報 gap）", { afterSeq: gap.afterSeq })))), value: gaps.length > 6 ? t(" 等 {gapsCount} 處", { gapsCount: gaps.length }) : "" })}
          </p>
        </Callout>
      ) : null}
      {model.invalid > 0 || model.reversed > 0 ? (
        <p className="flex items-center gap-1.5 text-caption text-warning">
          <TriangleAlert aria-hidden className="size-3.5" />
          {t("{value}{value2}{value3}，未繪製。", { value: model.invalid > 0 ? t("{invalid} 個項目的 monotonic_ns 格式不正確", { invalid: model.invalid }) : "", value2: model.invalid > 0 && model.reversed > 0 ? t("；") : "", value3: model.reversed > 0 ? t("{reversed} 個 span 終點早於起點", { reversed: model.reversed }) : "" })}
        </p>
      ) : null}
      {model.groups.length === 0 ? (
        <p className="text-data text-fg-secondary">{t("已載入的事件中沒有可定位的 span、step、transfer 或警告記錄。")}</p>
      ) : (
        model.groups.map((group) => (
          <div key={group.key} className="grid gap-2 rounded-lg border border-line-subtle bg-sunken p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-data font-semibold text-fg">{t("時鐘域")}</span>
              <code className="machine text-data text-fg-secondary" title={group.domain}>
                {group.title}
              </code>
              {group.derived ? <span className="text-caption text-fg-tertiary">{t("（依事件的 node／process 推定）")}</span> : null}
              {multiDomain ? (
                <Badge tone="warning">
                  <TriangleAlert aria-hidden />
                  {t("相對本機；絕對對齊未校準")}
                </Badge>
              ) : null}
              <span className="text-caption text-fg-tertiary">{t("{itemCount} 個項目", { itemCount: group.itemCount.toLocaleString("en-US") })}</span>
            </div>
            {asTable ? (
              <ChartItemsTable group={group} selectedKey={selectedKey} onSelect={onSelect} />
            ) : (
              <TimelineChart group={group} label={t("stream {streamId} 時鐘域 {title} 的泳道圖", { streamId, title: group.title })} selectedKey={selectedKey} onSelect={onSelect} />
            )}
          </div>
        ))
      )}
      {steps.length > 0 ? (
        <div className="grid gap-2">
          <h4 className="text-data font-semibold text-fg-secondary">{t("每 step（step 事件）")}</h4>
          <p className="text-caption text-fg-tertiary">{t("steps ≠ NFE ≠ module forward；同一 step 的 CFG 分支可能是一次或多次 forward，依事件如實列出。")}</p>
          <StepEventsTable steps={steps} />
        </div>
      ) : null}
    </section>
  );
}

function TraceSection({ recording }: { recording: Recording }) {
  const id = recording.context.recording_id;
  const mode = recording.context.recording.mode;
  const [requested, setRequested] = useState(false);
  const trace = useTraceModel(id, requested);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const traceSteps = recording.context.recording.trace_steps;
  return (
    <section aria-labelledby={`${id}-trace`} className="grid gap-3">
      <h3 id={`${id}-trace`} className="flex items-center gap-2 text-section font-semibold text-fg">
        <Cpu aria-hidden className="size-4 text-fg-tertiary" />
        {t("GPU kernel（profiler trace）")}
      </h3>
      {mode !== "trace" ? (
        <p className="text-data text-fg-secondary">
          <T source={"recorder 模式為 <0>{mode}</0>，沒有錄製 profiler trace：kernel 時間、啟動延遲與 kernel 數不可得，也不由 span 或 GPU event 推算。"} values={{ mode }} slots={[<code className="machine" />]} />
        </p>
      ) : !requested ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" icon={<Cpu aria-hidden />} onClick={() => setRequested(true)}>
            {t("載入 trace")}
          </Button>
          <span className="text-caption text-fg-tertiary">
            {t("trace 只涵蓋指定的視窗{value}；視窗外沒有 kernel 細節。", { value: traceSteps && traceSteps.length > 0 ? t("（steps {traceSteps}）", { traceSteps: traceSteps.join(", ") }) : "" })}
          </span>
        </div>
      ) : trace.isPending ? (
        <LoadingBlock label={t("讀取並解析 trace…")} />
      ) : trace.error ? (
        isTraceMissing(trace.error) ? (
          <Callout tone="info" title={t("此 recording 沒有 trace")}>
            <p>{t("trace 可能未產生（trace backend 不可用或超出上限）。已有的 phase／counter 仍可用；不以合成資料補 kernel。")}</p>
          </Callout>
        ) : (
          <QueryErrorCallout error={trace.error} title={t("trace 讀取失敗")} onRetry={() => void trace.refetch()} />
        )
      ) : trace.data && "tooLarge" in trace.data ? (
        <Callout tone="info" title={t("trace 檔案過大，不在頁面內解析")}>
          <p>{t("大小 {tooLarge}。請用「匯出 → trace」下載後以相容的 Chrome trace viewer 離線開啟。", { tooLarge: formatBytes(trace.data.tooLarge) })}</p>
        </Callout>
      ) : trace.data?.group ? (
        <div className="grid gap-2 rounded-lg border border-line-subtle bg-sunken p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-data font-semibold text-fg">{t("trace 時鐘")}</span>
            <Badge tone="warning">
              <TriangleAlert aria-hidden />
              {t("獨立時鐘；與事件時間軸未對齊")}
            </Badge>
            <span className="text-caption text-fg-tertiary">
              {t("kernel {kernelCount} · memcpy／memset {memcpyCount}{value}{value2}", { kernelCount: trace.data.kernelCount.toLocaleString("en-US"), memcpyCount: trace.data.memcpyCount.toLocaleString("en-US"), value: trace.data.truncated > 0 ? t(" · 另有 {truncated} 項超過繪製上限", { truncated: trace.data.truncated.toLocaleString("en-US") }) : "", value2: trace.data.skipped > 0 ? t(" · {skipped} 項無法解讀", { skipped: trace.data.skipped }) : "" })}
            </span>
          </div>
          <TimelineChart
            group={trace.data.group}
            label={t("profiler trace 的 GPU 活動泳道圖")}
            selectedKey={selectedKey}
            onSelect={(item) => setSelectedKey(item.key)}
          />
        </div>
      ) : (
        <p className="text-data text-fg-secondary">{t("trace 中沒有 GPU kernel／memcpy 活動。")}</p>
      )}
    </section>
  );
}

export function TimelineTab({
  recording,
  selectedKey,
  onSelectItem,
}: {
  recording: Recording;
  selectedKey: string | null;
  onSelectItem: (item: ChartItem) => void;
}) {
  const id = recording.context.recording_id;
  const streams = useEventStreams(id);
  return (
    <div className="grid gap-8">
      <p className="text-caption text-fg-tertiary">
        {t("不同 clock domain 分開繪製、各自以第一個事件為 0，不相減也不共用微秒軸；GPU event 區間可能含等待，不是 kernel 時間。")}
      </p>
      {streams.data ? (
        streams.data.streams.length === 0 ? (
          <p className="text-data text-fg-secondary">{t("此 recording 沒有任何事件 stream。")}</p>
        ) : (
          streams.data.streams.map((stream) => (
            <StreamTimeline
              key={stream.stream_id}
              recordingId={id}
              streamId={stream.stream_id}
              multiStream={(streams.data?.streams.length ?? 0) > 1}
              selectedKey={selectedKey}
              onSelect={onSelectItem}
            />
          ))
        )
      ) : streams.error ? (
        <QueryErrorCallout error={streams.error} title={t("無法列出事件 stream")} onRetry={() => void streams.refetch()} />
      ) : (
        <LoadingBlock label={t("列出事件 stream…")} />
      )}
      <TraceSection recording={recording} />
    </div>
  );
}
