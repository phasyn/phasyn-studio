// 一張圖（StudioImageShot）的建立、參數檢查、狀態與 take 選取。純函式；畫面與送出前檢查共用同一套規則。
import type { ImageStudioProject, StudioImageShot, StudioImageTake } from "../types";
import { UNASSIGNED_ROUTE } from "@/features/studio";
import { DEFAULTS, LIMITS } from "./constants";
import { batchProblem, seedProblem } from "./seeds";
import { sizeProblem } from "./size";
import { t } from "@/i18n";

export type ImageShotPatch = Partial<Omit<StudioImageShot, "image_shot_id" | "takes" | "active_take_id">>;

/** 本地 ID（契約：英數字開頭，只含 A–Z a–z 0–9 _ . : -）。 */
export function localId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`.slice(0, 40);
}

export function imageShots(project: Pick<ImageStudioProject, "image_shots">): StudioImageShot[] {
  return project.image_shots ?? [];
}

/** 新圖片的預設名稱：「圖片 N」，N 取還沒用過的最小編號。 */
export function nextImageTitle(project: Pick<ImageStudioProject, "image_shots">): string {
  const taken = new Set(imageShots(project).map((shot) => shot.title));
  for (let n = imageShots(project).length + 1; n < LIMITS.shots + 2; n += 1) {
    // 名稱只產生一次再比對（翻譯後比對與回傳仍是同一段文字）
    const title = t("圖片 {n}", { n });
    if (!taken.has(title)) return title;
  }
  return t("圖片");
}

export function newImageShot(project: Pick<ImageStudioProject, "image_shots">, patch: ImageShotPatch & { image_shot_id?: string } = {}): StudioImageShot {
  return {
    image_shot_id: localId("i"),
    title: nextImageTitle(project),
    mode: "t2i",
    prompt: "",
    negative_prompt: "",
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    seed: DEFAULTS.seed,
    seed_mode: DEFAULTS.seedMode,
    batch: DEFAULTS.batch,
    steps: DEFAULTS.steps,
    guidance: DEFAULTS.guidance,
    sigma_schedule: DEFAULTS.sigma,
    flow_shift_mu: null,
    route: UNASSIGNED_ROUTE,
    references: [],
    base_index: null,
    reference_resolution: DEFAULTS.referenceResolution,
    mask_item_id: null,
    mask_invert: false,
    decode: DEFAULTS.decode,
    preview: { ...DEFAULTS.preview },
    takes: [],
    active_take_id: null,
    note: "",
    ...patch,
  };
}

/** Qwen 的 guidance：大於 1 才啟用 CFG（負面提示詞會被編碼，每步 DiT 前向次數加倍）；1 以下不使用負面提示詞。 */
export function cfgEnabled(guidance: number): boolean {
  return guidance > 1;
}

export function forwardsPerStep(guidance: number): 1 | 2 {
  return cfgEnabled(guidance) ? 2 : 1;
}

function rangeProblem(value: number, min: number, max: number, label: string, integer: boolean): string | null {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) return t("{label}須為 {min}–{max} 之間的{value}", { label, min, max, value: integer ? t("整數") : t("數字") });
  return null;
}

/** 生成參數的問題（不含參考圖、運算路由與元件狀態）；空陣列＝參數都合法。 */
export function paramProblems(shot: StudioImageShot): string[] {
  const problems: string[] = [];
  if (!shot.prompt.trim()) problems.push(t("先輸入 prompt"));
  if (shot.prompt.length > LIMITS.prompt) problems.push(t("prompt 最多 {prompt} 個字元", { prompt: LIMITS.prompt }));
  if (shot.negative_prompt.length > LIMITS.prompt) problems.push(t("負面提示詞最多 {prompt} 個字元", { prompt: LIMITS.prompt }));
  const size = sizeProblem(shot.width, shot.height);
  if (size) problems.push(size);
  const checks = [
    rangeProblem(shot.steps, LIMITS.steps.min, LIMITS.steps.max, t("採樣步數"), true),
    rangeProblem(shot.guidance, LIMITS.guidance.min, LIMITS.guidance.max, "Guidance", false),
    shot.flow_shift_mu === null ? null : rangeProblem(shot.flow_shift_mu, LIMITS.flowShift.min, LIMITS.flowShift.max, "Flow shift μ", false),
    rangeProblem(shot.reference_resolution, LIMITS.referenceResolution.min, LIMITS.referenceResolution.max, t("參考圖編碼解析度"), true),
    shot.preview.mode === "off" ? null : rangeProblem(shot.preview.every, LIMITS.previewEvery.min, LIMITS.previewEvery.max, t("預覽間隔"), true),
    seedProblem(shot.seed),
    batchProblem(shot.batch),
  ];
  for (const problem of checks) if (problem) problems.push(problem);
  return problems;
}

/** 使用中的 take：明確選取的那個；沒有選取時用最新的成功 take。 */
export function activeImageTake(shot: StudioImageShot): StudioImageTake | null {
  const chosen = shot.active_take_id ? shot.takes.find((take) => take.take_id === shot.active_take_id) : undefined;
  if (chosen) return chosen;
  for (let index = shot.takes.length - 1; index >= 0; index -= 1) {
    const take = shot.takes[index];
    if (take?.state === "succeeded") return take;
  }
  return null;
}

export function latestImageTake(shot: StudioImageShot): StudioImageTake | null {
  return shot.takes.at(-1) ?? null;
}

export type ImageShotStatus = "empty" | "rendering" | "ready" | "stale" | "cancelled" | "interrupted" | "failed" | "not_sent";

export const IMAGE_STATUS_LABELS: Record<ImageShotStatus, string> = {
  empty: t("未生成"),
  rendering: t("生成中"),
  ready: t("已生成"),
  stale: t("設定已變更"),
  cancelled: t("已取消"),
  interrupted: t("已中斷"),
  failed: t("生成失敗"),
  not_sent: t("沒有送出"),
};

/**
 * 圖片的狀態。stale＝使用中的 take 與目前設定不同（changed 由呼叫端提供：params.ts changedSinceTake，避免循環依賴）。
 * A latest take whose run was cancelled or interrupted says so (as the run states do), not "failed".
 */
export function imageShotStatus(
  shot: StudioImageShot,
  changed: (take: StudioImageTake) => readonly string[] = () => [],
  notSent: string | null = null,
): ImageShotStatus {
  if (shot.takes.some((take) => take.state === "rendering")) return "rendering";
  // The last press of "Generate" sent nothing (run limit, a refused request): say so until a generation starts
  if (notSent !== null) return "not_sent";
  const active = activeImageTake(shot);
  if (active?.state === "succeeded" && active.image) return changed(active).length > 0 ? "stale" : "ready";
  const latest = latestImageTake(shot);
  if (latest && latest.state !== "succeeded") return latest.state === "cancelled" || latest.state === "interrupted" ? latest.state : "failed";
  return "empty";
}

/** 這個專案中還在生成的 run（同一個 run＝同一個批次，只算一次）。 */
export function imageRunsInProgress(project: Pick<ImageStudioProject, "image_shots">): string[] {
  const ids = new Set<string>();
  for (const shot of imageShots(project)) for (const take of shot.takes) if (take.state === "rendering") ids.add(take.run_id);
  return [...ids];
}

/** 刪除圖片後要選取的鄰居：下一張，沒有就上一張。 */
export function neighbourImageShotId(project: Pick<ImageStudioProject, "image_shots">, shotId: string): string | null {
  const shots = imageShots(project);
  const index = shots.findIndex((shot) => shot.image_shot_id === shotId);
  if (index < 0) return null;
  return shots[index + 1]?.image_shot_id ?? shots[index - 1]?.image_shot_id ?? null;
}

/** take 在圖片中的編號（1 起）。 */
export function takeNumber(shot: StudioImageShot, takeId: string): number {
  return shot.takes.findIndex((take) => take.take_id === takeId) + 1;
}
