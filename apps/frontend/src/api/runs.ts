// Run：POST 建立（202）、列表（cursor）、明細、取消。沒有恢復（resume）；重新執行就是新的 run。
// Every run read and write in the app goes through these functions (one queryFn per key, writes never retried).
import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { t } from "@/i18n";
import type { CancelResult, RunRequest, StudioProject, StudioRenderSubmissionRequest, StudioWorkOrigin } from "./generated/contracts";
import { ApiError, apiJson, contractJson } from "./http";
import { isRecord } from "@/lib/json";
import { POLL, qk } from "./keys";
import { fetchProject, studioKeys } from "./studioProjects";
import type { RunPage, RunRequestBody, WireRun } from "./types";

const NO_RUNS: readonly WireRun[] = [];

/** 列表要不要包含已封存的 run（預設不含）。 */
export type ArchivedFilter = "exclude" | "include" | "only";

/**
 * Which runs a list holds: exact project work (StudioWorkOrigin fields), or every run related to one project
 * (its work, its takes and exports, and tool runs whose origin names the project).
 */
export type RunListFilter = Partial<StudioWorkOrigin> | { related_project_id: string };

/**
 * full = complete runs; summary = steps without their settings and outputs (run outputs and request stay).
 * Lists that only show runs or read run outputs use summary; the step detail is read with useRun.
 */
export type RunListView = "full" | "summary";

export function fetchRunPage(limit: number, cursor: string | null, signal?: AbortSignal, archived: ArchivedFilter = "exclude", work?: RunListFilter, view: RunListView = "full"): Promise<RunPage> {
  return contractJson("RunPage", "/api/runs", { query: { limit, cursor, archived, ...work, ...(view === "full" ? {} : { view }) }, signal });
}

/** 分頁列表；有 running 的 run 時才輪詢。 */
export function useRunList(limit = 50, archived: ArchivedFilter = "exclude", work?: RunListFilter, view: RunListView = "full") {
  const base = view === "full" ? qk.runList(limit, archived) : [...qk.runList(limit, archived), view] as const;
  return useInfiniteQuery({
    queryKey: work ? [...base, work] : base,
    queryFn: ({ pageParam, signal }) => fetchRunPage(limit, pageParam, signal, archived, work, view),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: (query) =>
      (query.state.data?.pages.some((page) => page.items.some((run) => run.state === "running")) === true) ? POLL.runList : false,
    staleTime: 1000,
  });
}

/**
 * Runs for pickers: summary rows, newest first, archived included. With a project id only the runs related to that
 * project (the given shot's runs first); null lists the newest runs of every project (pages outside the Studio).
 */
export function useProjectRunList(projectId: string | null, shotId: string | null = null, limit = 25) {
  const list = useRunList(limit, "include", projectId === null ? undefined : { related_project_id: projectId }, "summary");
  const pages = list.data?.pages;
  const runs = useMemo(() => {
    const items = pages?.flatMap((page) => page.items) ?? NO_RUNS;
    if (shotId === null) return items;
    const own = items.filter((run) => runShotId(run) === shotId);
    return own.length === 0 ? items : [...own, ...items.filter((run) => runShotId(run) !== shotId)];
  }, [pages, shotId]);
  return { ...list, runs };
}

/** The shot a run was made for: its project work, or the shot its origin note names (tool runs). */
function runShotId(run: WireRun): string | null {
  if (run.studio_work?.shot_id !== undefined) return run.studio_work.shot_id;
  const note = run.request.origin?.note;
  if (note?.startsWith("{") !== true) return null;
  try {
    const parsed: unknown = JSON.parse(note);
    return isRecord(parsed) && typeof parsed["shot_id"] === "string" ? parsed["shot_id"] : null;
  } catch {
    return null;
  }
}

export function fetchRun(runId: string, signal?: AbortSignal): Promise<WireRun> {
  return contractJson("WireRun", `/api/runs/${encodeURIComponent(runId)}`, { signal });
}

/** Submit once. A lost reply can be resolved from the reservation without posting the body again. */
export interface FrozenRunSubmission { readonly serializedRun: string }

export interface StudioRunSubmission {
  readonly studioProjectId: string;
  readonly submission: Omit<StudioRenderSubmissionRequest, "run"> & { run: RunRequestBody | RunRequest };
}

