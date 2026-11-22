import { t } from "@/i18n";
// Seed 清單（純函式）：搜尋／保留驗證 seed 與「生成候選」的 seed（批次或明確清單）。-1＝隨機，實際值在送出前抽出並記錄。
export const MAX_SEED = 2_147_483_647;
export const RANDOM_SEED = -1;
export const MAX_RENDER_IMAGES = 8;

export type SeedResult = { ok: true; seeds: number[] } | { ok: false; error: string };

/** 以逗號、空白或全形逗號分隔的非負整數清單。 */
export function parseSeedList(text: string, options: { label: string; min: number; max: number; unique: boolean }): SeedResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: t("{label}：請填入 {min}–{max} 個 seed", { label: options.label, min: options.min, max: options.max }) };
  const pieces = trimmed.split(/[\s,，、]+/).filter(Boolean);
  if (pieces.some((piece) => !/^\d+$/.test(piece))) return { ok: false, error: t("{label}：只能填非負整數，以逗號分隔", { label: options.label }) };
  const seeds = pieces.map(Number);
  if (seeds.some((seed) => !Number.isSafeInteger(seed) || seed > MAX_SEED)) return { ok: false, error: t("{label}：範圍 0–{maxSeed}", { label: options.label, maxSeed: MAX_SEED }) };
  if (seeds.length < options.min || seeds.length > options.max) return { ok: false, error: t("{label}：需要 {min}–{max} 個 seed（目前 {seedsCount} 個）", { label: options.label, min: options.min, max: options.max, seedsCount: seeds.length }) };
  if (options.unique && new Set(seeds).size !== seeds.length) return { ok: false, error: t("{label}：同一組 seed 不可重複", { label: options.label }) };
  return { ok: true, seeds };
}

export type SeedMode = "fixed" | "increment" | "random";

export interface RenderSeedDraft {
  /** batch：起始 seed＋張數＋模式；explicit：明確清單（可重複）。 */
  mode: "batch" | "explicit";
  seed: string;
  count: string;
  seedMode: SeedMode;
  explicit: string;
}

export const INITIAL_RENDER_SEEDS: RenderSeedDraft = { mode: "batch", seed: "-1", count: "1", seedMode: "increment", explicit: "42, 43" };

/**
 * 「生成候選」實際送出的 seed（每個候選都用同一組）：
 * fixed＝同一個 seed 重複 N 張；increment＝起始值起每張 +1（超過上限從 0 繼續）；random＝每張各抽一個。
 * 起始 seed 為 -1 時：fixed／increment 先抽一個起始值；random 本來就每張抽。
 */
export function resolveRenderSeeds(draft: RenderSeedDraft, draw: () => number): SeedResult {
  if (draft.mode === "explicit") return parseSeedList(draft.explicit, { label: t("明確 seed 清單"), min: 1, max: MAX_RENDER_IMAGES, unique: false });
  const count = Number(draft.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RENDER_IMAGES) return { ok: false, error: t("每個候選的張數必須是 1–{maxRenderImages}", { maxRenderImages: MAX_RENDER_IMAGES }) };
  const raw = draft.seed.trim();
  const start = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(start) || start < RANDOM_SEED || start > MAX_SEED) return { ok: false, error: t("起始 seed 必須是 -1（隨機）或 0–{maxSeed}", { maxSeed: MAX_SEED }) };
  if (draft.seedMode === "random") return { ok: true, seeds: Array.from({ length: count }, () => draw()) };
  const first = start === RANDOM_SEED ? draw() : start;
  if (draft.seedMode === "fixed") return { ok: true, seeds: Array.from({ length: count }, () => first) };
  return { ok: true, seeds: Array.from({ length: count }, (_, index) => (first + index) % (MAX_SEED + 1)) };
}

/** 送出前的檢查（不抽 seed）：可以送出時為 null。 */
export function renderSeedProblem(draft: RenderSeedDraft): string | null {
  const result = resolveRenderSeeds(draft, () => 0);
  return result.ok ? null : result.error;
}

/** 瀏覽器亂數（crypto.getRandomValues；非 secure context 也可用）。 */
export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) & MAX_SEED;
}

/** 每個 seed 在清單中第幾次出現（0 起算）：重複 seed 的每一張都是獨立的圖。 */
export function seedOccurrences(seeds: readonly number[]): { seed: number; occurrence: number }[] {
  const counts = new Map<number, number>();
  return seeds.map((seed) => {
    const occurrence = counts.get(seed) ?? 0;
    counts.set(seed, occurrence + 1);
    return { seed, occurrence };
  });
}
