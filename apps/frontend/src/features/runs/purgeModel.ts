// 永久刪除 run 的試算／結果整理（純函式）：合併多個 run 的計畫，供確認對話框顯示影響範圍。
import { isApiError } from "@/api/http";
import type { PurgeFile, PurgeResult } from "@/api/runs";
import { isRecord } from "@/lib/json";

export interface ProjectImpact {
  project_id: string;
  title: string;
  takes: number;
  exports: number;
}

export interface PurgeSummary {
  runs: number;
  files: number;
  /** 已知大小的總和（bytes）；沒有任何已知大小時為 null（不顯示成 0）。 */
  knownBytes: number | null;
  unknownSizes: number;
  /** 檔案所在的 Node（顯示用）。 */
  nodes: string[];
  recordings: number;
  projects: ProjectImpact[];
}

function fileKey(file: Pick<PurgeFile, "node_id" | "file_id">): string {
  return `${file.node_id}/${file.file_id}`;
}

/** 合併多個試算結果：同一個檔案只算一次，專案依 project_id 合併。 */
export function summarizePlans(plans: readonly PurgeResult[]): PurgeSummary {
  const files = new Map<string, PurgeFile>();
  const projects = new Map<string, ProjectImpact>();
  let recordings = 0;
  for (const plan of plans) {
    for (const file of plan.files) files.set(fileKey(file), file);
    recordings += plan.recordings.planned;
    for (const project of plan.projects) {
      const current = projects.get(project.project_id) ?? { project_id: project.project_id, title: project.title, takes: 0, exports: 0 };
      current.takes += project.takes_removed.length;
      current.exports += project.exports_removed.length;
      projects.set(project.project_id, current);
    }
  }
  const sizes = [...files.values()].map((file) => file.size_bytes);
  const known = sizes.filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  return {
    runs: plans.length,
    files: files.size,
    knownBytes: known.length > 0 ? known.reduce((sum, size) => sum + size, 0) : null,
    unknownSizes: sizes.length - known.length,
    nodes: [...new Set([...files.values()].map((file) => file.node_id))],
    recordings,
    projects: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-Hant")),
  };
}

/** 刪除失敗時伺服器在 error.details 帶回的計畫（哪些檔案已刪、哪些失敗）；拿不到時為 null。 */
export function planFromError(error: unknown): PurgeResult | null {
  const details = isApiError(error) ? error.details : null;
  if (!isRecord(details) || !Array.isArray(details.files) || typeof details.run_id !== "string") return null;
  return details as unknown as PurgeResult;
}

/** 失敗的檔案（status＝failed）。 */
export function failedFiles(plan: PurgeResult | null): PurgeFile[] {
  return plan ? plan.files.filter((file) => file.status === "failed") : [];
}
