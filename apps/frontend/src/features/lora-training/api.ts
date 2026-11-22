// LoRA 訓練的 API（/api/lora-trainings 與 /api/local-imports）。
//   GET  /api/lora-trainings                     → LoraTrainingList（新到舊）
//   POST /api/lora-trainings                     → LoraTraining（建立後立刻開始）
//   GET  /api/lora-trainings/{id}                → LoraTraining（執行中每 3 秒重讀）
//   POST /api/lora-trainings/{id}/actions        → LoraTraining（開始訓練、取消、繼續、停止並比較、決定）
//   PATCH /api/lora-trainings/{id}/clips         → LoraTraining（檢查資料時移除／恢復片段、改 caption）
//   GET  /api/local-imports[?root=&path=]        → 主控機器上可挑選的資料夾與影片
//   POST /api/local-imports                      → FileRef（複製進主控檔案庫；原檔不動）
// 寫入一律不自動重送；連線中斷＝遠端結果未知，由使用者重新讀取。
import { useQuery } from "@tanstack/react-query";
import type {
  FileRef,
  LocalImportListing,
  LoraTraining,
  LoraTrainingAction,
  LoraTrainingClipEdit,
  LoraTrainingRequest,
  LoraTrainingSummary,
} from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { fetchRun } from "@/api/runs";
import type { WireRun } from "@/api/types";

export const trainingKeys = {
  all: () => ["lora-trainings"] as const,
  list: () => ["lora-trainings", "list"] as const,
  one: (id: string) => ["lora-trainings", "one", id] as const,
  imports: (root: number | null, path: string) => ["local-imports", root, path] as const,
  run: (runId: string) => ["lora-trainings", "run", runId] as const,
};

const BASE = "/api/lora-trainings";
const LIVE = new Set(["running", "stopping"]);
export const TRAINING_POLL_MS = 3000;

export function isLive(status: string | undefined): boolean {
  return status !== undefined && LIVE.has(status);
}

export function useTrainingList() {
  return useQuery({
    queryKey: trainingKeys.list(),
    queryFn: async ({ signal }): Promise<LoraTrainingSummary[]> => (await contractJson("LoraTrainingList", BASE, { signal })).items,
    refetchInterval: (query) => ((query.state.data ?? []).some((item) => isLive(item.status)) ? TRAINING_POLL_MS : 15000),
  });
}

export function useTraining(id: string) {
  return useQuery({
    queryKey: trainingKeys.one(id),
    queryFn: ({ signal }) => contractJson("LoraTraining", `${BASE}/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: (query) => (isLive(query.state.data?.status) ? TRAINING_POLL_MS : false),
  });
}

/** The run a job is working on right now (its live preview and step states). */
export function useActiveRun(runId: string | null) {
  return useQuery({
    queryKey: trainingKeys.run(runId ?? ""),
    queryFn: ({ signal }): Promise<WireRun> => fetchRun(runId ?? "", signal),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2000 : false),
  });
}

export function createTraining(body: LoraTrainingRequest): Promise<LoraTraining> {
  return contractJson("LoraTraining", BASE, { method: "POST", json: body });
}

export function actOnTraining(id: string, body: LoraTrainingAction): Promise<LoraTraining> {
  return contractJson("LoraTraining", `${BASE}/${encodeURIComponent(id)}/actions`, { method: "POST", json: body });
}

export function editClips(id: string, body: LoraTrainingClipEdit): Promise<LoraTraining> {
  return contractJson("LoraTraining", `${BASE}/${encodeURIComponent(id)}/clips`, { method: "PATCH", json: body });
}

export function useLocalImports(root: number | null, path: string, enabled: boolean) {
  return useQuery({
    queryKey: trainingKeys.imports(root, path),
    queryFn: ({ signal }): Promise<LocalImportListing> =>
      contractJson("LocalImportListing", "/api/local-imports", { signal, query: root === null ? {} : { root: String(root), path } }),
    enabled,
    staleTime: 10_000,
  });
}

export function importLocal(root: number, path: string): Promise<FileRef> {
  return contractJson("FileRef", "/api/local-imports", { method: "POST", json: { root, path } });
}
