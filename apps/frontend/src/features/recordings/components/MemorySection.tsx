// 記憶體：峰值表（各口徑分列、不相加）＋依 stream 的取樣曲線（缺段斷線）＋載入／運行分開的連結。
import { ChartLine, MemoryStick, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Recording } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatBytes, formatMs, formatTimestamp } from "@/lib/format";
import { useEventStreams, useLoadRecordingFor, useStreamEvents } from "../api";
import { useRecordingHref } from "../hooks";
import { flattenPages } from "../model/events";
import { buildMemoryModel, MEMORY_PANELS, type MemoryPanelId, type MemorySeries } from "../model/memory";
import { groupMetricNames, METRIC_GROUPS, missingMetric } from "../model/metrics";
import { LineChart, type LineSeries } from "./LineChart";
import { LoadingBlock, LoadMoreButton, QueryErrorCallout } from "./Feedback";
import { MetricTable } from "./MetricValue";
import { tServer, t as tr } from "@/i18n";
import { T } from "@/i18n/T";

const MEMORY_GROUP = METRIC_GROUPS.find((group) => group.id === "memory");

function LoadRunNote({ recording }: { recording: Recording }) {
  const hrefFor = useRecordingHref();
  const load = useLoadRecordingFor(recording);
  if (recording.context.operation === "load") {
    return <p className="text-caption text-fg-tertiary">{tr("這是載入（load）紀錄：峰值屬於載入過程；每次呼叫（invoke）的峰值記在各自的 recording，不互相冒充。")}</p>;
  }
  if (!load.data) return null;
  return (
    <p className="text-caption text-fg-tertiary">
      <T source={"載入與運行是不同 recording：同一程序的載入紀錄{text}<0>{recording_id}</0>（{created_at}）。載入峰值不計入本次呼叫。"} values={{ text: " ", recording_id: load.data.context.recording_id.slice(0, 8), created_at: formatTimestamp(load.data.context.created_at) }} slots={[<Link key="slot-0" to={hrefFor(load.data.context.recording_id)} className="machine" />]} />
    </p>
  );
}

interface Panel {
  key: string;
  panel: MemoryPanelId;
  deviceId: string | null;
  series: MemorySeries[];
}

function panelsOf(series: readonly MemorySeries[]): Panel[] {
  const panels = new Map<string, Panel>();
  for (const s of series) {
    const key = `${s.panel}|${s.deviceId ?? "-"}|${String(s.processId ?? "-")}`;
    const panel = panels.get(key) ?? { key, panel: s.panel, deviceId: s.deviceId, series: [] };
    panel.series.push(s);
    panels.set(key, panel);
  }
  const order: MemoryPanelId[] = ["allocator", "nvml_device", "nvml_process", "host_rss"];
  return [...panels.values()].sort((a, b) => order.indexOf(a.panel) - order.indexOf(b.panel) || a.key.localeCompare(b.key));
}

