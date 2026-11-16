// 每個數值都帶 unit／method／quality；null 顯示「未量測」或「不適用」，原因可用鍵盤展開（原生 details）。
import { ChevronRight } from "lucide-react";
import type { Metric } from "@/api/generated/contracts";
import { Table, TableScroll, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { exactMetricValue, formatMetricValue, metricLabel, metricRule, metricState, type MetricState } from "../model/metrics";
import { QualityBadge } from "./Badges";
import { tServer, t } from "@/i18n";

/** 未量測／不適用＋可展開原因。 */
export function ReasonDetails({ state, reason, className }: { state: Exclude<MetricState, "measured">; reason: string | null; className?: string }) {
  return (
    <details className={cn("group min-w-0", className)}>
      <summary
        className={cn(
          "-ml-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-sm pr-1.5 pl-1 transition-colors duration-(--duration-fast) hover:bg-raised/60 [&::-webkit-details-marker]:hidden",
          state === "not_applicable" ? "text-fg-tertiary" : "text-warning",
        )}
      >
        <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform duration-(--duration-spring-snappy) ease-spring-snappy group-open:rotate-90" />
        {state === "not_applicable" ? t("不適用") : t("未量測")}
        <span className="sr-only">{t("，展開原因")}</span>
      </summary>
      <p className="mt-1 max-w-[52ch] text-caption text-fg-secondary animate-reveal">{tServer(reason) ?? t("沒有提供原因")}</p>
    </details>
  );
}

/** 單一數值（不含品質標記）。 */
export function MetricValue({ metric, className }: { metric: Metric; className?: string }) {
  const state = metricState(metric);
  if (state !== "measured") return <ReasonDetails state={state} reason={metric.reason} className={className} />;
  return (
    <span className={cn("machine text-fg", className)} title={exactMetricValue(metric) ?? undefined}>
      {formatMetricValue(metric)}
    </span>
  );
}

/** 數值＋品質＋方法（比較表、結論等精簡位置）。 */
export function MetricInline({ metric, className }: { metric: Metric; className?: string }) {
  return (
    <span className={cn("inline-grid min-w-0 gap-0.5", className)}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MetricValue metric={metric} />
        <QualityBadge quality={metric.quality} />
      </span>
      <span className="machine text-caption text-fg-tertiary">
        {metric.method || t("method 未標示")}
        {metric.scope ? ` · ${metric.scope}` : ""}
        {metric.count !== undefined ? ` · n=${metric.count}` : ""}
      </span>
    </span>
  );
}

/** metric 名稱：繁中標籤＋原始名稱；原始名稱可展開 catalog 口徑說明。 */
export function MetricName({ name }: { name: string }) {
  const label = metricLabel(name);
  const rule = metricRule(name);
  return (
    <div className="grid min-w-0 gap-0.5">
      {label !== name ? <span className="text-data text-fg">{label}</span> : null}
      {rule ? (
        <details className="group min-w-0">
          <summary className="-ml-1 inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-sm px-1 text-caption text-fg-tertiary transition-colors duration-(--duration-fast) hover:bg-raised/60 hover:text-fg-secondary [&::-webkit-details-marker]:hidden">
            <code className="machine">{name}</code>
            <ChevronRight aria-hidden className="size-3 shrink-0 transition-transform duration-(--duration-spring-snappy) ease-spring-snappy group-open:rotate-90" />
            <span className="sr-only">{t("，展開口徑說明")}</span>
          </summary>
          <p className="mt-1 max-w-[52ch] text-caption text-fg-secondary animate-reveal">{rule}</p>
        </details>
      ) : (
        <code className="machine text-caption text-fg-tertiary">{name}</code>
      )}
    </div>
  );
}

export interface MetricTableRow {
  name: string;
  metric: Metric;
  /** summary 沒有此 metric（佔位）。 */
  missing?: boolean;
}

/** metric 表格：指標｜值｜品質｜方法 · 範圍（scope）。 */
export function MetricTable({ label, rows, className }: { label: string; rows: readonly MetricTableRow[]; className?: string }) {
  return (
    <TableScroll label={label} className={className}>
      <Table>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <Th scope="col" className="w-[38%]">
              {t("指標")}
            </Th>
            <Th scope="col">{t("值")}</Th>
            <Th scope="col">{t("品質")}</Th>
            <Th scope="col">{t("方法 · 範圍（scope）")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.name}>
              <Td>
                <MetricName name={row.name} />
              </Td>
              <Td className="min-w-[9rem]">
                <MetricValue metric={row.metric} />
                {row.metric.count !== undefined ? <span className="machine block text-caption text-fg-tertiary">n={row.metric.count}</span> : null}
              </Td>
              <Td>{row.missing ? <span className="text-caption text-fg-tertiary">{t("未回報")}</span> : <QualityBadge quality={row.metric.quality} />}</Td>
              <Td className="machine text-caption text-fg-tertiary">
                {row.metric.method || "—"}
                {row.metric.scope ? <span className="block">{row.metric.scope}</span> : null}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}
