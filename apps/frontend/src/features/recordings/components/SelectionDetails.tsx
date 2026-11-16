// 檢視器的「選取項目」：選取的 part／搬運類別／事件細節。事件細節只讀「已載入」的事件快取（不在這裡發請求），
// network 的 consumer（計數）與 producer（對照）分列，合計不重複計算。
import { ArrowLeftRight, Puzzle, ScrollText } from "lucide-react";
import { useMemo } from "react";
import type { Recording, RecordingEvent } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyValueList } from "@/components/ui/kv";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatBytes, formatCount, formatMs } from "@/lib/format";
import { useEventStreams, useStreamEvents } from "../api";
import { eventSummary } from "@/lib/recordingEvents";
import { flattenPages } from "../model/events";
import { missingMetric } from "../model/metrics";
import { partRows } from "../model/parts";
import type { Selection } from "../model/selection";
import { formatSettingValue, flattenSettings } from "../model/settings";
import { aggregateTransferEvents, CATEGORY_HELP, pairNetworkRows, transferTotalsRows, type TransferEventRow } from "../model/transfers";
import { CopyButton } from "./Feedback";
import { MetricTable } from "./MetricValue";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";

function useLoadedStreams(recordingId: string) {
  const streams = useEventStreams(recordingId, false);
  return streams.data?.streams ?? null;
}

function NotLoaded() {
  return <p className="text-caption text-fg-tertiary">{t("事件尚未載入：到「時間軸」分頁或下方「原始事件」面板載入後，這裡會列出對應的事件細節。")}</p>;
}

