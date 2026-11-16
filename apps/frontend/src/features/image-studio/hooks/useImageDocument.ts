// Image Studio's project document: the shell's autosave document bound to the shared project API (Video Studio opens
// the same document under the same query key) and the Image Studio edit reducer. Its actions are incremental (add an
// image, patch fields, add a reference), so after a conflict the user may "keep both": the unsaved actions are
// re-applied on the latest version.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { fetchProject, saveProject, studioKeys } from "@/api/studioProjects";
import { createDocReducer, useAutosaveDocument } from "@/features/studio-shell";
import { imageProjectReducer, type ImageProjectAction } from "../model/project";
import type { ImageStudioProject } from "../types";

export const imageDocReducer = createDocReducer<ImageStudioProject, ImageProjectAction>(imageProjectReducer, { trackPending: true });

// The project API is typed with StudioProject; image_shots and the library sources are optional fields of the same document
const save = (doc: ImageStudioProject, options: { keepalive?: boolean }): Promise<ImageStudioProject> => saveProject(doc, options);
const fetchLatest = (doc: ImageStudioProject): Promise<ImageStudioProject> => fetchProject(doc.project_id);

export function useImageDocument(initial: ImageStudioProject) {
  const client = useQueryClient();
  const publish = useCallback(
    (saved: ImageStudioProject) => {
      client.setQueryData(studioKeys.project(saved.project_id), saved);
      void client.invalidateQueries({ queryKey: studioKeys.projects() });
    },
    [client],
  );
  return useAutosaveDocument({ initial, reducer: imageDocReducer, save, fetchLatest, publish });
}
