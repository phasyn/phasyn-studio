// 圖片反推的 API 模組（/api/prompt-studies 與 Studio 專案端點；run 的建立與取消用共用的 @/api/runs）。
//   研究文件  GET /api/prompt-studies?archived=include → { items: PromptStudySummary[] }
//            GET/PUT /api/prompt-studies/{id}（revision 樂觀並行，新研究 0；409 REVISION_CONFLICT／STATE_CONFLICT，422 文件不合法）
//            GET /api/prompt-studies/{id}/deletion-preview?mode= → PromptStudyDeletionPlan（試算，不變更）
//            DELETE /api/prompt-studies/{id}?mode=keep_images|all&revision=（一次請求，沒有背景續刪）
//   元件呼叫  GET /api/runs/{id}（waitForRun 輪詢）；建立（不自動重送）與取消（使用者確認後）在 @/api/runs
//   Studio   GET/PUT /api/studio/projects/{id}（套用到 Image Studio：新增圖片鏡頭；素材庫選圖）
// 寫入一律不自動重試；連線中斷＝遠端結果未知，由使用者重新讀取狀態後決定。
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { uploadFile } from "@/api/files";
import type { FileRef, StudioImageShot, StudioProject } from "@/api/generated/contracts";
import { ApiError, apiJson } from "@/api/http";
import { fetchRun } from "@/api/runs";
import { POLL, qk } from "@/api/keys";
import type { WireRun } from "@/api/types";
import { fetchProject, saveProject, studioKeys } from "@/api/studioProjects";
import { isAbortError, sleep } from "@/lib/async";
import { applyBlockReason, withImageShot } from "./model/applyToImage";
import { normalizeDeletionPlan, normalizeStudy, normalizeSummaryList } from "./model/normalize";
import type { DeleteMode, PromptStudy, PromptStudyDeletionPlan, PromptStudySummary } from "./types";
import { t } from "@/i18n";

export const studyKeys = {
  all: () => ["prompt-studies"] as const,
  list: () => ["prompt-studies", "list"] as const,
  study: (studyId: string) => ["prompt-studies", "study", studyId] as const,
  deletePlan: (studyId: string, mode: DeleteMode) => ["prompt-studies", "delete-plan", studyId, mode] as const,
};

const BASE = "/api/prompt-studies";
const studyPath = (studyId: string) => `${BASE}/${encodeURIComponent(studyId)}`;

function invalidResponse(what: string): ApiError {
  return new ApiError(200, { code: "INVALID_RESPONSE", message: t("{what}的內容無法解讀", { what }) }, "INVALID_RESPONSE");
}

// ---------------------------------------------------------------- 研究文件

export async function fetchStudies(signal?: AbortSignal): Promise<PromptStudySummary[]> {
  return normalizeSummaryList(await apiJson(BASE, { query: { archived: "include" }, signal }));
}

export function useStudyList() {
  return useQuery({ queryKey: studyKeys.list(), queryFn: ({ signal }) => fetchStudies(signal), staleTime: 5000 });
}

export async function fetchStudy(studyId: string, signal?: AbortSignal): Promise<PromptStudy> {
  const study = normalizeStudy(await apiJson(studyPath(studyId), { signal }));
  if (!study) throw invalidResponse(t("研究 {studyId}", { studyId }));
  return study;
}

