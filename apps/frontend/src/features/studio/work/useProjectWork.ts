// The open project's 工作 items in one place: the Render workspace's list, the status bar's 「工作・進行中 n」 and the Render
// tab's badge read the same rows (the same query key, so one request and one poll), so the three numbers always agree.
import { useMemo } from "react";
import { useProjectRunList } from "@/api/runs";
import { queueItems } from "../model/renderQueue";
import { useStudio } from "../studioContext";
import { activeWorkCount, workItems } from "./workItems";

/** Page size of the project's run list (the work list reads older pages on demand). */
export const PROJECT_WORK_PAGE = 50;

export function useProjectWork() {
  const { project } = useStudio();
  const list = useProjectRunList(project.project_id, null, PROJECT_WORK_PAGE);
  const tracked = useMemo(() => queueItems(project.shots, project.exports), [project.shots, project.exports]);
  const items = useMemo(() => workItems(tracked, list.runs, project.title), [tracked, list.runs, project.title]);
  return { items, list, running: activeWorkCount(items) };
}
