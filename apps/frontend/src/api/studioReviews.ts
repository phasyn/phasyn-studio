// Take reviews of a Studio project (x-phasyn-extension): what scorers found in each take (adherence to the prompt,
// residue of replaced characters). They are written by API clients into their own
// document next to the project, so reading them never touches the project's revision; the take strip polls them
// while the page is visible. A project the Controller does not have yet (404) has no reviews.
import { useQuery } from "@tanstack/react-query";
import type { StudioTakeReviews } from "./generated/contracts";
import { ApiError, contractJson } from "./http";

const REVIEWS_POLL_MS = 60_000;

export const reviewKeys = {
  project: (projectId: string) => ["studio", "take-reviews", projectId] as const,
};

async function fetchReviews(projectId: string, signal: AbortSignal): Promise<StudioTakeReviews> {
  try {
    return await contractJson("StudioTakeReviews", `/api/studio/projects/${encodeURIComponent(projectId)}/reviews`, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { project_id: projectId, revision: 0, updated_at: null, reviews: [] };
    throw error;
  }
}

/** The project's take reviews, read again every minute while the page is visible and when the window gets focus. */
export function useTakeReviews(projectId: string) {
  return useQuery({
    queryKey: reviewKeys.project(projectId),
    queryFn: ({ signal }) => fetchReviews(projectId, signal),
    staleTime: 10_000,
    refetchInterval: REVIEWS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
