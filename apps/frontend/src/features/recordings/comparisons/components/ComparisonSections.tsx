// 比較內容區的各區段（來源與混淆因素、量測條件、設定差異、量測值）與工具列常駐的比較條件 chip。
// 區段標題可聚焦（tabIndex=-1），工具列「跳到」會捲到該區段並把焦點交給標題。
import { ChartColumn, Link2, Link2Off, Scale, ShieldQuestion, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { Comparison } from "@/api/generated/contracts";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/controls";
import { StatusChip } from "@/components/workbench/StatusChip";
import { tServer, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { comparability, type SourceVerdict } from "../model/comparability";
import { confounderDetails, isNotRecorded, type ConfounderDetail } from "../model/confounders";
import type { DiffRow } from "../model/settingsDiff";
import type { ColumnState } from "./ColumnHead";
import { ComparisonMetricsTable } from "./ComparisonMetricsTable";
import { SettingsDiffTable } from "./SettingsDiffTable";
import { T } from "@/i18n/T";

const SOURCE_ICON: Record<SourceVerdict, typeof Link2> = { same: Link2, different: Link2Off, unknown: ShieldQuestion };

export function SectionHeading({ id, icon, children }: { id: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <h2
      id={id}
      tabIndex={-1}
      className="flex min-w-0 scroll-mt-2 items-center gap-2 text-section font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-tertiary"
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </h2>
  );
}

/** 工具列右側常駐：來源判定與混淆因素數量（捲到量測值時仍看得到）。 */
export function ComparabilityChips({ data }: { data: Pick<Comparison, "same_source" | "confounders"> }) {
  const summary = comparability(data);
  return (
    <span role="group" aria-label={t("比較條件")} className="flex flex-wrap items-center gap-1.5">
      <StatusChip tone={summary.sourceTone} label={summary.sourceLabel} title={summary.sourceNote} />
      <StatusChip
        tone={summary.confounderTone}
        label={summary.confounderLabel}
        title={summary.confounderCount > 0 ? t("有混淆因素：差異不能直接歸因於設定（詳見「來源與混淆因素」）") : t("伺服器沒有列出混淆因素")}
      />
    </span>
  );
}

function SameSource({ data }: { data: Pick<Comparison, "same_source" | "confounders"> }) {
  const summary = comparability(data);
  const Icon = SOURCE_ICON[summary.source];
  return (
    <span className="grid content-start gap-1">
      <Badge tone={summary.sourceTone} className="justify-self-start">
        <Icon aria-hidden />
        {summary.sourceLabel}
      </Badge>
      <span className="text-caption text-fg-secondary">{summary.sourceNote}</span>
    </span>
  );
}

/** 一個混淆因素：認得的標籤逐筆列出可讀的值（物件可展開看每個欄位）；不認得的照伺服器原文。 */
function Confounder({ detail, columns }: { detail: ConfounderDetail; columns: readonly ColumnState[] }) {
  if (!detail.values || detail.label === null) return <span className="text-fg">{tServer(detail.text)}</span>;
  return (
    <span className="grid min-w-0 gap-1">
      <span className="text-fg">{t("{label}不同", { label: tServer(detail.label) })}</span>
      <ul className="grid min-w-0 gap-0.5">
        {detail.values.map((value, index) => {
          const context = columns[index]?.data?.context;
          return (
            <li key={columns[index]?.id ?? index} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-caption">
              <span className="machine text-fg-tertiary" title={columns[index]?.id}>
                #{index + 1}
                {context ? ` ${context.component_id}` : ""}
              </span>
              {value.entries.length > 0 ? (
                <details className="min-w-0">
                  <summary className="cursor-pointer text-fg-secondary [overflow-wrap:anywhere]">{value.summary}</summary>
                  <dl className="mt-1 grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border border-line-subtle bg-sunken px-2 py-1.5">
                    {value.entries.map(([path, text]) => (
                      <div key={path} className="contents">
                        <dt className="machine break-all text-fg-tertiary">{path}</dt>
                        <dd className="machine break-all text-fg">{text}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : (
                <span className={cn("machine min-w-0 [overflow-wrap:anywhere]", isNotRecorded(value) ? "text-fg-tertiary" : "text-fg-secondary")}>{value.summary}</span>
              )}
            </li>
          );
        })}
      </ul>
    </span>
  );
}

export function SourceSection({ id, data, columns = [] }: { id: string; data: Comparison; columns?: readonly ColumnState[] }) {
  const summary = comparability(data);
  // 伺服器的值依 recording_ids 的順序：欄位照同一個順序對齊
  const aligned = data.recording_ids.map((recordingId): ColumnState => columns.find((column) => column.id === recordingId) ?? { id: recordingId, data: undefined, error: null, isPending: false });
  const details = confounderDetails(data.confounders, aligned.map((column) => column.data?.context));
  return (
    <section aria-labelledby={id} className="@container grid grid-cols-[minmax(0,1fr)] gap-3">
      <SectionHeading id={id} icon={<Scale aria-hidden />}>
        {t("來源與混淆因素")}
      </SectionHeading>
      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <SameSource data={data} />
        {data.confounders.length > 0 ? (
          <Callout tone="warning" icon={<TriangleAlert />} title={t("{confoundersCount} 個混淆因素：差異不能直接歸因於設定", { confoundersCount: data.confounders.length })}>
            <ul className="grid list-disc gap-1 pl-5">
              {details.map((detail, index) => (
                <li key={`${index}-${detail.text.slice(0, 32)}`} className="min-w-0 [overflow-wrap:anywhere] text-fg">
                  <Confounder detail={detail} columns={aligned} />
                </li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout tone="info" title={t("伺服器沒有列出混淆因素")}>
            <p>{t("shape、seed、模型、裝置、冷暖、compile、cache、recorder 模式與 trace 都未判定不同；可在「量測條件」核對。")}</p>
          </Callout>
        )}
      </div>
      {summary.comparable ? (
        <p className="flex items-start gap-2 text-data text-fg-secondary">
          <T source={"<0>可歸因候選</0>條件可比（同來源、無已知混淆因素）：設定差異是耗時／記憶體差異的可歸因候選；畫質仍要看輸出。"} slots={[<Badge tone="info" />]} />
        </p>
      ) : (
        <p className="text-data text-fg-secondary">{t("有混淆因素或來源不同／未知：不要把耗時或記憶體差異歸因到某個設定（例如精度）。")}</p>
      )}
      <p className="text-caption text-fg-tertiary">{t("單次（n=1），不計 p95：每欄是一筆 recording；steps.* 分位數是單一 recording 內各 step 的統計，不是多次 run 的分布。")}</p>
    </section>
  );
}

/** 路徑 × recording 的差異區段（量測條件、設定差異共用）；「只顯示不同」開關各區段獨立，預設開啟。 */
export function DiffSection({
  id,
  title,
  icon,
  description,
  rows,
  columns,
  emptyText,
}: {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  rows: readonly DiffRow[];
  columns: readonly ColumnState[];
  emptyText: string;
}) {
  const toggleId = useId();
  const [changedOnly, setChangedOnly] = useState(true);
  const changedCount = rows.filter((row) => row.anyChange).length;
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <SectionHeading id={id} icon={icon}>
          {title}
        </SectionHeading>
        {rows.length > 0 ? (
          <Checkbox
            id={toggleId}
            label={t("只顯示與基準不同的路徑")}
            description={t("共 {rowsCount} 個路徑，其中 {changedCount} 個與基準不同或無法解讀", { rowsCount: rows.length, changedCount })}
            checked={changedOnly}
            onChange={(event) => setChangedOnly(event.target.checked)}
            className="min-h-8 py-1 text-data"
          />
        ) : null}
      </div>
      {description ? <p className="text-caption text-fg-tertiary">{description}</p> : null}
      {rows.length === 0 ? (
        <p className="rounded-md border border-line-subtle bg-sunken px-3 py-3 text-data text-fg-secondary">{emptyText}</p>
      ) : (
        <SettingsDiffTable rows={rows} columns={columns} changedOnly={changedOnly} labelledBy={id} />
      )}
    </section>
  );
}

export function MetricsSection({ id, metrics, columns }: { id: string; metrics: Comparison["metrics"]; columns: readonly ColumnState[] }) {
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <SectionHeading id={id} icon={<ChartColumn aria-hidden />}>
        {t("量測值")}
      </SectionHeading>
      <p className="text-caption text-fg-tertiary">{t("每格附單位、品質與 method／scope；未量測顯示原因、不是 0。口徑不同的列不可直接比較。CSV 可從頁首下載。")}</p>
      <ComparisonMetricsTable metrics={metrics} columns={columns} labelledBy={id} />
    </section>
  );
}