export async function createRun(body: RunRequestBody | RunRequest | FrozenRunSubmission | StudioRunSubmission): Promise<WireRun> {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (octet) => octet.toString(16).padStart(2, "0")).join("");
  const unreadable = () => new ApiError(0, { code: "INVALID_RESPONSE", remote_outcome_unknown: true }, t("無法讀取建立結果，請從收據查詢任務"), "POST");
  try {
    const path = "studioProjectId" in body ? `/api/studio/projects/${encodeURIComponent(body.studioProjectId)}/render-submissions` : "/api/runs";
    const payload = "serializedRun" in body ? { body: body.serializedRun } : { json: "submission" in body ? body.submission : body };
    const run = await contractJson("WireRun", path, { method: "POST", ...payload, headers: { "Content-Type": "application/json", "Idempotency-Key": key } });
    return run;
  } catch (cause) {
    const error = cause instanceof TypeError ? unreadable() : cause;
    if (!(error instanceof ApiError) || (error.status > 0 && error.status < 500 && !error.remoteOutcomeUnknown)) throw error;
    try {
      const receipt = await apiJson(`/api/run-submissions/${key}`);
      if (isRecord(receipt) && typeof receipt["run_id"] === "string" && typeof receipt["state"] === "string" && receipt["state"] !== "unconfirmed" && receipt["state"] !== "rejected") return await fetchRun(receipt["run_id"]);
    } catch {
      // Both reads are advisory. Keep the submission receipt when the Controller is still unavailable.
    }
    throw new ApiError(error.status, {
      code: error.code, message: `${error.message} (${key})`, remote_outcome_unknown: true,
      details: { ...error.details, idempotency_key: key },
    }, error.message, "POST");
  }
}

/** A failed local refresh after acceptance must not invite a second generation. */
export async function submitStudioRender(
  transact: (change: (saved: StudioProject) => Promise<StudioProject>) => Promise<void>,
  post: (body: StudioRunSubmission) => Promise<WireRun>,
  intent: Omit<StudioRunSubmission["submission"], "expected_revision">,
): Promise<{ run: WireRun; refreshError?: unknown }> {
  const accepted: { run?: WireRun } = {};
  try {
    await transact(async (project) => {
      accepted.run = await post({ studioProjectId: project.project_id, submission: { ...intent, expected_revision: project.revision } });
      return fetchProject(project.project_id);
    });
  } catch (error) {
    if (accepted.run === undefined) throw error;
    return { run: accepted.run, refreshError: error };
  }
  if (accepted.run === undefined) throw new Error(t("無法讀取建立結果，請從收據查詢任務"));
  return { run: accepted.run };
}

