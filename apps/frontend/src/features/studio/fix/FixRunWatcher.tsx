// Brings finished fix runs back where the owner started: a video result becomes a new take of the same shot (its parent
// is the take it was made from: 「修正自 take N · 工具」), a control material, or any result of a library video's fix,
// joins the project library. Mounted by the take strip, the timeline clips and the library details; only the first
// mounted watcher of the page works (fixStore), so each run is brought back once. A run already brought back (or dismissed) is remembered in this browser.
import { useEffect, useId, useState } from "react";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { publishedMedia } from "../model/runMedia";
import { takeNumber } from "../model/takeDownload";
import { useStudio } from "../studioContext";
import { inFlight, joinWatchers, markFixDone, setFixError, useFixDone, useFixErrors, useLeadsWatchers } from "./fixStore";
import { fixLabel, sourceFixLabel } from "./tools";
import { useFixRuns, type FixRun } from "./useFixRuns";

/** The published media a library result is made of: the tool's output, else the first video, else the first file. */
function resultMedia(entry: FixRun) {
  const media = publishedMedia(entry.run);
  return media.find((item) => item.port === entry.tool.output) ?? media.find((item) => item.kind === "video") ?? media[0];
}

export function FixRunWatcher() {
  const reactId = useId();
  const [id] = useState(() => Symbol(reactId));
  useEffect(() => joinWatchers(id), [id]);
  return useLeadsWatchers(id) ? <Leader /> : null;
}

function Leader() {
  const { project, adoptMedia, runTimelineCommands, notify } = useStudio();
  const { runs } = useFixRuns(project.project_id);
  const done = useFixDone();
  const errors = useFixErrors();

  useEffect(() => {
    const bring = (entry: FixRun, work: () => Promise<string>) => {
      const runId = entry.run.run_id;
      inFlight.add(runId);
      work()
        .then((title) => {
          markFixDone(runId);
          setFixError(runId, null);
          notify({ tone: "success", title });
        })
        .catch((cause: unknown) => { setFixError(runId, errorText(cause)); })
        .finally(() => { inFlight.delete(runId); });
    };
    for (const entry of runs) {
      const { run, note, tool } = entry;
      if (run.state !== "succeeded" || tool.result === "files" || done.includes(run.run_id) || inFlight.has(run.run_id) || run.run_id in errors) continue;
      if (note.item_id !== undefined) {
        // A fix of a library video: every media result joins the library next to it
        const item = (project.library ?? []).find((entry) => entry.item_id === note.item_id);
        const output = resultMedia(entry);
        if (!output) {
          setFixError(run.run_id, t("這次執行沒有可加入素材庫的影片或圖片。"));
          continue;
        }
        if ((project.library ?? []).some((entry) => entry.file.sha256 === output.file.sha256)) {
          markFixDone(run.run_id);
          continue;
        }
        const label = item ? sourceFixLabel({ kind: "library", item }, tool.name()) : fixLabel(null, tool.name());
        bring(entry, async () => {
          await runTimelineCommands([{ op: "collect_output", name: label, run_id: run.run_id, output_key: output.port, expected_source_sha256: output.file.sha256 }]);
          return t("已加入素材庫：{label}", { label });
        });
        continue;
      }
      const shot = project.shots.find((item) => item.shot_id === note.shot_id);
      if (!shot) {
        markFixDone(run.run_id);
        continue;
      }
      const parent = shot.takes.find((take) => take.take_id === note.take_id && take.state === "succeeded" && take.asset?.complete === true);
      const label = fixLabel(parent ? takeNumber(shot, parent) : null, tool.name());
      if (tool.result === "take") {
        if (shot.takes.some((take) => take.run_id === run.run_id)) {
          markFixDone(run.run_id);
          continue;
        }
        bring(entry, async () => {
          await adoptMedia(shot.shot_id, run.run_id, tool.output, parent?.take_id ?? null);
          return t("「{shot}」多了一個 take：{label}", { shot: shot.title, label });
        });
        continue;
      }
      const output = resultMedia(entry);
      if (!output) {
        setFixError(run.run_id, t("這次執行沒有可加入素材庫的影片或圖片。"));
        continue;
      }
      if ((project.library ?? []).some((item) => item.file.sha256 === output.file.sha256)) {
        markFixDone(run.run_id);
        continue;
      }
      bring(entry, async () => {
        await runTimelineCommands([{ op: "collect_output", name: `${shot.title} · ${label}`, run_id: run.run_id, output_key: output.port, expected_source_sha256: output.file.sha256 }]);
        return t("已加入素材庫：{label}", { label });
      });
    }
  }, [runs, done, errors, project, adoptMedia, runTimelineCommands, notify]);
  return null;
}
