// 紀錄狀態／口徑標記：一律圖示＋文字，不只靠顏色。
import {
  Activity,
  Ban,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  FlaskConical,
  Scissors,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import type { Quality, RecordingContext, RecordingSummary } from "@/api/generated/contracts";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { StatusChip } from "@/components/workbench/StatusChip";
import { QUALITY_LABELS } from "@/lib/format";
import { QUALITY_HELP, QUALITY_TONE } from "../model/metrics";
import { getLocale, t } from "@/i18n";

const STATE_SPEC: Record<RecordingSummary["state"], { tone: BadgeTone; label: string; icon: typeof Activity }> = {
  running: { tone: "info", label: t("執行中"), icon: Activity },
  succeeded: { tone: "success", label: t("成功"), icon: CircleCheck },
  failed: { tone: "danger", label: t("失敗"), icon: CircleX },
  cancelled: { tone: "neutral", label: t("已取消"), icon: Ban },
  interrupted: { tone: "warning", label: t("已中斷"), icon: TriangleAlert },
  unknown: { tone: "warning", label: t("狀態未知"), icon: CircleQuestionMark },
};

export function RecordingStateBadge({ state }: { state: RecordingSummary["state"] }) {
  const spec = STATE_SPEC[state];
  const Icon = spec.icon;
  return (
    <Badge tone={spec.tone}>
      <Icon aria-hidden />
      {spec.label}
    </Badge>
  );
}

/** 檢視器標頭用的狀態 chip（點＋文字；執行中改用旋轉圖示）。 */
export function RecordingStateChip({ state }: { state: RecordingSummary["state"] }) {
  const spec = STATE_SPEC[state];
  return <StatusChip tone={spec.tone} label={spec.label} spinning={state === "running"} />;
}

const OPERATION_LABEL: Record<RecordingContext["operation"], string> = {
  load: t("載入"),
  invoke: t("呼叫"),
  unload: t("卸載"),
  controller: t("主控"),
  node: "Node",
};

export function OperationBadge({ operation }: { operation: RecordingContext["operation"] }) {
  return (
    <Badge tone="entity">
      <span className="machine">{operation}</span>
      {/* en 的說明只是重複 operation（invoke Call）：只在 zh-Hant／ja 顯示 */}
      {getLocale() === "en" ? null : <span>{OPERATION_LABEL[operation]}</span>}
    </Badge>
  );
}

export function CoverageBadge({ coverage }: { coverage: RecordingSummary["coverage"] }) {
  if (coverage === "full") return <Badge tone="neutral">{t("coverage 完整")}</Badge>;
  return (
    <Badge tone="warning">
      <CircleDashed aria-hidden />
      {coverage === "partial" ? t("coverage 部分") : t("無 coverage")}
    </Badge>
  );
}

export function SyntheticBadge() {
  return (
    <Badge tone="warning">
      <FlaskConical aria-hidden />
      {t("合成示例")}
    </Badge>
  );
}

export function QualityBadge({ quality }: { quality: Quality }) {
  return (
    <Badge tone={QUALITY_TONE[quality]} title={QUALITY_HELP[quality]}>
      {QUALITY_LABELS[quality]}
    </Badge>
  );
}

/** 列表與明細共用：coverage、丟失、截斷、context 缺漏、合成示例（hideSynthetic＝同一區已另行標示合成示例）。 */
export function RecordingFlags({
  recording,
  compact = false,
  hideSynthetic = false,
}: {
  recording: { context: RecordingContext; summary: RecordingSummary };
  compact?: boolean;
  hideSynthetic?: boolean;
}) {
  const { summary, context } = recording;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {summary.coverage !== "full" || !compact ? <CoverageBadge coverage={summary.coverage} /> : null}
      {summary.dropped_events > 0 ? (
        <Badge tone="warning">
          <TriangleAlert aria-hidden />
          {t("丟失 {dropped_events} 事件", { dropped_events: summary.dropped_events.toLocaleString("en-US") })}
        </Badge>
      ) : null}
      {summary.detail_truncated ? (
        <Badge tone="warning">
          <Scissors aria-hidden />
          {t("細節截斷")}
        </Badge>
      ) : null}
      {!summary.context_available ? (
        <Badge tone="warning">
          <Unlink aria-hidden />
          {t("context 尚未收到")}
        </Badge>
      ) : null}
      {context.synthetic && !hideSynthetic ? <SyntheticBadge /> : null}
    </span>
  );
}
