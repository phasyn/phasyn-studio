import { useQuery } from "@tanstack/react-query";
import { contractJson } from "./http";
import { qk } from "./keys";

export function useRecipeComparison(runId: string, against: string) {
  return useQuery({
    queryKey: [...qk.run(runId), "recipe-comparison", against],
    enabled: Boolean(against),
    queryFn: ({ signal }) => contractJson("RecipeComparison", `/api/runs/${encodeURIComponent(runId)}/recipe/compare`, { query: { against }, signal }),
    staleTime: 5_000,
  });
}
