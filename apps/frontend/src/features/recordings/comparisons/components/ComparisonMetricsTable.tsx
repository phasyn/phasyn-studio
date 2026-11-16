// 指標比較：列＝metric、欄＝recording，每格附 unit／quality／method；null 不是 0。
// 不計算倍率、差值、加速比，也沒有勝出標記；口徑或品質不同的列明確標示「不可直接比較」。
// 表格不自帶捲動容器：由比較內容區捲動，表頭與指標名稱欄保持可見（stickyTable.ts）。
import { TriangleAlert } from "lucide-react";
import type { Metric } from "@/api/generated/contracts";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { MetricInline, MetricName } from "../../components/MetricValue";
import { basisMismatch, orderComparisonMetrics } from "../model/metricsTable";
import { ColumnHead, type ColumnState } from "./ColumnHead";
import { BASELINE_CELL, BASELINE_HEAD, CORNER_CELL, HEAD_CELL, ROW_HEAD_CELL } from "./stickyTable";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

function MismatchNote({ cells }: { cells: ReadonlyArray<Metric | undefined> }) {
  const mismatch = basisMismatch(cells);
  const parts = [mismatch.unit ? "unit" : null, mismatch.method ? "method" : null, mismatch.scope ? "scope" : null].filter(Boolean);
  if (parts.length === 0 && !mismatch.quality) return null;
  return (
    <span className="mt-1 flex items-start gap-1 text-caption text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {parts.length > 0 ? t("口徑不同（{parts}），不可直接比較", { parts: formatList(parts, { type: "disjunction", separator: "／" }) }) : t("品質不同（例如實測與取樣），解讀時需注意")}
    </span>
  );
}

export function ComparisonMetricsTable({
  metrics,
  columns,
  labelledBy,
}: {
  metrics: Record<string, Metric[] | undefined>;
  columns: readonly ColumnState[];
  labelledBy: string;
}) {
  const sections = orderComparisonMetrics(Object.keys(metrics));
  if (sections.length === 0) return <p className="text-data text-fg-secondary">{t("比較結果沒有任何指標。")}</p>;
  return (
    <Table aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <Th scope="col" className={cn("min-w-[15rem]", CORNER_CELL)}>
            {t("指標")}
          </Th>
          {columns.map((column, index) => (
            <Th key={column.id} scope="col" className={cn(HEAD_CELL, index === 0 && BASELINE_HEAD)}>
              <ColumnHead index={index} column={column} />
            </Th>
          ))}
        </tr>
      </thead>
      {sections.map((section) => (
        <tbody key={section.id}>
          <tr>
            <th scope="colgroup" colSpan={columns.length + 1} className="border-b border-line bg-raised px-4 py-2 text-left text-data font-semibold text-fg">
              <span className="sticky left-4 inline-block">{section.title}</span>
            </th>
          </tr>
          {section.names.map((name) => {
            const cells = columns.map((_, index) => metrics[name]?.[index]);
            return (
              <Tr key={name}>
                <Th scope="row" className={cn("max-w-[22rem] min-w-[15rem] border-b-line-subtle align-top font-normal whitespace-normal", ROW_HEAD_CELL)}>
                  <MetricName name={name} />
                  <MismatchNote cells={cells} />
                </Th>
                {cells.map((metric, index) => (
                  <Td key={columns[index]?.id ?? index} className={cn("min-w-[10rem]", index === 0 && BASELINE_CELL)}>
                    {metric ? <MetricInline metric={metric} /> : <span className="text-caption text-fg-tertiary">{t("未回報")}</span>}
                  </Td>
                ))}
              </Tr>
            );
          })}
        </tbody>
      ))}
    </Table>
  );
}
