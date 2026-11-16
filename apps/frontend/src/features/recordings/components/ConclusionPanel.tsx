// 可行動結論：主要時間落在哪個區域（只用已量測值，附方法／品質）；無量測就直說，不給虛構建議。
// 橫條是單一色相的「佔整段 wall 比例」，各區可能重疊，所以不堆疊、不相加為 100%。
import { ChartNoAxesGantt, Gauge, Puzzle } from "lucide-react";
import type { RecordingSummary } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/format";
import { buildConclusion } from "../model/conclusion";
import { QualityBadge } from "./Badges";
import { MetricValue } from "./MetricValue";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function percent(share: number | null): string {
  if (share === null) return t("wall 未量測");
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}% wall`;
}

export function ConclusionPanel({
  summary,
  onOpenTimeline,
  onOpenParts,
}: {
  summary: RecordingSummary;
  onOpenTimeline: () => void;
  onOpenParts: () => void;
}) {
  const conclusion = buildConclusion(summary);
  const { dominant, wall } = conclusion;
  return (
    <section aria-labelledby={`${summary.recording_id}-conclusion`} className="grid gap-3 rounded-xl border border-line-subtle bg-raised/40 px-4 py-3 shadow-edge">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 id={`${summary.recording_id}-conclusion`} className="flex items-center gap-2 text-caption font-medium text-fg-tertiary">
            <Gauge aria-hidden className="size-4" />
            {t("時間結論（只依已量測值）")}
          </h3>
          {conclusion.kind === "dominant" && dominant ? (
            <p className="text-section font-semibold text-fg">
              <T source={"主要時間在「{label}」：<0>{ms}</0><1>（{share}）</1>"} values={{ label: dominant.label, ms: formatMs(dominant.ms), share: percent(dominant.share) }} slots={[<span className="machine" />, <span className="ml-2 text-data font-normal text-fg-secondary" />]} />
            </p>
          ) : conclusion.kind === "wall_only" && wall ? (
            <p className="text-section font-semibold text-fg">
              <T source={"只有整段 wall（<0>{formatMs}</0>），沒有分段量測，無法判斷主要時間區域。"} values={{ formatMs: formatMs(wall.value) }} slots={[<span className="machine" />]} />
            </p>
          ) : (
            <p className="text-section font-semibold text-warning">{t("此 recording 沒有可用的時間量測，無法判斷主要時間區域。")}</p>
          )}
          {dominant ? (
            <p className="machine text-caption text-fg-tertiary">
              {t("來源 {metricName} · {value}{value2}", { metricName: dominant.metricName, value: dominant.metric.method || t("method 未標示"), value2: dominant.metric.scope ? ` · ${dominant.metric.scope}` : "" })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="quiet" icon={<ChartNoAxesGantt aria-hidden />} onClick={onOpenTimeline} className="pointer-coarse:min-h-11">
            {t("看時間軸")}
          </Button>
          <Button size="sm" variant="quiet" icon={<Puzzle aria-hidden />} onClick={onOpenParts} className="pointer-coarse:min-h-11">
            {t("看部件")}
          </Button>
        </div>
      </div>
      {conclusion.areas.length > 0 ? (
        <ul className="grid gap-1.5" aria-label={t("已量測的時間區域（由大到小）")}>
          {conclusion.areas.map((area, index) => {
            const ratio = area.share ?? (dominant && dominant.ms > 0 ? area.ms / dominant.ms : 0);
            return (
              <li
                key={area.key}
                ref={reveal(index)}
                className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] items-center gap-3 text-data"
              >
                <span className="truncate text-fg-secondary" title={area.label}>
                  {area.label}
                </span>
                <span aria-hidden className="relative h-2 min-w-0 overflow-hidden rounded-full bg-line-subtle">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-series-1" style={{ width: `${Math.min(100, Math.max(1, ratio * 100))}%` }} />
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
                  <MetricValue metric={area.metric} />
                  <span className="text-caption text-fg-tertiary">{percent(area.share)}</span>
                  <QualityBadge quality={area.metric.quality} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="grid gap-1 text-caption text-fg-tertiary">
        <p>
          {t("區域可能重疊（例如 copy 與計算並行），比例不相加為 100%；搬運是各次 host 區間加總，並行時可超過 wall。GPU event 區間{value}不與 host 區間相加。", { value: conclusion.gpuEvent ? t("（{formatMs}，cuda_event）", { formatMs: formatMs(conclusion.gpuEvent.value) }) : t("（未量測）") })}
        </p>
        {conclusion.unmeasured.length > 0 ? (
          <p>
            <T source={"未量測區域：{map}。"} values={{ map: conclusion.unmeasured.map((area, index) => (
              <span key={area.key}>
                <T source={"{value}{label}<0>（{metricName}</0>{value2}{value3}）"} values={{ value: index > 0 ? t("、") : "", label: area.label, metricName: area.metricName, value2: area.state === "not_applicable" ? t("，不適用") : area.state === "missing" ? t("，未回報") : t("，未量測"), value3: area.reason && area.state !== "missing" ? t("：{reason}", { reason: area.reason }) : "" }} slots={[<span className="machine" />]} />
              </span>
            )) }} />
          </p>
        ) : null}
      </div>
    </section>
  );
}