function TransferRowsTable({ rows, label }: { rows: readonly TransferEventRow[]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <TableScroll label={label}>
      <Table>
        <thead>
          <tr>
            <Th scope="col">transfer</Th>
            <Th scope="col">{t("提交 · 完成")}</Th>
            <Th scope="col">host · GPU event</Th>
            <Th scope="col">owner · basis</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map((row) => (
            <Tr key={`${row.streamId}:${row.seq}`}>
              <Td className="machine text-caption">
                <span className="block text-fg">{row.data.transfer_id}</span>
                <span className="block text-fg-tertiary">
                  {row.data.direction} · {row.data.completion_status} · {row.streamId}#{row.seq}
                </span>
                {row.data.part ? <span className="block text-fg-tertiary">{row.data.part}</span> : null}
              </Td>
              <Td className="machine text-caption whitespace-nowrap">
                {formatBytes(row.data.submitted_bytes)}
                <span className="block">
                  {row.data.completed_bytes === null ? <span className="text-warning">{t("未確認完成")}</span> : formatBytes(row.data.completed_bytes)}
                </span>
              </Td>
              <Td className="machine text-caption whitespace-nowrap">
                {formatMs(row.data.host_ms)}
                <span className="block">{row.data.gpu_event_ms === null ? <span className="text-fg-tertiary">{t("GPU 未量測")}</span> : formatMs(row.data.gpu_event_ms)}</span>
              </Td>
              <Td className="machine text-caption">
                {row.data.owner}
                <span className="block text-fg-tertiary">{row.data.byte_basis}</span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function PartStreamDetails({ recordingId, streamId, part }: { recordingId: string; streamId: string; part: string }) {
  const events = useStreamEvents(recordingId, streamId, false);
  const flat = useMemo(() => flattenPages(events.data?.pages ?? []), [events.data]);
  const detail = useMemo(() => {
    const steps = new Map<string, { spans: number; host: number; gpu: number | null }>();
    let spans = 0;
    const transfers: TransferEventRow[] = [];
    for (const event of flat) {
      if (event.kind === "span" && event.data.part === part) {
        spans += 1;
        const key = event.data.step_index === null ? "—" : String(event.data.step_index);
        const entry = steps.get(key) ?? { spans: 0, host: 0, gpu: 0 };
        entry.spans += 1;
        entry.host += event.data.host_ms;
        entry.gpu = entry.gpu === null || event.data.gpu_event_ms === null ? null : entry.gpu + event.data.gpu_event_ms;
        steps.set(key, entry);
      } else if (event.kind === "transfer" && event.data.part === part) {
        transfers.push({ streamId, seq: event.seq, data: event.data });
      }
    }
    return { spans, steps: [...steps.entries()], transfers };
  }, [flat, part, streamId]);
  if (!events.data) return null;
  if (detail.spans === 0 && detail.transfers.length === 0) {
    return (
      <p className="text-caption text-fg-tertiary">
        <T source={"stream <0>{streamId}</0>：已載入的 {flatCount} 筆事件中沒有此 part 的 span 或 transfer。"} values={{ streamId, flatCount: flat.length.toLocaleString("en-US") }} slots={[<code className="machine" />]} />
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-caption text-fg-secondary">
        <T source={"stream <0>{streamId}</0>：span {spans} 筆、transfer {transfersCount} 筆（只計已載入事件）"} values={{ streamId, spans: detail.spans, transfersCount: detail.transfers.length }} slots={[<code className="machine" />]} />
      </p>
      {detail.steps.length > 0 ? (
        <TableScroll label={t("part {part} 每 step 的 span", { part })}>
          <Table>
            <thead>
              <tr>
                <Th scope="col">step</Th>
                <Th scope="col">{t("span 數")}</Th>
                <Th scope="col">{t("host 加總")}</Th>
                <Th scope="col">{t("GPU event 加總")}</Th>
              </tr>
            </thead>
            <tbody>
              {detail.steps.map(([step, entry]) => (
                <Tr key={step}>
                  <Td className="machine">{step}</Td>
                  <Td className="machine">{entry.spans}</Td>
                  <Td className="machine whitespace-nowrap">{formatMs(entry.host)}</Td>
                  <Td className="machine whitespace-nowrap">{entry.gpu === null ? <span className="text-warning">{t("部分未量測")}</span> : formatMs(entry.gpu)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      ) : null}
      <TransferRowsTable rows={detail.transfers} label={t("part {part} 的 transfer 事件", { part })} />
    </div>
  );
}

function PartInfo({ recording, part }: { recording: Recording; part: string }) {
  const id = recording.context.recording_id;
  const row = useMemo(() => partRows(recording.summary).find((entry) => entry.part === part), [recording.summary, part]);
  const expanded = recording.context.settings?.expanded_parts[part];
  const streams = useLoadedStreams(id);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 text-caption text-fg-tertiary">
          <Puzzle aria-hidden className="size-3.5" />
          part
        </p>
        <code className="machine text-data break-all text-fg">{part}</code>
      </div>
      {row ? (
        <KeyValueList
          dense
          items={[
            { key: "calls", label: t("呼叫次數"), value: row.calls === null ? t("未量測") : formatCount(row.calls), mono: true, tone: row.calls === null ? "warning" : "default" },
            {
              key: "host",
              label: t("host（inclusive）"),
              value: row.hostMsInclusive === null ? t("未量測") : `${formatMs(row.hostMsInclusive)} · host span`,
              mono: true,
              tone: row.hostMsInclusive === null ? "warning" : "default",
            },
            ...(row.hostMsExclusive !== null ? [{ key: "excl", label: t("host（exclusive）"), value: formatMs(row.hostMsExclusive), mono: true }] : []),
            {
              key: "gpu",
              label: "GPU event",
              value:
                row.gpuEventMs === null
                  ? t("未量測{value}", { value: row.gpuEventCoverage ? t("（coverage {gpuEventCoverage}）", { gpuEventCoverage: row.gpuEventCoverage }) : "" })
                  : t("{gpuEventMs} · CUDA event 區間{value}", { gpuEventMs: formatMs(row.gpuEventMs), value: row.gpuEventCoverage ? ` · coverage ${row.gpuEventCoverage}` : "" }),
              mono: true,
              tone: row.gpuEventMs === null || (row.gpuEventCoverage && row.gpuEventCoverage !== "full") ? "warning" : "default",
            },
            ...(row.coverageReason ? [{ key: "reason", label: t("coverage 原因"), value: tServer(row.coverageReason), tone: "warning" as const }] : []),
            ...row.transfers.map((transfer) => ({
              key: `t-${transfer.category}`,
              label: transfer.category,
              value: t("{value} 次 · {value2}", { value: transfer.count === null ? "?" : formatCount(transfer.count), value2: transfer.bytes === null ? t("bytes 未確認") : formatBytes(transfer.bytes) }),
              mono: true,
            })),
            ...row.counters.map(([name, value]) => ({
              key: `c-${name}`,
              label: name,
              value: value === null ? t("未量測") : formatCount(value),
              mono: true,
              tone: value === null ? ("warning" as const) : ("default" as const),
            })),
          ]}
        />
      ) : (
        <p className="text-caption text-fg-tertiary">{t("summary.part_totals 沒有此 part 的彙整。")}</p>
      )}
      <div className="grid gap-1.5">
        <h4 className="text-data font-semibold text-fg-secondary">{t("此 part 的展開設定（歷史快照）")}</h4>
        {expanded && Object.keys(expanded).length > 0 ? (
          <dl className="grid gap-1">
            {[...flattenSettings(expanded)].map(([path, value]) => (
              <div key={path} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-caption">
                <dt className="machine break-all text-fg-tertiary">{path}</dt>
                <dd className="machine m-0 break-all text-fg-secondary">{formatSettingValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-caption text-fg-tertiary">{t("沒有針對此 part 的覆寫（沿用 instance 設定）。")}</p>
        )}
      </div>
      <div className="grid gap-2">
        <h4 className="text-data font-semibold text-fg-secondary">{t("已載入事件中的 step／copy")}</h4>
        {streams ? streams.map((stream) => <PartStreamDetails key={stream.stream_id} recordingId={id} streamId={stream.stream_id} part={part} />) : <NotLoaded />}
      </div>
    </div>
  );
}

function CategoryStreamDetails({ recordingId, streamId, category }: { recordingId: string; streamId: string; category: string }) {
  const events = useStreamEvents(recordingId, streamId, false);
  const flat = useMemo(() => flattenPages(events.data?.pages ?? []), [events.data]);
  const aggregate = useMemo(
    () => aggregateTransferEvents(flat.map((event) => ({ streamId, event }))).get(category) ?? null,
    [flat, streamId, category],
  );
  if (!events.data) return null;
  if (!aggregate) {
    return (
      <p className="text-caption text-fg-tertiary">
        <T source={"stream <0>{streamId}</0>：已載入事件中沒有 {category} transfer。"} values={{ streamId, category }} slots={[<code className="machine" />]} />
      </p>
    );
  }
  const hostValues = aggregate.counted.map((row) => row.data.host_ms);
  const range = hostValues.length > 0 ? `${formatMs(Math.min(...hostValues))} – ${formatMs(Math.max(...hostValues))}` : "—";
  return (
    <div className="grid gap-2">
      <p className="text-caption text-fg-secondary">
        <T source={"stream <0>{streamId}</0>：計入 {transfers} 個 transfer（同 transfer_id 取最後狀態）· 提交 {submittedBytes} · 完成 {value} · 每次 host 區間 {range}{value2}"} values={{ streamId, transfers: aggregate.transfers, submittedBytes: formatBytes(aggregate.submittedBytes), value: aggregate.completedBytes === null ? t("未確認（有 transfer 未完成）") : formatBytes(aggregate.completedBytes), range, value2: aggregate.noOpCount > 0 ? t(" · no-op {noOpCount}（不算 copy）", { noOpCount: aggregate.noOpCount }) : "" }} slots={[<code className="machine" />]} />
      </p>
      {category === "network" ? (
        <div className="grid gap-1.5">
          <p className="text-caption text-fg-tertiary">{t("consumer 接收量是唯一合計；producer／sender 紀錄只作對照，不相加。")}</p>
          <ul className="grid gap-1.5">
            {pairNetworkRows(aggregate).slice(0, 50).map((pair) => (
              <li key={pair.transferId}>
                <details className="group rounded-md border border-line-subtle bg-sunken/40">
                  <summary className="flex min-h-9 cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-2 text-caption transition-colors duration-(--duration-fast) hover:bg-raised/60 [&::-webkit-details-marker]:hidden">
                    <code className="machine text-fg">{pair.transferId}</code>
                    {pair.consumer ? (
                      <Badge tone="info">consumer {pair.consumer.data.completed_bytes === null ? t("未確認完成") : formatBytes(pair.consumer.data.completed_bytes)}</Badge>
                    ) : (
                      <Badge tone="warning">{t("沒有 consumer 紀錄（不計入合計）")}</Badge>
                    )}
                    {pair.senders.length > 0 ? <Badge tone="neutral">{t("sender 對照 {sendersCount}", { sendersCount: pair.senders.length })}</Badge> : null}
                  </summary>
                  <div className="border-t border-line-subtle p-2 animate-reveal">
                    <TransferRowsTable rows={[...(pair.consumer ? [pair.consumer] : []), ...pair.senders]} label={t("transfer {transferId} 的 sender／receiver 對照", { transferId: pair.transferId })} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <TransferRowsTable rows={aggregate.counted} label={t("{category} transfer 事件", { category })} />
      )}
    </div>
  );
}

function CategoryInfo({ recording, category }: { recording: Recording; category: string }) {
  const id = recording.context.recording_id;
  const metrics = recording.summary.metrics;
  const totals = useMemo(() => transferTotalsRows(recording.summary).find((row) => row.category === category), [recording.summary, category]);
  const streams = useLoadedStreams(id);
  const metricNames = ["submitted_count", "submitted_bytes", "completed_count", "completed_bytes"].map((suffix) => `${category}_${suffix}`);
  const metricRows = metricNames.filter((name) => metrics[name] !== undefined).map((name) => ({ name, metric: metrics[name] ?? missingMetric(name) }));
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 text-caption text-fg-tertiary">
          <ArrowLeftRight aria-hidden className="size-3.5" />
          {t("搬運類別")}
        </p>
        <code className="machine text-data text-fg">{category}</code>
        <p className="text-caption text-fg-secondary">{CATEGORY_HELP[category] ?? t("provider 自訂類別")}</p>
      </div>
      {totals ? (
        <KeyValueList
          dense
          items={[
            { key: "sub", label: t("提交"), value: t("{value} 次 · {formatBytes}", { value: totals.submittedCount ?? "?", formatBytes: formatBytes(totals.submittedBytes ?? null) }), mono: true },
            {
              key: "done",
              label: t("完成"),
              value: totals.completedBytes === null || totals.completedCount === null ? t("未確認完成") : t("{value} 次 · {formatBytes}", { value: totals.completedCount ?? "?", formatBytes: formatBytes(totals.completedBytes ?? null) }),
              mono: true,
              tone: totals.completedBytes === null ? "warning" : "default",
            },
            { key: "host", label: t("host 區間加總"), value: formatMs(totals.hostMsSum ?? null), mono: true },
            { key: "gpu", label: t("GPU event 加總"), value: formatMs(totals.gpuEventMsSum ?? null), mono: true },
            {
              key: "gbps",
              label: t("有效頻寬"),
              value: typeof totals.effectiveGbps === "number" ? `${totals.effectiveGbps.toFixed(2)} GB/s` : t("未提供（不推算）"),
              mono: true,
            },
          ]}
        />
      ) : (
        <p className="text-caption text-fg-tertiary">{t("summary.transfer_totals 沒有此類別。")}</p>
      )}
      {metricRows.length > 0 ? <MetricTable label={t("{category} 計數指標", { category })} rows={metricRows} /> : null}
      <div className="grid gap-2">
        <h4 className="text-data font-semibold text-fg-secondary">{t("已載入事件（逐次 copy）")}</h4>
        {streams ? streams.map((stream) => <CategoryStreamDetails key={stream.stream_id} recordingId={id} streamId={stream.stream_id} category={category} />) : <NotLoaded />}
      </div>
    </div>
  );
}

function EventInfo({
  recording,
  streamId,
  seq,
  onSelect,
}: {
  recording: Recording;
  streamId: string;
  seq: number;
  onSelect: (selection: Selection) => void;
}) {
  const events = useStreamEvents(recording.context.recording_id, streamId, false);
  const event: RecordingEvent | undefined = useMemo(() => {
    for (const page of events.data?.pages ?? []) {
      const found = page.events.find((item) => item.seq === seq);
      if (found) return found;
    }
    return undefined;
  }, [events.data, seq]);
  if (!event) return <p className="text-caption text-fg-tertiary">{t("找不到此事件（可能已重新讀取）。")}</p>;
  const part = event.kind === "span" || event.kind === "transfer" ? event.data.part : null;
  const json = JSON.stringify(event, null, 2);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 text-caption text-fg-tertiary">
          <ScrollText aria-hidden className="size-3.5" />
          {t("事件 {kind} · {level}", { kind: event.kind, level: event.level })}
        </p>
        <p className="text-data break-words text-fg">{eventSummary(event)}</p>
        <p className="machine text-caption text-fg-tertiary">
          {event.stream_id}#{event.seq} · {event.occurred_at}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {part ? (
          <Button size="sm" variant="secondary" icon={<Puzzle aria-hidden />} onClick={() => onSelect({ kind: "part", part })}>
            {t("檢視 part")}
          </Button>
        ) : null}
        {event.kind === "transfer" ? (
          <Button size="sm" variant="secondary" icon={<ArrowLeftRight aria-hidden />} onClick={() => onSelect({ kind: "category", category: event.data.category })}>
            {t("檢視類別 {category}", { category: event.data.category })}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between">
          <h4 className="text-data font-semibold text-fg-secondary">{t("完整 JSON")}</h4>
          <CopyButton text={json} label={t("複製事件 JSON")} />
        </div>
        <pre className="max-h-96 overflow-auto rounded-md bg-sunken p-2 text-caption whitespace-pre text-fg-secondary">{json}</pre>
      </div>
    </div>
  );
}

/** 選取項目的細節（part、搬運類別或單一事件）；外框、標題與「清除選取」由檢視器提供。 */
export function SelectionDetails({ recording, selection, onSelect }: { recording: Recording; selection: Selection; onSelect: (selection: Selection) => void }) {
  if (selection.kind === "part") return <PartInfo key={selection.part} recording={recording} part={selection.part} />;
  if (selection.kind === "category") return <CategoryInfo key={selection.category} recording={recording} category={selection.category} />;
  return <EventInfo key={`${selection.streamId}:${selection.seq}`} recording={recording} streamId={selection.streamId} seq={selection.seq} onSelect={onSelect} />;
}