export function useStudyQuery(studyId: string | null) {
  return useQuery({
    queryKey: studyKeys.study(studyId ?? ""),
    queryFn: ({ signal }) => fetchStudy(studyId ?? "", signal),
    enabled: Boolean(studyId),
    staleTime: Infinity,
    // 離開研究就丟掉快取：下次開啟一定讀最新版本（工作區以開啟時的文件為起點）
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** 保存整份文件：本文 revision 必須等於伺服器目前的 revision（新研究 0）；回傳保存後（revision+1）的文件。 */
export async function saveStudy(study: PromptStudy): Promise<PromptStudy> {
  const saved = normalizeStudy(await apiJson(studyPath(study.study_id), { method: "PUT", json: study }));
  if (!saved) throw invalidResponse(t("保存後的研究"));
  return saved;
}

/** 封存／取消封存：讀最新文件後只改 archived（一次 PUT；有執行中任務時主控回 409，不重送）。 */
export async function setStudyArchived(studyId: string, archived: boolean): Promise<PromptStudy> {
  const current = await fetchStudy(studyId);
  if (current.archived === archived) return current;
  return saveStudy({ ...current, archived });
}

/** 刪除前的試算（不做任何變更）。 */
export async function fetchDeletePlan(studyId: string, mode: DeleteMode, signal?: AbortSignal): Promise<PromptStudyDeletionPlan> {
  const plan = normalizeDeletionPlan(await apiJson(`${studyPath(studyId)}/deletion-preview`, { query: { mode }, signal }), studyId, mode);
  if (!plan) throw invalidResponse(t("刪除範圍"));
  return plan;
}

/** 永久刪除（一次請求；任何一步失敗就停止並在錯誤的 details 回報已完成的部分，不自動重試）。 */
export async function deleteStudy(studyId: string, mode: DeleteMode, revision: number): Promise<PromptStudyDeletionPlan> {
  const plan = normalizeDeletionPlan(await apiJson(studyPath(studyId), { method: "DELETE", query: { mode, revision } }), studyId, mode);
  if (!plan) throw invalidResponse(t("刪除結果"));
  return plan;
}

/** 保存後同步快取：研究本身與列表。 */
export function publishStudy(client: QueryClient, study: PromptStudy): void {
  client.setQueryData(studyKeys.study(study.study_id), study);
  void client.invalidateQueries({ queryKey: studyKeys.list() });
}

// ---------------------------------------------------------------- 上傳

export function uploadSourceImage(file: File, signal?: AbortSignal): Promise<FileRef> {
  return uploadFile(file, signal);
}

// ---------------------------------------------------------------- run

/** 讀狀態連續失敗這麼多次就停止等待（run 仍在主控上，之後可以再讀回）。 */
const MAX_POLL_FAILURES = 5;

/**
 * 等 run 結束（輪詢 GET，讀取可以安全重複）；每次讀到都回報（進度、預覽）。
 * 停止或離開頁面時中止等待（AbortError），run 本身不受影響；run 不存在（404）是確定的結果，直接丟出。
 */
export async function waitForRun(runId: string, options: { signal: AbortSignal; onUpdate?: (run: WireRun) => void; intervalMs?: number }): Promise<WireRun> {
  let failures = 0;
  for (;;) {
    try {
      const run = await fetchRun(runId, options.signal);
      failures = 0;
      options.onUpdate?.(run);
      if (run.state !== "running") return run;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError && error.status === 404) throw error;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) throw error;
    }
    await sleep(options.intervalMs ?? POLL.activeRun, options.signal);
  }
}

/** run 建立或結束後，讓其他頁面（執行紀錄、活動）重新讀取。 */
export function invalidateRuns(client: QueryClient, runId: string | null): void {
  void client.invalidateQueries({ queryKey: qk.runs() });
  if (runId != null && runId !== "") void client.invalidateQueries({ queryKey: qk.run(runId) });
}

// ---------------------------------------------------------------- Studio 專案（套用到 Image Studio、素材庫選圖）

export { useStudioProjects } from "@/api/studioProjects";

export function useStudioProjectQuery(projectId: string | null) {
  return useQuery({
    queryKey: studioKeys.project(projectId ?? ""),
    queryFn: ({ signal }) => fetchProject(projectId ?? "", signal),
    enabled: Boolean(projectId),
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * 在 Studio 專案最後新增一個圖片鏡頭：讀最新專案 → 加上鏡頭 → PUT（revision 不符時 409，不自動重送）。
 * Image Studio 若正開著這個專案，它下次保存會收到 409 並要求重新載入（與永久刪除 run 後的行為相同）。
 */
export async function appendImageShot(client: QueryClient, projectId: string, shot: StudioImageShot): Promise<StudioProject> {
  const latest = await fetchProject(projectId);
  const blocked = applyBlockReason(latest, shot);
  if (blocked != null && blocked !== "") throw new ApiError(409, { code: "STATE_CONFLICT", message: t("沒有寫入：{blocked}", { blocked }) }, "STATE_CONFLICT");
  const saved = await saveProject(withImageShot(latest, shot));
  client.setQueryData(studioKeys.project(projectId), saved);
  void client.invalidateQueries({ queryKey: studioKeys.projects() });
  return saved;
}
