// Video Studio's status bar: the one sequence (the timeline every workspace edits and exports: its clips and length)
// and how many of the film's shots are rendered (and need an update or are rendering). While this project's render runs,
// it leads with that render (RenderStatusLine: a progress line along the top edge and what it does now, its time left and
// completion, linking to the render workspace), which then also stands for its shots in the 「渲染中」 count; shots of
// another run of this project executing at the same time are still counted there. At the right end, 「工作」 opens the
// project's one work list (the Render workspace's left column: renders, fixes, exports, transcription…) with how many
// of them run now (the same count as the list's 「進行中」 tab). The route's state is on the toolbar's Render Engine button.
import { ListTodo, LoaderCircle, Rows3, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { AnimatePresence } from "motion/react";
import { useEditor } from "../../editor/editorContext";
import { formatDuration, formatTimecode } from "../../model/frames";
import { filmProgress } from "../../model/filmProgress";
import { shotStatus } from "../../model/project";
import { useRenderActivity } from "../../renderActivityContext";
import { useProjectWork } from "../../work/useProjectWork";
import { projectHref } from "../../workspaces";
import { RenderStatusLine } from "./RenderStatusLine";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function StatusBar() {
  const { project, timeline, fps, totalFrames, problem } = useEditor();
  const activity = useRenderActivity();
  // The same rule as the project list's 已渲染 column (filmProgress), so both say the same numbers
  const { ready, total, stale } = filmProgress(project, timeline);
  const covered = new Set(activity?.items.flatMap((item) => (item.shot ? [item.shot.shot_id] : [])));
  const rendering = project.shots.filter((shot) => !covered.has(shot.shot_id) && shotStatus(shot, project) === "rendering").length;
  // This project's jobs only (the work list's 「進行中」), not every run the Controller executes
  const { running } = useProjectWork();
  return (
    // On a phone the parts wrap onto a second line instead of running off the right edge
    <footer className="relative flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-0.5 text-caption text-fg-tertiary md:h-7 md:flex-nowrap md:py-0">
      <AnimatePresence initial={false}>{activity ? <RenderStatusLine key="render" activity={activity} /> : null}</AnimatePresence>
      {(problem != null && problem !== "") ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-warning" title={problem}>
          <TriangleAlert aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{t("序列無法建立")}</span>
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Rows3 aria-hidden className="size-3 text-brand-cyan/70" />
          <T
            source={"序列 {clipsCount} 個片段・<0>{totalFrames}</0>・{totalFrames2}"}
            values={{ clipsCount: timeline.clips.length, totalFrames: formatTimecode(totalFrames, fps), totalFrames2: formatDuration(totalFrames, fps) }}
            slots={[<span key="slot-0" className="machine whitespace-nowrap text-fg-secondary" />]}
          />
        </span>
      )}
      <span aria-hidden className="h-3 w-px shrink-0 bg-line-subtle" />
      <span className="shrink-0">
        <T
          source={"已渲染 {ready}／{enabledCount}{value}{value2}"}
          values={{
            ready,
            enabledCount: total,
            value: stale > 0 ? <span className="text-warning">{t("・需更新 {stale}", { stale })}</span> : null,
            value2: rendering > 0 ? <span className="text-info">{t("・渲染中 {rendering}", { rendering })}</span> : null,
          }}
        />
      </span>
      <Link
        to={projectHref("render", project.project_id)}
        title={t("開啟工作清單：這個專案的渲染、修正、匯出與轉錄都在這裡")}
        className={cn(
          "ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 no-underline transition-colors duration-(--duration-fast) hover:bg-raised/60 hover:text-fg",
          running > 0 ? "text-info" : "text-fg-secondary",
        )}
      >
        {running > 0 ? <LoaderCircle aria-hidden className="size-3 animate-spin" /> : <ListTodo aria-hidden className="size-3" />}
        {running > 0 ? t("工作・進行中 {running}", { running }) : t("工作")}
      </Link>
    </footer>
  );
}
