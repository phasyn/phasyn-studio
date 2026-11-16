// Render workspace: the project's render queue (single shot, variations, batch, export; the running render first) and
// the selected run's detail in tabs (overview, stages, timeline, metrics). Entering it selects the requested run
// (?run=), else the one running now, else the newest. The queue collapses; the detail only scrolls inside its tab.
// Progress and times come only from run step timestamps, recorder data and the cost-profile estimate (labelled);
// missing values say so instead of drawing zero. Look: two floating panels; queue rows rise in, the selected row
// carries the brand marker; the stage matrix, step timeline and metrics are data areas (crisp, no glow).
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { PANEL_RAISED } from "@/components/ui/look";
import { CollapsedRail } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { queueItems, type QueueItem } from "../model/renderQueue";
import { useStudio } from "../studioContext";
import { Queue, QUEUE_WIDTH } from "./render/Queue";
import { RunDetail } from "./render/RunDetail";
import { t } from "@/i18n";

/** Newest first, with the renders in progress ahead of everything else (stable: their own order is kept). */
function runningFirst(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => Number(b.state === "rendering") - Number(a.state === "rendering"));
}

export function RenderWorkspace() {
  const { project, activeRunIds } = useStudio();
  const [params, setParams] = useSearchParams();
  const [queueOpen, setQueueOpen] = usePersistentFlag("studio.render.queue.open", true);
  const items = useMemo(() => runningFirst(queueItems(project.shots, project.exports)), [project.shots, project.exports]);
  const requested = params.get("run");
  // The requested run, else the oldest run the Controller is executing for this project (the one the render activity
  // follows), else one still marked rendering
  const executing = activeRunIds.findLast((runId) => items.some((item) => item.runId === runId));
  const selected =
    items.find((item) => item.runId === requested) ??
    items.find((item) => item.runId === executing) ??
    items.find((item) => item.state === "rendering") ??
    items[0] ??
    null;
  const select = (runId: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("run", runId);
        return next;
      },
      { replace: true },
    );
  return (
    <div className="grid min-h-0 min-w-0 flex-1 gap-1.5 px-1.5 pb-1.5" style={{ gridTemplateColumns: `${queueOpen ? QUEUE_WIDTH : "2.5rem"} minmax(0,1fr)` }}>
      {queueOpen ? (
        <Queue items={items} selected={selected?.runId ?? null} onSelect={select} onCollapse={() => setQueueOpen(false)} />
      ) : (
        <CollapsedRail side="left" label={t("渲染佇列")} onExpand={() => setQueueOpen(true)} />
      )}
      {selected ? (
        // Keyed per run: a new selection starts a fresh detail (it fades in)
        <RunDetail key={`detail:${selected.runId}`} item={selected} />
      ) : (
        <div className={cn(PANEL_RAISED, "grid place-items-center overflow-y-auto")}>
          <EmptyState scene mark title={t("還沒有渲染")} description={t("在「鏡頭」選一個鏡頭，輸入 prompt 後按「渲染鏡頭」。")} />
        </div>
      )}
    </div>
  );
}
