// Uploads to the project's reference library (they only join the library, no shot): the project panel holds one, so
// switching between its tabs does not stop an upload in progress; the asset library holds its own, and 換參考檔案
// (BatchReplaceDialog) one for each opening.
// A finished upload is appended to the library as the project has it at that moment (addLibraryItems), never by
// writing back the list the upload saw: two uploads that finish close together, in this queue or in another one,
// would otherwise each write a list without the other's file, and the later write would drop the earlier file.
import { useReferenceUploads } from "../../references/useReferenceUploads";
import { useStudio } from "../../studioContext";

const NO_REFERENCES: never[] = [];

export function useLibraryUploads() {
  const { project, dispatch } = useStudio();
  const library = project.library ?? [];
  return useReferenceUploads({
    projectId: project.project_id,
    shotId: null,
    library,
    references: NO_REFERENCES,
    // `next` is the library the upload saw plus its new file (and the files this queue added since this render).
    // Only those additions are sent: an item that was in the library at this render and has been removed or edited
    // since must not come back in its old form.
    onLibraryChange: (next) => {
      const known = new Set(library.map((item) => item.item_id));
      const added = next.filter((item) => !known.has(item.item_id));
      if (added.length > 0) dispatch({ type: "addLibraryItems", items: added });
    },
    onReferencesChange: () => undefined,
  });
}

export type LibraryUploads = ReturnType<typeof useLibraryUploads>;
