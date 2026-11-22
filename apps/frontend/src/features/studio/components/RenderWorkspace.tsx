// Render workspace: the project's 工作 list (every run of the project — shot renders, variations, batches, exports, fixes,
// masks, mix previews, transcription and other tools; the running one first) and the selected item's detail on the
// right. Entering it selects the requested run (?run=), else (once, written to ?run= so the selection does not jump
// when the Controller's full list arrives) the Studio job running now, else the newest Studio job. The list collapses;
// the detail only scrolls inside its tab. A tracked render or export gets the full render detail (overview, stages,
// timeline, metrics, inference recipe); any other run the work detail (overview, timeline, inference recipe).
// Progress and times come only from run step timestamps, recorder data and the cost-profile estimate (labelled);
// missing values say so instead of drawing zero. Look: two floating panels; rows rise in, the selected row carries the
// brand marker; the stage matrix, step timeline and metrics are data areas (crisp, no glow).
import { useEffect, useEffectEvent, useRef, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { PANEL_RAISED } from "@/components/ui/look";
import { CollapsedRail } from "@/features/studio-shell";
import { cn } from "@/lib/cn";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { useStudio } from "../studioContext";
import { WorkDetail } from "../work/WorkDetail";
import { useProjectWork } from "../work/useProjectWork";
import { WORK_LIST_WIDTH, WorkList } from "../work/WorkList";
import { RunDetail } from "./render/RunDetail";
import { t } from "@/i18n";

const queueStyle: CSSProperties & { "--queue-width": string } = { "--queue-width": WORK_LIST_WIDTH };

export function RenderWorkspace() {
  const { activeRunIds } = useStudio();
  const [params, setParams] = useSearchParams();
  const [queueOpen, setQueueOpen] = usePersistentFlag("studio.render.queue.open", true);
  // Every run related to this project (tool runs that name it included), newest first, one page at a time
  const { items, list } = useProjectWork();
  const requested = params.get("run");
  // The requested run, else the oldest run the Controller is executing for this project (the one the render activity
  // follows), else one still marked rendering
  const executing = activeRunIds.findLast((runId) => items.some((item) => item.runId === runId));
  const fallback =
    items.find((item) => item.runId === executing) ??
    items.find((item) => item.studio && item.state === "rendering") ??
    items.find((item) => item.studio) ??
    null;
  const selected = items.find((item) => item.runId === requested) ?? fallback;
  const select = (runId: string) => { setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("run", runId);
        return next;
      },
      { replace: true },
    ); };
  // Without ?run= the first choice is written to the URL once: later rows (the full list) never move the selection
  const pickedRef = useRef(false);
  const pick = useEffectEvent((runId: string) => { select(runId); });
  const fallbackId = requested === null ? (fallback?.runId ?? null) : null;
  useEffect(() => {
    if (pickedRef.current || fallbackId === null) return;
    pickedRef.current = true;
    pick(fallbackId);
  }, [fallbackId]);
  return (
    <div
      className={cn(
        "grid min-h-0 min-w-0 flex-1 gap-1.5 px-1.5 pb-1.5",
        queueOpen
          ? "grid-cols-1 grid-rows-[minmax(22rem,45%)_minmax(24rem,1fr)] md:grid-cols-[var(--queue-width)_minmax(0,1fr)] md:grid-rows-1"
          : "grid-cols-[2.5rem_minmax(0,1fr)]",
      )}
      style={queueStyle}
    >
      {queueOpen ? (
        <WorkList
          items={items}
          selected={selected?.runId ?? null}
          onSelect={select}
          onCollapse={() => { setQueueOpen(false); }}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          loading={list.isPending}
        />
      ) : (
        <CollapsedRail side="left" label={t("工作")} onExpand={() => { setQueueOpen(true); }} />
      )}
      {selected ? (
        // Keyed per run: a new selection starts a fresh detail (it fades in)
        selected.queue ? <RunDetail key={`detail:${selected.runId}`} item={selected.queue} /> : <WorkDetail key={`work:${selected.runId}`} item={selected} />
      ) : (
        <div className={cn(PANEL_RAISED, "grid place-items-center overflow-y-auto")}>
          <EmptyState scene mark title={t("還沒有工作")} description={t("在「鏡頭」選一個鏡頭，輸入 prompt 後按「渲染鏡頭」。")} />
        </div>
      )}
    </div>
  );
}
