// Video Studio's project document: the shell's autosave document (debounced save, optimistic revision, conflict
// handling, keepalive save on leave) bound to the Studio project API and the Video Studio edit reducer. "Keep both" is
// not offered here: some Video Studio actions (reorder, split, join) are not safe to replay on another version. The
// unsaved actions are still tracked, only to recognise a conflict that is none: when replaying them on the server's
// newest version changes nothing (another tab of the project wrote back the same render results), that version is
// taken as saved.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { StudioProject } from "@/api/generated/contracts";
import { fetchProject, saveProject, studioKeys } from "@/api/studioProjects";
import { createDocReducer, useAutosaveDocument } from "@/features/studio-shell";
import { projectReducer, type ProjectAction } from "../model/project";

export const projectDocReducer = createDocReducer<StudioProject, ProjectAction>(projectReducer, { trackPending: true });

const fetchLatest = (doc: StudioProject) => fetchProject(doc.project_id);

export function useProjectDocument(initial: StudioProject) {
  const client = useQueryClient();
  const publish = useCallback(
    (saved: StudioProject) => {
      client.setQueryData(studioKeys.project(saved.project_id), saved);
      void client.invalidateQueries({ queryKey: studioKeys.projects() });
    },
    [client],
  );
  return useAutosaveDocument({ initial, reducer: projectDocReducer, save: saveProject, fetchLatest, publish });
}