function SamplesTable({ series, times }: { series: readonly MemorySeries[]; times: readonly number[] }) {
  const [limit, setLimit] = useState(200);
  const maps = useMemo(() => series.map((s) => new Map(s.samples.map((sample) => [sample.t, sample.v]))), [series]);
  return (
    <div className="grid gap-2">
      <TableScroll label={tr("記憶體取樣表格")}>
        <Table>
          <thead>
            <tr>
              <Th scope="col">{tr("t（相對第一個取樣）")}</Th>
              {series.map((s) => (
                <Th key={s.key} scope="col">
                  {MEMORY_PANELS[s.panel].title} · {s.label}
                  {(s.deviceId != null && s.deviceId !== "") ? <span className="machine block font-normal">{s.deviceId}</span> : null}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.slice(0, limit).map((t) => (
              <Tr key={t}>
                <Td className="machine whitespace-nowrap">{formatMs(t)}</Td>
                {series.map((s, index) => {
                  const value = maps[index]?.get(t);
                  return (
                    <Td key={s.key} className="machine whitespace-nowrap">
                      {value === undefined ? <span className="text-fg-tertiary">—</span> : value === null ? <span className="text-warning">{tr("缺值")}</span> : formatBytes(value)}
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {times.length > 200 ? (
        <LoadMoreButton
          className="justify-self-start"
          onLoad={() => { setLimit((current) => current + 200); }}
          pending={false}
          hasMore={times.length > limit}
          label={tr("再顯示 200 個取樣（共 {timesCount}）", { timesCount: times.length.toLocaleString("en-US") })}
          doneLabel={tr("已顯示全部取樣")}
        />
      ) : null}
    </div>
  );
}

function StreamMemory({ recording, streamId, enabled }: { recording: Recording; streamId: string; enabled: boolean }) {
  const id = recording.context.recording_id;
  const events = useStreamEvents(id, streamId, enabled);
  const [asTable, setAsTable] = useState(false);
  const flat = useMemo(() => flattenPages(events.data?.pages ?? []), [events.data]);
  const model = useMemo(() => buildMemoryModel(flat, recording.context.recording.device_sample_hz), [flat, recording.context.recording.device_sample_hz]);
  const panels = useMemo(() => panelsOf(model.series), [model.series]);

  if (!events.data) {
    if (events.isFetching) return <LoadingBlock label={tr("讀取 stream {streamId} 的事件…", { streamId })} rows={3} />;
    if (events.error != null) return <QueryErrorCallout error={events.error} title={tr("stream {streamId} 讀取失敗", { streamId })} onRetry={() => void events.refetch()} />;
    return (
      <p className="text-caption text-fg-tertiary">
        <T source={"stream <0>{streamId}</0>：事件尚未載入。"} values={{ streamId }} slots={[<code key="slot-0" className="machine" />]} />
      </p>
    );
  }
  const more = events.hasNextPage ? tr("（此 stream 尚有未載入的事件；可在下方「原始事件」面板或「時間軸」載入更多）") : "";
  if (model.sampleCount === 0) {
    return (
      <p className="text-caption text-fg-tertiary">
        <T source={"stream <0>{streamId}</0>：已載入 {flatCount} 筆事件，其中沒有取樣事件{more}。"} values={{ streamId, flatCount: flat.length.toLocaleString("en-US"), more }} slots={[<code key="slot-0" className="machine" />]} />
      </p>
    );
  }
  const drawable = panels.filter((panel) => panel.series.some((s) => s.max !== null));
  const empty = panels.filter((panel) => panel.series.every((s) => s.max === null));
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-fg-tertiary">
          <T source={"stream <0>{streamId}</0> · {sampleCount} 個取樣 · 預期間隔{text}{value}{value2}{more}"} values={{ streamId, sampleCount: model.sampleCount.toLocaleString("en-US"), text: " ", value: model.expectedIntervalMs !== null ? formatMs(model.expectedIntervalMs) : tr("未知"), value2: model.gapThresholdMs !== null ? tr("；間隔超過 {gapThresholdMs} 或缺值即斷線", { gapThresholdMs: formatMs(model.gapThresholdMs) }) : tr("；缺值即斷線"), more }} slots={[<code key="slot-0" className="machine" />]} />
        </p>
        <Button
          size="sm"
          variant="quiet"
          aria-pressed={asTable}
          icon={asTable ? <ChartLine aria-hidden /> : <Table2 aria-hidden />}
          onClick={() => { setAsTable((current) => !current); }}
          className="pointer-coarse:min-h-11"
        >
          {asTable ? tr("以圖表檢視") : tr("以表格檢視")}
        </Button>
      </div>
      {asTable ? (
        <SamplesTable series={model.series} times={model.times} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {drawable.map((panel) => {
            const info = MEMORY_PANELS[panel.panel];
            const total = panel.panel === "nvml_device" ? model.deviceTotal.get(panel.deviceId ?? "-") : undefined;
            const lines: LineSeries[] = panel.series
              .filter((s) => s.max !== null)
              .map((s, index) => ({
                key: s.key,
                label: s.label,
                tone: index === 0 ? "1" : index === 1 ? "2" : "3",
                segments: s.segments,
                samples: s.samples,
              }));
            return (
              <div key={panel.key} className="grid min-w-0 content-start gap-1 rounded-lg border border-line-subtle bg-sunken p-3">
                <p className="text-data font-semibold text-fg">
                  {info.title}
                  {(panel.deviceId != null && panel.deviceId !== "") ? <code className="machine ml-2 text-caption font-normal text-fg-tertiary">{panel.deviceId}</code> : null}
                </p>
                <p className="text-caption text-fg-tertiary">
                  {tr("scope：{scope}。{note}", { scope: info.scope, note: info.note })}
                </p>
                <LineChart
                  label={tr("{title}{value} 記憶體取樣", { title: info.title, value: (panel.deviceId != null && panel.deviceId !== "") ? ` ${panel.deviceId}` : "" })}
                  series={lines}
                  times={model.times}
                  xMax={model.durationMs}
                  reference={total !== undefined ? { value: total, label: tr("整卡總量 {total}", { total: formatBytes(total) }) } : null}
                />
              </div>
            );
          })}
        </div>
      )}
      {empty.length > 0 ? (
        <ul className="grid gap-1 text-caption text-fg-tertiary">
          {empty.map((panel) => (
            <li key={panel.key}>
              {tr("{title}：所有取樣皆為 null（{value}），不以其他口徑代替。", { title: MEMORY_PANELS[panel.panel].title, value: tServer(panel.series.find((s) => Boolean(s.nullReason))?.nullReason) ?? tr("未提供原因") })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MemorySection({ recording }: { recording: Recording }) {
  const id = recording.context.recording_id;
  const [requested, setRequested] = useState(false);
  const streams = useEventStreams(id, requested);
  const metrics = recording.summary.metrics;
  const rows = MEMORY_GROUP
    ? groupMetricNames(MEMORY_GROUP, metrics).map((name) => ({ name, metric: metrics[name] ?? missingMetric(name), missing: metrics[name] === undefined }))
    : [];
  const showCurves = requested || streams.data !== undefined;
  return (
    <section aria-labelledby={`${id}-memory`} className="grid gap-3">
      <h3 id={`${id}-memory`} className="flex items-center gap-2 text-section font-semibold text-fg">
        <MemoryStick aria-hidden className="size-4 text-fg-tertiary" />
        {tr("記憶體")}
      </h3>
      {(MEMORY_GROUP?.note != null && MEMORY_GROUP.note !== "") ? <p className="text-caption text-fg-tertiary">{MEMORY_GROUP.note}</p> : null}
      <MetricTable label={tr("記憶體峰值（各口徑分列）")} rows={rows} />
      <LoadRunNote recording={recording} />
      <div className="grid gap-3">
        <h4 className="text-data font-semibold text-fg-secondary">{tr("取樣曲線")}</h4>
        {!requested ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" icon={<ChartLine aria-hidden />} onClick={() => { setRequested(true); }}>
              {tr("讀取事件並繪製取樣曲線")}
            </Button>
            <span className="text-caption text-fg-tertiary">{tr("需要讀取此 recording 的事件（每個 stream 一頁）；已在其他分頁載入的事件會直接使用。")}</span>
          </div>
        ) : null}
        {!showCurves ? null : streams.data ? (
          streams.data.streams.length === 0 ? (
            <p className="text-caption text-fg-tertiary">{tr("此 recording 沒有任何事件 stream。")}</p>
          ) : (
            streams.data.streams.map((stream) => <StreamMemory key={stream.stream_id} recording={recording} streamId={stream.stream_id} enabled={requested} />)
          )
        ) : (streams.error != null) ? (
          <QueryErrorCallout error={streams.error} title={tr("無法列出事件 stream")} onRetry={() => void streams.refetch()} />
        ) : (
          <LoadingBlock label={tr("列出事件 stream…")} />
        )}
      </div>
    </section>
  );
}
