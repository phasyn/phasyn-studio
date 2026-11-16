// 搬運表：summary.transfer_totals 逐類別一列，可篩類別；completed=null 顯示「未確認完成」；
// 有效頻寬只顯示伺服器提供的值（不在前端推算）；各類別不相加、network 只以 consumer 合計。
import { ArrowLeftRight, FileSpreadsheet } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { Recording } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { formatBytes, formatCount, formatGbps, formatMs } from "@/lib/format";
import { toCsv } from "../model/csv";
import { downloadText } from "@/lib/download";
import { safeFilePart } from "../model/download";
import { groupMetricNames, METRIC_GROUPS, missingMetric } from "../model/metrics";
import { CATEGORY_FILTERS, CATEGORY_HELP, transferTotalsRows, type Reported } from "../model/transfers";
import { QualityBadge } from "./Badges";
import { MetricTable } from "./MetricValue";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const LIFECYCLE_GROUP = METRIC_GROUPS.find((group) => group.id === "lifecycle");

function Value({ value, kind, nullText = t("未知") }: { value: Reported; kind: "bytes" | "count" | "ms" | "gbps"; nullText?: string }) {
  if (value === undefined) return <span className="text-fg-tertiary">{t("未回報")}</span>;
  if (value === null) return <span className="text-warning">{nullText}</span>;
  const text = kind === "bytes" ? formatBytes(value) : kind === "count" ? formatCount(value) : kind === "ms" ? formatMs(value) : formatGbps(value);
  return (
    <span className="machine text-fg" title={kind === "bytes" ? `${value.toLocaleString("en-US")} bytes` : undefined}>
      {text}
    </span>
  );
}

