// 批次的 seed：送出前一次決定每張圖的實際 seed（記在 take.seed）。-1＝每張隨機；依序 +1；固定相同；每張隨機。
// 純函式；亂數由呼叫端注入（測試可重現）。批次內隨機抽到重複值時重抽，讓同一個批次的圖一定不同 seed。
import type { SeedMode } from "../types";
import { LIMITS, RANDOM_SEED, SEED_MODE_LABELS } from "./constants";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const RANGE = LIMITS.seed.max + 1;

/** crypto 亂數，0–2147483647。 */
export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) & LIMITS.seed.max;
}

export function seedProblem(seed: number): string | null {
  if (!Number.isInteger(seed) || seed < LIMITS.seed.min || seed > LIMITS.seed.max) return t("Seed 須為 {min}–{max} 之間的整數（-1＝每張隨機）", { min: LIMITS.seed.min, max: LIMITS.seed.max });
  return null;
}

export function batchProblem(batch: number): string | null {
  if (!Number.isInteger(batch) || batch < LIMITS.batch.min || batch > LIMITS.batch.max) return t("生成張數須為 {min}–{max}", { min: LIMITS.batch.min, max: LIMITS.batch.max });
  return null;
}

/** 實際使用的 seed 模式：seed -1 時一律每張隨機（模式選單停用）。 */
export function effectiveSeedMode(seed: number, mode: SeedMode): SeedMode {
  return seed === RANDOM_SEED ? "random" : mode;
}

/**
 * 每張圖的 seed（長度＝count）。seed -1 或 random：每張重新抽（批次內不重複）；increment：seed、seed+1…（超過上限繞回 0）；
 * fixed：全部相同。參數不合法時丟出錯誤（呼叫端應先檢查 seedProblem／batchProblem）。
 */
export function resolveSeeds(seed: number, mode: SeedMode, count: number, draw: () => number = randomSeed): number[] {
  const problem = seedProblem(seed) ?? batchProblem(count);
  if (problem) throw new Error(problem);
  const effective = effectiveSeedMode(seed, mode);
  if (effective === "random") {
    const out: number[] = [];
    const used = new Set<number>();
    for (let index = 0; index < count; index += 1) {
      let value = draw() & LIMITS.seed.max;
      for (let attempt = 0; used.has(value) && attempt < 16; attempt += 1) value = draw() & LIMITS.seed.max;
      used.add(value);
      out.push(value);
    }
    return out;
  }
  if (effective === "increment") return Array.from({ length: count }, (_, index) => (seed + index) % RANGE);
  return Array.from({ length: count }, () => seed);
}

/** 一行說明：「seed 42、43、44（依序 +1）」「每張隨機（實際 seed 記在 take）」。 */
export function describeSeeds(seed: number, mode: SeedMode, count: number): string {
  const effective = effectiveSeedMode(seed, mode);
  if (effective === "random") return count > 1 ? t("每張隨機（{count} 張；實際 seed 記在各 take）", { count }) : t("隨機（實際 seed 記在 take）");
  if (count === 1) return `seed ${seed}`;
  const seeds = resolveSeeds(seed, effective, count, () => 0);
  const shown = seeds.length > 4 ? `${formatList(seeds.slice(0, 3))}…${seeds.at(-1) ?? ""}` : formatList(seeds);
  return t("seed {shown}（{effective}）", { shown, effective: SEED_MODE_LABELS[effective] });
}
