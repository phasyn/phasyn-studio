import { t } from "@/i18n";
import { wireDefinitions } from "@/lib/contractSchemas";
// Studio project documents (x-phasyn-extension): list, read, save (optimistic revision), delete.
// Video Studio and Image Studio share one project, so when the user switches between them the save sent while the
// previous page unmounted may still be in flight. Saves from this tab are tracked per project (removed on success or
// failure) and fetchProject waits for them, so the page opened next reads the server's newest revision instead of an
// old one that would conflict on the next autosave. Every save is sent once and never retried.
import { useQuery } from "@tanstack/react-query";
import type { StudioProject, StudioTimelineCommandsRequest, StudioTimelineCommandsResult } from "./generated/contracts";
import { apiJson, contractJson, matchesReply } from "./http";
import { studioWrite } from "./studioWrite";

/** A merge can combine otherwise valid versions into an invalid document. Check the project before the PUT. */
export async function readMergedProject(candidate: unknown): Promise<StudioProject> {
  const definitions = await wireDefinitions();
  if (!matchesReply(candidate, "StudioProject", definitions)) throw new Error(t("回應格式不正確"));
  return candidate;
}

export const studioKeys = {
  projects: () => ["studio", "projects"] as const,
  /** Prefix of every project document (invalidates all open projects). */
  allProjects: () => ["studio", "project"] as const,
  project: (projectId: string) => ["studio", "project", projectId] as const,
  runRecordings: (runId: string) => ["studio", "run-recordings", runId] as const,
};

const path = (projectId: string) => `/api/studio/projects/${encodeURIComponent(projectId)}`;

/** pollMs: read the list again every pollMs while the page is visible (and on focus once it is stale). */
export function useStudioProjects(options: { pollMs?: number } = {}) {
  const polling = options.pollMs !== undefined;
  return useQuery({
    queryKey: studioKeys.projects(),
    queryFn: ({ signal }) => contractJson("StudioProjectList", "/api/studio/projects", { signal }),
    staleTime: 5000,
    refetchInterval: options.pollMs ?? false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: polling,
  });
}

/** Saves in flight per project (only for ordering: callers handle results, failures are swallowed here). */
const inflight = new Map<string, Set<Promise<void>>>();

function track<T>(projectId: string, request: Promise<T>): Promise<T> {
  const set = inflight.get(projectId) ?? new Set<Promise<void>>();
  inflight.set(projectId, set);
  const settled: Promise<void> = request.then(
    () => undefined,
    () => undefined,
  );
  set.add(settled);
  void settled.then(() => {
    set.delete(settled);
    if (set.size === 0 && inflight.get(projectId) === set) inflight.delete(projectId);
  });
  return request;
}

/** Resolves when every save this tab sent for the project has finished (either way); immediately when none is pending. */
export async function projectWritesSettled(projectId: string): Promise<void> {
  const set = inflight.get(projectId);
  if (set && set.size > 0) await Promise.all([...set]);
}

/** Reads a project after this tab's in-flight saves of it finish (so it returns the version just saved). */
export async function fetchProject(projectId: string, signal?: AbortSignal): Promise<StudioProject> {
  await projectWritesSettled(projectId);
  return contractJson("StudioProject", path(projectId), { signal });
}

/**
 * Body limit for keepalive requests: browsers cap all pending keepalive requests at 64 KiB in total and fail a request
 * outright beyond that, so leave room for other keepalive requests.
 */
export const KEEPALIVE_BODY_LIMIT = 60 * 1024;

/** The body (UTF-8 bytes) is small enough to send with keepalive. */
export function keepaliveAllowed(body: string): boolean {
  return new TextEncoder().encode(body).length <= KEEPALIVE_BODY_LIMIT;
}

/**
 * The body's revision must equal the server's current one (0 for a new project); resolves to the saved document
 * (revision + 1). keepalive (the save on page exit) is used only within KEEPALIVE_BODY_LIMIT: a larger project uses a
 * normal request, which still completes on in-app navigation, whereas keepalive would be refused and lose the draft.
 */
export function saveProject(project: StudioProject, options: { keepalive?: boolean } = {}): Promise<StudioProject> {
  const body = JSON.stringify(project);
  const keepalive = options.keepalive === true && keepaliveAllowed(body);
  return track(project.project_id, studioWrite("StudioProject", project.project_id, path(project.project_id), { method: "PUT", body, headers: { "Content-Type": "application/json" }, keepalive }));
}

/**
 * Runs timeline commands on the Controller, all or none, on the given revision; resolves to the saved project and what
 * each command did. A refusal is STUDIO_TIMELINE_REJECTED and saves nothing; a revision that is not the server's
 * current one is REVISION_CONFLICT. Sent once and never retried.
 */
export function runTimelineCommands(projectId: string, request: StudioTimelineCommandsRequest): Promise<StudioTimelineCommandsResult> {
  const body = JSON.stringify(request);
  if ((request.dry_run === true)) return contractJson("StudioTimelineCommandsResult", `${path(projectId)}/timeline/commands`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
  return track(projectId, studioWrite("StudioTimelineCommandsResult", projectId, `${path(projectId)}/timeline/commands`, { method: "POST", body, headers: { "Content-Type": "application/json" } }));
}

export function deleteProject(projectId: string, revision: number): Promise<unknown> {
  return apiJson(path(projectId), { method: "DELETE", query: { revision } });
}

/**
 * Opening a project re-reads it on every mount: the cache may be older than what Image Studio or another tab just
 * saved, and starting from an old version conflicts on the first autosave. After that it never refetches on its own
 * (the document hook owns the state).
 */
export function useProjectQuery(projectId: string | null) {
  return useQuery({
    queryKey: studioKeys.project(projectId ?? ""),
    queryFn: ({ signal }) => fetchProject(projectId ?? "", signal),
    enabled: Boolean(projectId),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