export function cancelRun(runId: string): Promise<CancelResult> {
  return contractJson("CancelResult", `/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/** The single query definition for one run: polls while it is running. An empty id disables the query. */
export function runQueryOptions(runId: string) {
  return queryOptions({
    queryKey: qk.run(runId),
    queryFn: ({ signal }) => fetchRun(runId, signal),
    enabled: runId.length > 0,
    refetchInterval: (query) => (query.state.data?.state === "running" ? POLL.activeRun : false),
    staleTime: 1000,
  });
}

export function useRun(runId: string | null) {
  return useQuery(runQueryOptions(runId ?? ""));
}

/** Read-only view of a run already in the cache (never fetches; updates when another reader refreshes it). */
export function useCachedRun(runId: string | null) {
  return useQuery({ ...runQueryOptions(runId ?? ""), enabled: false });
}

/** Page size of the shared run list behind useActiveRuns (one key app-wide, so one poll). */
export const ACTIVE_RUN_LIST_LIMIT = 50;

/** The runs executing now (state running; the Controller may run several at once), newest first, from the shared run list. */
export function useActiveRuns(): { runs: readonly WireRun[]; isPending: boolean } {
  // Summary rows: the chip and the run slots need only state, label and ids (one key app-wide, so one poll)
  const list = useRunList(ACTIVE_RUN_LIST_LIMIT, "exclude", undefined, "summary");
  const items = list.data?.pages[0]?.items;
  useRunHeadWatch(items);
  const runs = useMemo(() => {
    const running = items?.filter((item) => item.state === "running") ?? [];
    return running.length > 0 ? running : NO_RUNS;
  }, [items]);
  return { runs, isPending: list.isPending };
}

/**
 * The shared run list polls only while one of its runs runs, so a run started outside this tab (an agent through MCP or
 * phasynctl, another tab) would wait for some other refresh. While the page is visible the newest run alone is read
 * every POLL.runHead (one summary row, a few KB); when it is one the list does not know, or it runs while the list
 * thinks nothing does, the list is read again at once.
 */
export function runHeadIsNews(head: Pick<WireRun, "run_id" | "state"> | undefined, known: readonly Pick<WireRun, "run_id" | "state">[] | undefined): boolean {
  if (!head || !known) return false;
  const listed = known.find((run) => run.run_id === head.run_id);
  return listed?.state !== head.state;
}

function useRunHeadWatch(known: readonly WireRun[] | undefined): void {
  const client = useQueryClient();
  const head = useQuery({
    queryKey: qk.runHead(),
    queryFn: ({ signal }) => fetchRunPage(1, null, signal, "exclude", undefined, "summary"),
    refetchInterval: POLL.runHead,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  const newest = head.data?.items[0];
  const news = runHeadIsNews(newest, known);
  useEffect(() => {
    if (news) void client.invalidateQueries({ queryKey: qk.runs() });
  }, [news, newest?.run_id, newest?.state, client]);
}

export function useCreateRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createRun,
    onSuccess: (run) => {
      client.setQueryData(qk.run(run.run_id), run);
      void client.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

export function useCancelRun(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => cancelRun(runId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.run(runId) });
      void client.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

// ------------------------------------------------------------------ 封存與永久刪除（x-phasyn-extension）

/** 永久刪除的計畫／結果中的一個檔案（run 產生的輸出與其連結檔，例如 latent 的 blob）。 */
export interface PurgeFile {
  node_id: string;
  file_id: string;
  size_bytes: number | null;
  /** planned＝試算；deleted／missing（本來就不在）＝已處理；failed＝刪不到（Node 離線等）。 */
  status: "planned" | "deleted" | "missing" | "failed";
  code?: string;
  message?: string;
}

/** 會被移除引用的 Studio 專案（take 與匯出）。 */
export interface PurgeProject {
  project_id: string;
  title: string;
  takes_removed: string[];
  exports_removed: string[];
  revision: number | null;
}

export interface PurgeResult {
  run_id: string;
  dry_run: boolean;
  deleted: boolean;
  files: PurgeFile[];
  recordings: { planned: number; deleted: number };
  projects: PurgeProject[];
}

/** 試算：列出永久刪除會影響的檔案、效能紀錄與 Studio 專案，不做任何變更（query key：qk.runPurgePlan）。 */
export function fetchPurgePlan(runId: string, signal?: AbortSignal): Promise<PurgeResult> {
  return contractJson("PurgeResult", `/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE", query: { dry_run: true }, signal });
}

/**
 * 永久刪除：先刪 Node 上的檔案，再刪效能紀錄、移除 Studio 專案中的引用，最後刪 run 紀錄。
 * 任何檔案刪不到時伺服器整筆停下（不刪紀錄、不改專案）並回錯誤；不自動重試。
 */
export function purgeRun(runId: string): Promise<PurgeResult> {
  return contractJson("PurgeResult", `/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE", query: { dry_run: false } });
}

export function setRunArchived(runId: string, archived: boolean): Promise<WireRun> {
  return contractJson("WireRun", `/api/runs/${encodeURIComponent(runId)}/archive`, { method: "POST", json: { archived } });
}

/**
 * Data to re-read after runs are archived or purged: run lists and details; after a purge also recordings and the
 * Studio project list and documents (the server removed their references to the purged runs).
 */
export function invalidateAfterRunChange(client: QueryClient, runIds: readonly string[], purged: boolean): void {
  void client.invalidateQueries({ queryKey: qk.runs() });
  for (const runId of runIds) {
    client.removeQueries({ queryKey: qk.runPurgePlan(runId) });
    if (purged) client.removeQueries({ queryKey: qk.run(runId) });
    else void client.invalidateQueries({ queryKey: qk.run(runId) });
  }
  if (purged) {
    void client.invalidateQueries({ queryKey: qk.recordings() });
    void client.invalidateQueries({ queryKey: studioKeys.projects() });
    void client.invalidateQueries({ queryKey: studioKeys.allProjects() });
  }
}

export function useArchiveRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, archived }: { runId: string; archived: boolean }) => setRunArchived(runId, archived),
    onSuccess: (run) => client.setQueryData(qk.run(run.run_id), run),
    onSettled: (_data, _error, variables) => { invalidateAfterRunChange(client, [variables.runId], false); },
  });
}
