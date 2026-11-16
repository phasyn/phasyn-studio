// Cost profiles (GET /api/cost-profiles): per-component compute cost fitted from recordings, read by the duration
// estimator. They change only as new recordings arrive, so the query never polls and stays fresh for a minute.
import { queryOptions } from "@tanstack/react-query";
import type { CostProfileList } from "./generated/contracts";
import { apiJson } from "./http";
import { qk } from "./keys";

export interface CostProfileQuery {
  node_id?: string;
  component_id?: string;
}

/** How long a fetched list counts as fresh (profiles move only when new recordings land). */
export const COST_PROFILES_STALE_MS = 60_000;

export function fetchCostProfiles(query: CostProfileQuery = {}, signal?: AbortSignal): Promise<CostProfileList> {
  return apiJson<CostProfileList>("/api/cost-profiles", { query: { ...query }, signal });
}

export function costProfilesQueryOptions(query: CostProfileQuery = {}) {
  return queryOptions({
    queryKey: qk.costProfiles(query.node_id ?? null, query.component_id ?? null),
    queryFn: ({ signal }) => fetchCostProfiles(query, signal),
    staleTime: COST_PROFILES_STALE_MS,
    refetchOnWindowFocus: false,
  });
}
