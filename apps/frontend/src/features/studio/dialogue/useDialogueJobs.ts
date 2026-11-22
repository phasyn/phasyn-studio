// Follows the project's speech jobs (dialogueJobs) and finishes each one where the owner started it: a finished
// transcription becomes the clip's captions (manual edits kept, import_transcript), a finished line of speech is placed
// on its audio track at the caption's start (only where the track is still empty). Every result is applied once, even
// with several readers mounted, and a job that cannot finish stays as a row that says why. DialogueJobsRunner keeps
// one reader mounted for the whole Studio.
import { useQueries } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { ApiError } from "@/api/http";
import { runQueryOptions } from "@/api/runs";
import { asTypedValue, type WireRun } from "@/api/types";
import { t, tServer } from "@/i18n";
import { errorText } from "@/lib/errors";
import { useEditor, type Editor } from "../editor/editorContext";
import { dialogueJobs, type DialogueJob } from "./dialogueJobs";

export interface JobView {
  job: DialogueJob;
  run: WireRun | undefined;
}

/** Runs whose result is being applied now (module-wide, so two mounted panels never apply one result twice). */
const applying = new Set<string>();
/** One timeline write at a time: results that finish together are applied in turn, each to the then-current document. */
let queue: Promise<void> = Promise.resolve();

function failureText(run: WireRun): string {
  if (run.state === "cancelled") return t("已取消");
  if (run.error?.code === "COMPONENT_NOT_READY") return t("模型還沒載入完成，請稍候再試一次");
  return tServer(run.error?.message) ?? t("執行沒有完成");
}

async function apply(editor: Editor, job: DialogueJob, run: WireRun): Promise<void> {
  const { timeline } = editor;
  if (job.kind === "transcribe") {
    const present = job.clipIds.filter((id) => timeline.clips.some((clip) => clip.clip_id === id));
    if (present.length === 0) throw new Error(t("片段已不在時間軸上；可用「從過去結果選」套用到其他片段"));
    await editor.runTimelineCommands(present.map((clipId) => ({ op: "caption", action: "import_transcript", clip_id: clipId, run_id: run.run_id, output_key: job.outputKey })));
    editor.notify({ tone: "success", title: t("已把「{label}」的台詞加入字幕", { label: job.label }) });
    return;
  }
  if (!timeline.tracks.some((track) => track.track_id === job.trackId)) throw new Error(t("目標音軌已被刪除"));
  const output = asTypedValue(run.outputs[job.outputKey]);
  const file = output && "file" in output ? output.file : null;
  if (!file) throw new Error(t("這次配音沒有產生音訊"));
  await editor.runTimelineCommands([{
    op: "place", run_id: run.run_id, output_key: job.outputKey, expected_source_sha256: file.sha256,
    mode: "overwrite", only_if_empty: true, at: job.at, track_audio: job.trackId, video: false, audio: true,
  }]);
}

export function useDialogueJobs(editor: Editor): JobView[] {
  const projectId = editor.project.project_id;
  const jobs = useSyncExternalStore(dialogueJobs.subscribe, () => dialogueJobs.list(projectId));
  const runs = useQueries({ queries: jobs.map((job) => runQueryOptions(job.runId)) });
  const liveRef = useRef(editor);
  useLayoutEffect(() => {
    liveRef.current = editor;
  });
  useEffect(() => {
    jobs.forEach((job, index) => {
      const query = runs[index];
      const run = query?.data;
      // A run the Controller no longer knows (removed meanwhile) can never finish
      if (job.error === undefined && !run && query?.error instanceof ApiError && query.error.status === 404) {
        dialogueJobs.fail(projectId, job.runId, t("找不到這次執行，可能已被刪除"));
        return;
      }
      if (job.error !== undefined || !run || run.state === "running" || applying.has(job.runId)) return;
      if (run.state !== "succeeded") {
        dialogueJobs.fail(projectId, job.runId, failureText(run));
        return;
      }
      applying.add(job.runId);
      queue = queue.then(async () => {
        try {
          await apply(liveRef.current, job, run);
          dialogueJobs.remove(projectId, [job.runId]);
        } catch (cause) {
          dialogueJobs.fail(projectId, job.runId, errorText(cause));
        } finally {
          applying.delete(job.runId);
        }
      });
    });
  }, [jobs, runs, projectId]);
  return jobs.map((job, index) => ({ job, run: runs[index]?.data }));
}

/**
 * Applies finished speech jobs wherever the owner is in the Studio (mounted once by the EditorProvider, so a result
 * lands even while the captions panel is closed or another workspace is open). The captions panel's rows read the same
 * jobs; a result is still applied once (the module-wide `applying` set and the job's removal).
 */
export function DialogueJobsRunner(): null {
  useDialogueJobs(useEditor());
  return null;
}
