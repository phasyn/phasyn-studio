// A running render's whole time left, in its detail header: 「剩餘約 2:35・預計 14:32 完成」 when the cost profiles give
// one (converging on the finished steps), otherwise 「剩餘時間：尚無預估（還沒有成本紀錄）」 with the reason. It never
// shows a partial figure: the DiT card's own stage estimate covers denoising only and stays on that card.
import type { RunRemaining } from "../../model/eta";
import { completionText, formatEtaClock, missingEtaDetail, missingEtaReason } from "../../model/eta";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function RunRemainingNote({ remaining, now, pending }: { remaining: RunRemaining; now: number | null; pending: boolean }) {
  if (remaining.seconds !== null && now !== null) {
    return (
      <span className="text-caption text-fg-secondary" title={t("依本機成本紀錄；已完成的步驟用實際時間，進行中的步驟＝預估減去已經過的時間")}>
        <T source={"剩餘約 <0>{left}</0>・{completion}"} values={{ left: formatEtaClock(remaining.seconds), completion: completionText(now + remaining.seconds * 1000) }} slots={[<span className="machine" />]} />
      </span>
    );
  }
  if (pending) return <span className="text-caption text-fg-tertiary">{t("估算中…")}</span>;
  const missing = remaining.missing ?? "none";
  return (
    <span className="text-caption text-fg-tertiary" title={missingEtaDetail(missing)}>
      {t("剩餘時間：尚無預估（{reason}）", { reason: missingEtaReason(missing) })}
    </span>
  );
}
