// 中欄的明細標題列（精簡）：元件、operation、狀態與紀錄標記（含合成示例），一行來源資訊；
// 完整事實、ID、匯出、比較與補抓在右側檢視器。「原始事件」按鈕把焦點帶到底部 dock（鍵盤捷徑）。
import { Logs } from "lucide-react";
import type { Recording } from "@/api/generated/contracts";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { OperationBadge, RecordingFlags, RecordingStateBadge } from "./Badges";
import { t } from "@/i18n";

export function DetailHeader({
  recording,
  nodeLabel,
  titleId,
  onOpenRaw,
}: {
  recording: Recording;
  nodeLabel: string | null;
  titleId: string;
  onOpenRaw: () => void;
}) {
  const { context, summary } = recording;
  const kind = providerKind(context.provider_id);
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5 border-b border-line-subtle px-4 py-2.5">
      <div className="grid min-w-0 gap-1">
        <h2 id={titleId} className="flex min-w-0 flex-wrap items-center gap-2 text-section font-semibold text-fg">
          <kind.icon aria-hidden className={cn("size-4 shrink-0", TEXT_TONE[kind.tone])} />
          <span className="machine min-w-0 break-all">{context.component_id || t("（未知元件）")}</span>
          <OperationBadge operation={context.operation} />
          <RecordingStateBadge state={summary.state} />
        </h2>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-fg-tertiary">
          <span className="text-fg-secondary">{nodeLabel ?? t("（Node 名稱未知）")}</span>
          <span aria-hidden>·</span>
          <code className="machine">{context.provider_id || "—"}</code>
          <span aria-hidden>·</span>
          <time dateTime={context.created_at} title={t("{created_at}（UTC）", { created_at: context.created_at })} className="machine">
            {formatTimestamp(context.created_at)}
          </time>
          <RecordingFlags recording={recording} compact />
        </p>
      </div>
      <ToolButton label={t("在下方面板開啟原始事件")} text={t("原始事件")} icon={<Logs aria-hidden />} onClick={onOpenRaw} />
    </header>
  );
}
