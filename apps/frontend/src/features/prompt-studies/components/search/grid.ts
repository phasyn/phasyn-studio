// The round grid's rows: one per candidate, its images by seed. Pure.
import type { ImageRow } from "../../model/rows";
import type { CandidateRef } from "../../types";

export interface GridRow {
  ref: CandidateRef;
  /** 每個 seed 最新的一張（重試過時取最後一次）。 */
  cells: Map<number, ImageRow>;
  reused: boolean;
}

/** 依候選把圖排成格子；同一個 seed 重試過時取最後一次。 */
export function gridRows(rows: readonly ImageRow[], refs: readonly CandidateRef[]): GridRow[] {
  return refs.map((ref) => {
    const cells = new Map<number, ImageRow>();
    for (const row of rows) if (row.render.version_id === ref.version_id && row.render.variant === ref.variant) cells.set(row.render.seed, row);
    return { ref, cells, reused: false };
  });
}
