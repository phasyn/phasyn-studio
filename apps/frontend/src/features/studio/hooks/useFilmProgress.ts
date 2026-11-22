// The project list's 已渲染 column with the same rule as the open project's status bar (filmProgress): each listed
// project's document is read once per revision (the Controller serves it from its cache) and counted here, so the list
// says 「需更新」 exactly where the project does. Until a document arrives the row keeps the Controller's summary.
import { useQueries } from "@tanstack/react-query";
import type { StudioProjectSummary } from "@/api/generated/contracts";
import { fetchProject } from "@/api/studioProjects";
import { filmProgress, type FilmProgress } from "../model/filmProgress";

export function useFilmProgress(items: readonly StudioProjectSummary[]): (item: StudioProjectSummary) => FilmProgress | null {
  return useQueries({
    queries: items.map((item) => ({
      queryKey: ["studio", "film-progress", item.project_id, item.revision] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) => filmProgress(await fetchProject(item.project_id, signal)),
      staleTime: Infinity,
      retry: false,
    })),
    combine: (results) => {
      const byId = new Map<string, FilmProgress>();
      results.forEach((result, index) => {
        const item = items[index];
        if (item && result.data) byId.set(`${item.project_id}@${String(item.revision)}`, result.data);
      });
      return (item: StudioProjectSummary) => byId.get(`${item.project_id}@${String(item.revision)}`) ?? null;
    },
  });
}
