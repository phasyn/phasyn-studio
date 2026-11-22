// The fix runs of a project (runs started from the 修正 menu, recognised by their origin note), newest first. The
// list is the project's run list (summary rows, polled while a run is running), shared with the other run pickers.
import { useMemo } from "react";
import { useRunList } from "@/api/runs";
import type { WireRun } from "@/api/types";
import { isoToMs } from "@/lib/time";
import { fixTool, parseFixNote, type FixNote, type PipelineTool } from "./tools";

/** Fix runs older than this are not shown or brought back any more. */
const RECENT_MS = 24 * 60 * 60 * 1000;

export interface FixRun {
  run: WireRun;
  note: FixNote;
  tool: PipelineTool;
}

export function useFixRuns(projectId: string): { runs: readonly FixRun[]; refetch: () => void } {
  const list = useRunList(25, "include", { related_project_id: projectId }, "summary");
  const pages = list.data?.pages;
  // The list's own clock: when it was read (a fix run ages out with the next read)
  const now = list.dataUpdatedAt;
  const runs = useMemo(() => {
    return (pages ?? []).flatMap((page) => page.items).flatMap((run): FixRun[] => {
      const note = parseFixNote(run.request.origin?.note);
      const tool = note ? fixTool(note.fix) : null;
      const created = isoToMs(run.created_at);
      if (note?.project_id !== projectId || tool?.kind !== "pipeline" || created === null || now - created > RECENT_MS) return [];
      return [{ run, note, tool }];
    });
  }, [pages, projectId, now]);
  return { runs, refetch: () => void list.refetch() };
}
