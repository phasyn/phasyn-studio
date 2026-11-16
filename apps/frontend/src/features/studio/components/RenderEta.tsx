// The render-time estimate next to a render action (one shot, variations of a shot, or a batch of shots):
// 「預估 2 分 45 秒（2:35–3:10）・依本機 37 次紀錄」, 「僅供參考」 when part of it is approximate, and why there is none
// otherwise (no cost profile yet, some steps without one, unknown reference media). Memory risks show as well.
import { Clock, LoaderCircle, TriangleAlert } from "lucide-react";
import type { StudioShot } from "@/api/generated/contracts";
import { cn } from "@/lib/cn";
import { useRenderEta } from "../hooks/useRenderEta";
import type { PlanEtaState } from "../hooks/usePlanEta";
import { ETA_RISK_DETAIL, ETA_RISK_LABEL, missingEtaDetail, missingEtaText, planEtaText } from "../model/eta";
import { t } from "@/i18n";

/** The estimate line of a plan (text, why there is none, memory risk). */
export function EtaLine({ state, className }: { state: PlanEtaState; className?: string }) {
  const { pending, eta, risks, missing } = state;
  const text = eta ? planEtaText(eta) : pending || !missing ? t("估算中…") : missingEtaText(missing);
  const detail = !eta && missing ? missingEtaDetail(missing) : undefined;
  return (
    <div className={cn("grid gap-0.5 text-caption", className)}>
      <p className={cn("flex min-w-0 items-start gap-1.5", eta ? "text-fg-secondary" : "text-fg-tertiary")} title={detail}>
        {pending ? <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : <Clock aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      </p>
      {risks.worst ? (
        <p className={cn("flex min-w-0 items-start gap-1.5", risks.worst === "oom" ? "text-danger" : "text-warning")}>
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t("{label}：{detail}", { label: ETA_RISK_LABEL[risks.worst], detail: ETA_RISK_DETAIL[risks.worst] })}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The estimate of rendering `shots` together (in this order, one run). Nothing when there is nothing to render. */
export function RenderEta({ shots, className }: { shots: readonly StudioShot[]; className?: string }) {
  const state = useRenderEta(shots);
  return shots.length > 0 ? <EtaLine state={state} className={className} /> : null;
}
