// The running render in Video Studio's status bar: a 2 px line along the bar's top edge (the estimated share of the
// run's time behind us, or the counted share of its pipeline steps; a sweep while there is nothing to count) and the line
// 「鏡頭 2／3・DiT 第 3／8 步・剩餘約 9:23・預計 07:03 完成」, a link to the 工作 list (Render workspace) with this run selected.
// The status bar is the positioned parent of the edge line. Both fade in and, under the bar's AnimatePresence, out
// (inert while leaving); the edge line's fill moves linearly.
import { ChevronRight, LoaderCircle } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { Link, useSearchParams } from "react-router";
import { SHIMMER } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { RenderActivity } from "../../model/renderActivity";
import { useStudio } from "../../studioContext";
import { RunRemainingNote } from "../render/RemainingNote";
import { activityLine, runFigure, runHref } from "./renderActivityView";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** Fades in (base, enter curve) and out (exit) under the status bar's AnimatePresence. */
const FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: motionTransition("exit", "exit") },
  transition: motionTransition("base", "enter"),
};

/** The edge line's fill: its width moves linearly (progress never springs). */
const EDGE_FILL = "absolute inset-y-0 left-0 bg-brand-gradient transition-[width] duration-(--duration-base) ease-linear";

export function RenderStatusLine({ activity }: { activity: RenderActivity }) {
  const { project } = useStudio();
  const [params] = useSearchParams();
  const exiting = !useIsPresent();
  const figure = runFigure(activity);
  const remaining = activity.remaining ? (
    <RunRemainingNote remaining={activity.remaining} now={activity.now} pending={activity.estimating} />
  ) : (
    <span className="text-caption text-fg-tertiary">{t("估算中…")}</span>
  );
  return (
    <>
      <motion.span {...FADE} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-line-subtle">
        {figure ? (
          <span className={EDGE_FILL} style={{ width: `${String(figure.share * 100)}%` }} />
        ) : (
          <span className={cn("absolute inset-0 bg-brand-gradient opacity-50", SHIMMER)} />
        )}
      </motion.span>
      <motion.span {...FADE} inert={exiting} className="flex min-w-0 shrink items-center gap-3">
        <Link
          to={runHref(project.project_id, activity.run.run_id, params.get("shot"))}
          title={t("在工作清單查看")}
          className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 text-fg-secondary no-underline hover:bg-raised/60 hover:text-fg"
        >
          <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin text-info" />
          <span className="min-w-0 truncate">
            <T source={"{activity}・{remaining}"} values={{ activity: activityLine(activity), remaining }} />
          </span>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-fg-tertiary" />
        </Link>
        <span aria-hidden className="h-3 w-px shrink-0 bg-line-subtle" />
      </motion.span>
    </>
  );
}
