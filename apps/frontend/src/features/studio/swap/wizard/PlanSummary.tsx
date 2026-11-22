// Segments, joins and the time estimate (shared by the plan and output steps).
import { CircleCheck, Clock, Film, LoaderCircle, Scissors, SplitSquareHorizontal, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { usePlanEta } from "../../hooks/usePlanEta";
import { ETA_RISK_DETAIL, ETA_RISK_LABEL, formatEta, missingEtaDetail, missingEtaText, planEtaText, type EtaRisk } from "../../model/eta";
import { NoteList } from "../fields";
import type { WizardDerived } from "../wizardModel";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

/** Segments, joins and the time estimate (shared by the plan and output steps). */
export function PlanSummary({ derived }: { derived: WizardDerived }) {
  const plan = derived.plan;
  const { pending, eta, risks, missing } = usePlanEta(derived.etaInputs);
  if (plan.segments.length === 0) return <NoteList tone="warning" icon={<TriangleAlert aria-hidden />} items={plan.problems.length > 0 ? plan.problems : [t("還沒有可以規劃的範圍")]} />;
  const each = eta ? (eta.shortestSeconds === eta.longestSeconds ? formatEta(eta.shortestSeconds) : `${formatEta(eta.shortestSeconds)}–${formatEta(eta.longestSeconds, { approx: false })}`) : null;
  // Memory risks from the measured sizes (shown even when the plan as a whole has no time estimate)
  const riskLines = (["oom", "beyond_measured"] as const satisfies readonly EtaRisk[]).flatMap((risk) => {
    const segments = risk === "oom" ? risks.oom : risks.beyondMeasured;
    return segments.length > 0 ? [{ risk, segments: formatList(segments.map((index) => String(index + 1))), count: segments.length }] : [];
  });
  const range = eta?.lowSeconds != null && eta.highSeconds !== null ? t("範圍 {low}–{high}", { low: formatEta(eta.lowSeconds), high: formatEta(eta.highSeconds, { approx: false }) }) : undefined;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2" role="status">
        <Badge tone="entity">
          <SplitSquareHorizontal aria-hidden />
          {t("{segmentsCount} 段", { segmentsCount: plan.segments.length })}
        </Badge>
        <Badge tone="neutral">
          <Scissors aria-hidden />
          {t("切鏡處接縫 {cut_joins}", { cut_joins: plan.cut_joins })}
        </Badge>
        <Badge tone={plan.mid_shot_joins > 0 ? "warning" : "success"}>
          <T source={"{value}鏡頭中間接縫 {mid_shot_joins}"} values={{ value: plan.mid_shot_joins > 0 ? <TriangleAlert aria-hidden /> : <CircleCheck aria-hidden />, mid_shot_joins: plan.mid_shot_joins }} />
        </Badge>
        <Badge tone="neutral">
          <Film aria-hidden />
          {t("生成 {generated_frames} 影格", { generated_frames: plan.generated_frames })}
        </Badge>
        <Badge tone={eta ? "info" : "neutral"} title={range}>
          {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Clock aria-hidden />}
          {eta ? t("預估 {estimateSeconds}", { estimateSeconds: formatEta(eta.totalSeconds) }) : pending ? t("估算中…") : t("尚無預估")}
        </Badge>
      </div>
      <p className="text-caption text-fg-tertiary">
        {eta && (each != null && each !== "") ? (
          t("{plan}；每段{each}。", { plan: planEtaText(eta), each })
        ) : pending && missing === null ? (
          t("估算中…")
        ) : (
          <span title={missingEtaDetail(missing ?? "none")}>{t("{etaUnavailable}。", { etaUnavailable: missingEtaText(missing ?? "none") })}</span>
        )}
        {t("同一張卡依序執行。")}
        {plan.mid_shot_joins > 0 ? t(" 鏡頭中間的接縫是同一個鏡頭被切開、前後段各自生成，頭髮、服裝細節或光線可能跳動；已交叉溶接。") : null}
      </p>
      {riskLines.map(({ risk, segments, count }) => (
        <p key={risk} className={risk === "oom" ? "flex items-start gap-1.5 text-caption text-danger" : "flex items-start gap-1.5 text-caption text-warning"}>
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("{label}：{count} 段（第 {segments} 段）。{detail}", { label: ETA_RISK_LABEL[risk], count, segments, detail: ETA_RISK_DETAIL[risk] })}</span>
        </p>
      ))}
    </div>
  );
}