export function TransferSection({
  recording,
  selectedCategory,
  onSelectCategory,
}: {
  recording: Recording;
  selectedCategory: string | null;
  onSelectCategory: (category: string) => void;
}) {
  const filterId = useId();
  const [filter, setFilter] = useState("all");
  const metrics = recording.summary.metrics;
  const rows = useMemo(() => transferTotalsRows(recording.summary), [recording.summary]);
  const matcher = CATEGORY_FILTERS.find((entry) => entry.id === filter) ?? CATEGORY_FILTERS[0];
  const visible = rows.filter((row) => matcher?.match(row.category) ?? true);
  const lifecycleRows = LIFECYCLE_GROUP
    ? groupMetricNames(LIFECYCLE_GROUP, metrics).map((name) => ({ name, metric: metrics[name] ?? missingMetric(name), missing: metrics[name] === undefined }))
    : [];
  const recordingId = recording.context.recording_id;

  const exportCsv = () => {
    const header = [
      "recording_id",
      "category",
      "submitted_count",
      "submitted_bytes",
      "completed_count",
      "completed_bytes",
      "logical_bytes",
      "no_op_count",
      "pending_count",
      "host_ms_sum",
      "gpu_event_ms_sum",
      "effective_gbps",
      "owner",
      "byte_basis",
    ];
    const body = visible.map((row) => [
      recordingId,
      row.category,
      row.submittedCount,
      row.submittedBytes,
      row.completedCount,
      row.completedBytes,
      row.logicalBytes,
      row.noOpCount,
      row.pendingCount,
      row.hostMsSum,
      row.gpuEventMsSum,
      row.effectiveGbps,
      row.owner,
      row.byteBasis,
    ]);
    downloadText(`transfers-${safeFilePart(recordingId)}.csv`, toCsv(header, body), "text/csv;charset=utf-8");
  };

  return (
    <section aria-labelledby={`${recordingId}-transfers`} className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id={`${recordingId}-transfers`} className="flex items-center gap-2 text-section font-semibold text-fg">
          <ArrowLeftRight aria-hidden className="size-4 text-fg-tertiary" />
          {t("搬運（transfer）")}
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label htmlFor={filterId} className="text-caption text-fg-tertiary">
              {t("類別篩選")}
            </label>
            <Select id={filterId} value={filter} onChange={(event) => setFilter(event.target.value)} className="min-h-9 text-data">
              {CATEGORY_FILTERS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" icon={<FileSpreadsheet aria-hidden />} onClick={exportCsv} disabled={visible.length === 0} title={visible.length === 0 ? t("沒有可匯出的列") : undefined}>
            {t("下載此表 CSV")}
          </Button>
        </div>
      </div>
      <p className="text-caption text-fg-tertiary">
        {t("各類別不是同一條頻寬、不相加；completed 為空＝未確認完成（不是 0）；network 只以 consumer 接收量合計；時間是各次 copy 區間加總，並行時可大於 wall。")}
      </p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-line-subtle bg-sunken px-3 py-3 text-data text-fg-secondary">
          {t("summary 沒有 transfer_totals：可能 recorder 模式不含搬運計數，或此元件沒有被 instrument 的 copy。這不代表搬運為 0。")}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-data text-fg-secondary">{t("此類別沒有紀錄。")}</p>
      ) : (
        <TableScroll label={t("搬運逐類別合計")}>
          <Table>
            <thead>
              <tr>
                <Th scope="col">{t("類別")}</Th>
                <Th scope="col">{t("提交（次數 · bytes）")}</Th>
                <Th scope="col">{t("完成（次數 · bytes）")}</Th>
                <Th scope="col">logical bytes</Th>
                <Th scope="col">no-op · pending</Th>
                <Th scope="col">
                  <T source={"host 區間加總<0>host monotonic</0>"} slots={[<span className="block font-normal" />]} />
                </Th>
                <Th scope="col">
                  <T source={"GPU event 加總<0>cuda_event</0>"} slots={[<span className="block font-normal" />]} />
                </Th>
                <Th scope="col">{t("有效頻寬")}</Th>
                <Th scope="col">owner · byte_basis</Th>
                <Th scope="col">{t("品質")}</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const quality = metrics[`${row.category}_completed_bytes`]?.quality ?? metrics[`${row.category}_submitted_bytes`]?.quality ?? null;
                const selected = row.category === selectedCategory;
                return (
                  <Tr key={row.category} selected={selected}>
                    <Td>
                      <button
                        type="button"
                        onClick={() => onSelectCategory(row.category)}
                        aria-pressed={selected}
                        className="-mx-1 grid min-h-8 min-w-[9rem] justify-items-start rounded-sm px-1 text-left transition-colors duration-(--duration-fast) hover:bg-raised/60 pointer-coarse:min-h-11"
                      >
                        <span className="machine text-action-fg underline-offset-2 hover:underline">{row.category}</span>
                        <span className="text-caption text-fg-tertiary">{CATEGORY_HELP[row.category] ?? t("provider 自訂類別")}</span>
                      </button>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.submittedCount} kind="count" /> · <Value value={row.submittedBytes} kind="bytes" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.completedCount} kind="count" nullText={t("未確認完成")} /> ·{" "}
                      <Value value={row.completedBytes} kind="bytes" nullText={t("未確認完成")} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.logicalBytes} kind="bytes" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.noOpCount} kind="count" /> · <Value value={row.pendingCount} kind="count" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.hostMsSum} kind="ms" />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Value value={row.gpuEventMsSum} kind="ms" nullText={t("未量測")} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {typeof row.effectiveGbps === "number" ? (
                        <Value value={row.effectiveGbps} kind="gbps" />
                      ) : (
                        <span className="text-caption text-fg-tertiary">{t("未提供（不由前端推算）")}</span>
                      )}
                    </Td>
                    <Td className="machine text-caption text-fg-secondary">
                      {row.owner ?? "—"}
                      <span className="block text-fg-tertiary">{row.byteBasis ?? "—"}</span>
                    </Td>
                    <Td>{quality ? <QualityBadge quality={quality} /> : <Badge tone="neutral">{t("未標示")}</Badge>}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}
      <h4 className="text-data font-semibold text-fg-secondary">{t("權重生命週期與 I/O 計數")}</h4>
      {LIFECYCLE_GROUP?.note ? <p className="text-caption text-fg-tertiary">{LIFECYCLE_GROUP.note}</p> : null}
      <MetricTable label={t("權重生命週期與 I/O 計數")} rows={lifecycleRows} />
    </section>
  );
}
