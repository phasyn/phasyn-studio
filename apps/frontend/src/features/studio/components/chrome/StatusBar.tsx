// Video Studio's status bar: the one sequence (the timeline every workspace edits and exports: its clips and length)
// and how many of the film's shots are rendered (and need an update or are rendering). While this project's render runs,
// it leads with that render (RenderStatusLine: a progress line along the top edge and what it does now, its time left and
// completion, linking to the render workspace), which then also stands for its shots in the 「渲染中」 count; shots of
// another run of this project executing at the same time are still counted there. The route's state is on
// the toolbar's Render Engine button.
import { Rows3, TriangleAlert } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEditor } from "../../editor/editorContext";
import { placedShotIds } from "../../editor/model";
import { formatDuration, formatTimecode } from "../../model/frames";
import { needsRender, shotStatus } from "../../model/project";
import { useRenderActivity } from "../../renderActivityContext";
import { RenderStatusLine } from "./RenderStatusLine";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function StatusBar() {
  const { project, timeline, fps, totalFrames, problem } = useEditor();
  const activity = useRenderActivity();
  const placed = placedShotIds(timeline);
  const film = project.shots.filter((shot) => placed.has(shot.shot_id));
  const ready = film.filter((shot) => shotStatus(shot, project) === "ready").length;
  const stale = film.filter((shot) => needsRender(shot, project) && shot.takes.length > 0).length;
  const covered = new Set(activity?.items.flatMap((item) => (item.shot ? [item.shot.shot_id] : [])));
  const rendering = project.shots.filter((shot) => !covered.has(shot.shot_id) && shotStatus(shot, project) === "rendering").length;
  return (
    <footer className="relative flex h-7 shrink-0 items-center gap-3 px-3 text-caption text-fg-tertiary">
      <AnimatePresence initial={false}>{activity ? <RenderStatusLine key="render" activity={activity} /> : null}</AnimatePresence>
      {problem ? (
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
            slots={[<span className="machine whitespace-nowrap text-fg-secondary" />]}
          />
        </span>
      )}
      <span aria-hidden className="h-3 w-px shrink-0 bg-line-subtle" />
      <span className="shrink-0">
        <T
          source={"已渲染 {ready}／{enabledCount}{value}{value2}"}
          values={{
            ready,
            enabledCount: film.length,
            value: stale > 0 ? <span className="text-warning">{t("・需更新 {stale}", { stale })}</span> : null,
            value2: rendering > 0 ? <span className="text-info">{t("・渲染中 {rendering}", { rendering })}</span> : null,
          }}
        />
      </span>
    </footer>
  );
}
