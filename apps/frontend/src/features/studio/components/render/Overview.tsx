// The detail's 「概覽」 tab (audit F-04): what a person waits for, in one screen. A running run shows its time left
// in large type with the moment it should finish (the only time left on screen; an estimate, labelled so, with its
// basis in the tooltip, or the reason there is none) above the pipeline bar; an ended run that did not finish shows
// what to do next (RunOutcome); below, one card per item, finished ones playable as soon as their branch ends.
import type { WireRun } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { CARD } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { completionText, missingEtaDetail, missingEtaReason } from "../../model/eta";
import type { BranchView, ProviderLookup } from "../../model/progress";
import type { RenderActivity } from "../../model/renderActivity";
import type { QueueItem } from "../../model/renderQueue";
import { RunQueueProgress } from "../RenderProgress";
import { Outputs } from "./Outputs";
import { RunOutcome } from "./RunOutcome";
import type { RunItem } from "./runView";
import { formatLeft } from "./time";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** 「剩 9:23・預計 07:03 完成」 (an estimate from the cost profiles), 「估算中…」, or why there is no estimate. */
function TimeLeft({ live }: { live: RenderActivity | null }) {
  const seconds = live?.remaining?.seconds ?? null;
  if (live && seconds !== null) {
    if (live.now === null) return <p className="text-body text-fg-tertiary">{t("估算中…")}</p>;
    return (
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-body text-fg-secondary" title={t("依本機成本紀錄；已完成的步驟用實際時間，進行中的步驟＝預估減去已經過的時間")}>
          <T source={"剩 <0>{left}</0>"} values={{ left: formatLeft(seconds) }} slots={[<span key="slot-0" className="machine text-title font-semibold text-fg" />]} />
        </span>
        <span className="text-body text-fg-secondary">{completionText(live.now + seconds * 1000)}</span>
        <Badge title={t("依本機成本紀錄；已完成的步驟用實際時間，進行中的步驟＝預估減去已經過的時間")}>{t("預估")}</Badge>
      </p>
    );
  }
  if (!live || live.estimating) return <p className="text-body text-fg-tertiary">{t("估算中…")}</p>;
  const missing = live.remaining?.missing ?? "none";
  return (
    <p className="text-body text-fg-tertiary" title={missingEtaDetail(missing)}>
      {t("剩餘時間：尚無預估（{reason}）", { reason: missingEtaReason(missing) })}
    </p>
  );
}

function RunHeadline({ run, item, live, views, lookup }: { run: WireRun; item: QueueItem; live: RenderActivity | null; views: readonly BranchView[]; lookup: ProviderLookup }) {
  return (
    <section aria-label={t("進度")} className={cn(CARD, "grid gap-3 px-4 py-3 animate-fade-in")}>
      {/* An export is never estimated (no cost model for it): no time left rather than a reason that does not apply */}
      {item.kind === "export" ? null : <TimeLeft live={live} />}
      <RunQueueProgress run={run} views={views} noun={item.kind === "variations" ? t("變體") : t("鏡頭")} lookup={lookup} />
    </section>
  );
}

export function Overview({ item, run, live, items, views, lookup }: { item: QueueItem; run: WireRun | undefined; live: RenderActivity | null; items: readonly RunItem[]; views: readonly BranchView[]; lookup: ProviderLookup }) {
  const running = run?.state === "running";
  return (
    <div className="grid content-start gap-4">
      {run && running ? <RunHeadline run={run} item={item} live={live} views={views} lookup={lookup} /> : null}
      {run && !running ? <RunOutcome run={run} item={item} items={items} lookup={lookup} /> : null}
      <Outputs item={item} items={items} running={running} />
    </div>
  );
}
