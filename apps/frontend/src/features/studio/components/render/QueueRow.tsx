// One run in the render queue: kind icon, title, when and with what. The running render shows, at the right, its
// estimated share and time left in 14 px monospace (「38%・剩 9:23」, the render activity's estimate, labelled as one
// in the tooltip with the moment it should finish) or, without an estimate, its counted steps; below, its pipeline
// bar. Only that leaf reads the activity, so the queue does not re-render every second.
import { Archive, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCachedRun } from "@/api/runs";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { joinInline } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { useRunProgress } from "../../hooks/useRunProgress";
import { completionText } from "../../model/eta";
import type { QueueItem } from "../../model/renderQueue";
import { routeDisplayLabel, routeName } from "../../model/routes";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { TakeStateMark } from "../marks";
import { RunQueueProgress } from "../RenderProgress";
import { KIND_ICON } from "./kindIcon";
import { estimatedPercent, formatLeft } from "./time";
import { useLookup } from "./useLookup";
import { t } from "@/i18n";

function TitleLine({ item, icon: Icon, active, archived, children }: { item: QueueItem; icon: LucideIcon; active: boolean; archived: boolean; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className={cn("size-3.5 shrink-0", active ? "text-brand-cyan" : "text-fg-tertiary")} />
      <span className={cn("truncate text-data", archived ? "text-fg-tertiary" : "text-fg")} title={item.title}>
        {item.title}
      </span>
      {archived ? (
        <span className="inline-flex shrink-0 items-center text-fg-tertiary" title={t("已封存")}>
          <Archive aria-hidden className="size-3" />
          <span className="sr-only">{t("已封存")}</span>
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center">{children}</span>
    </span>
  );
}

/** The running render's figure and pipeline bar (the render activity when it covers this run). */
function RenderingParts({ item, icon, active, archived, meta }: { item: QueueItem; icon: LucideIcon; active: boolean; archived: boolean; meta: string }) {
  const lookup = useLookup();
  const activity = useRenderActivity();
  const live = activity !== null && activity.run.run_id === item.runId ? activity : null;
  const run = useCachedRun(item.runId).data;
  // The activity's provider polls the DiT events; this only reads the shared cache
  const progress = useRunProgress(run, { poll: false, lookup });
  const seconds = live?.remaining?.seconds ?? null;
  const share = live?.elapsedShare ?? null;
  const estimate = live && seconds !== null && share !== null && live.now !== null ? { seconds, share, at: live.now + seconds * 1000 } : null;
  return (
    <>
      <TitleLine item={item} icon={icon} active={active} archived={archived}>
        {estimate ? (
          <span className="machine text-body text-fg" title={t("預估：已經過時間 ÷（已經過時間＋預估剩餘時間），不是實測的進度；{completion}", { completion: completionText(estimate.at) })}>
            <span className="sr-only">{t("渲染中")}</span>
            {t("{percent}・剩 {left}", { percent: estimatedPercent(estimate.share), left: formatLeft(estimate.seconds) })}
          </span>
        ) : live ? (
          <span className="machine text-body text-fg-secondary" title={t("已完成的 pipeline 步驟（計數；還沒有剩餘時間的預估）")}>
            <span className="sr-only">{t("渲染中")}</span>
            {t("{done}／{total} 步", { done: live.stepsDone, total: live.stepsTotal })}
          </span>
        ) : (
          <TakeStateMark state="rendering" />
        )}
      </TitleLine>
      <span className="truncate pl-5.5 text-caption text-fg-tertiary">{meta}</span>
      {run?.state === "running" ? (
        <span className="block pl-5.5">
          <RunQueueProgress run={run} views={progress.views} noun={item.kind === "variations" ? t("變體") : t("鏡頭")} lookup={lookup} counts={estimate !== null || live === null} />
        </span>
      ) : null}
    </>
  );
}

export function QueueRow({ item, index, active, archived, onSelect }: { item: QueueItem; index: number; active: boolean; archived: boolean; onSelect: (runId: string) => void }) {
  const { engine } = useStudio();
  const Icon = KIND_ICON[item.kind];
  const first = item.takes[0];
  const single = item.takes.length === 1 ? first : undefined;
  const route = first && item.kind !== "batch" ? routeName(routeDisplayLabel(engine.routes, first.take.route)).name : "";
  const meta = joinInline([formatTimestamp(item.createdAt), single && single.take.seed !== null ? `seed ${String(single.take.seed)}` : "", route].filter(Boolean));
  const rendering = item.state === "rendering";
  return (
    <li ref={reveal(index)}>
      <button
        type="button"
        onClick={() => { onSelect(item.runId); }}
        aria-current={active ? "true" : undefined}
        className={cn(LIST_ROW, "grid w-full min-w-0 content-center gap-1 px-3 py-2 text-left", rendering ? "min-h-[5.5rem]" : "min-h-[3.25rem]", active ? LIST_ROW_SELECTED : LIST_ROW_IDLE)}
      >
        {rendering ? (
          <RenderingParts item={item} icon={Icon} active={active} archived={archived} meta={meta} />
        ) : (
          <>
            <TitleLine item={item} icon={Icon} active={active} archived={archived}>
              <TakeStateMark state={item.state} />
            </TitleLine>
            <span className="truncate pl-5.5 text-caption text-fg-tertiary" title={meta}>
              {meta}
            </span>
          </>
        )}
      </button>
    </li>
  );
}
