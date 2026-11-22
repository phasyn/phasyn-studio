import { contractJson, isApiError } from "@/api/http";
import type { StudioCreativeBindingRead } from "@/api/generated/contracts";

export const creativeRoot = (id: string) => `/api/studio/projects/${encodeURIComponent(id)}/creative`;
export const shotPath = (project: string, medium: string, shot: string) =>
  `${creativeRoot(project)}/shots/${medium}/${encodeURIComponent(shot)}`;
export function entryRead(project: string, entry: string, revision?: number, signal?: AbortSignal) {
  return contractJson("StudioCreativeEntryRead", `${creativeRoot(project)}/entries/${encodeURIComponent(entry)}`, {
    query: { revision },
    signal,
  });
}
export async function bindingRead(
  path: string,
  revision?: number,
  signal?: AbortSignal,
): Promise<StudioCreativeBindingRead | null> {
  try {
    return await contractJson("StudioCreativeBindingRead", path, { query: { revision }, signal });
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}
