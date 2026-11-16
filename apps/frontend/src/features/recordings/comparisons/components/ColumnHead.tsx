// 比較表的欄標題：第幾筆（第 1 筆為基準）、operation、元件、時間與短 ID；讀取失敗時照實標示。
// 表頭固定在內容區頂端，所以壓成三行；Node、provider、run 等完整事實在檢視器的「比較對象」。
import type { Recording } from "@/api/generated/contracts";
import { formatTimestamp } from "@/lib/format";
import { OperationBadge, SyntheticBadge } from "../../components/Badges";
import { describeError } from "../../model/errors";
import { t } from "@/i18n";

export interface ColumnState {
  id: string;
  data: Recording | undefined;
  error: unknown;
  isPending: boolean;
}

export function ColumnHead({ index, column }: { index: number; column: ColumnState }) {
  const context = column.data?.context;
  return (
    <span className="grid min-w-[11rem] gap-0.5 text-left font-normal whitespace-normal">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-caption font-semibold text-fg-secondary">#{index + 1}</span>
        {index === 0 ? (
          <span className="rounded-full border border-brand-blue/40 bg-brand-soft px-1.5 text-[11px] leading-4 font-semibold text-action-fg">{t("基準")}</span>
        ) : null}
        {context ? <OperationBadge operation={context.operation} /> : null}
        {context?.synthetic ? <SyntheticBadge /> : null}
      </span>
      {context ? (
        <span className="machine text-data break-all text-fg">{context.component_id}</span>
      ) : column.error ? (
        <span className="text-caption text-danger">{t("讀取失敗：{code}", { code: describeError(column.error).code })}</span>
      ) : (
        <span className="text-caption text-fg-tertiary">{column.isPending ? t("讀取中…") : "—"}</span>
      )}
      <span className="flex flex-wrap items-center gap-x-2 text-caption text-fg-tertiary">
        {context ? (
          <time dateTime={context.created_at} title={t("{created_at}（UTC）", { created_at: context.created_at })} className="machine">
            {formatTimestamp(context.created_at)}
          </time>
        ) : null}
        <code className="machine" title={column.id}>
          {column.id.slice(0, 8)}
        </code>
      </span>
    </span>
  );
}
