// Fit levels: how far a strip (tab list, toolbar) collapses to fit its width. Level 0 shows everything; each higher level
// gives up more (labels, icons, one row). Pure rule, measured by useFitLevel; nothing here depends on a language.

/** Room the content needs and the room it has, in CSS pixels (scrollWidth and clientWidth by default). */
export interface FitMeasure {
  required: number;
  available: number;
}

export interface FitState {
  level: number;
  /** needs[l]: the width level l needed when it last overflowed (the hysteresis for coming back to it). */
  needs: readonly number[];
}

export const FIT_START: FitState = { level: 0, needs: [] };

/**
 * One step after measuring at `state.level` (0 … maxLevel):
 * - the content overflows (required > available): record what this level needed and collapse one level;
 * - otherwise, with at least the width the previous level needed when it overflowed: return to it (it is measured again
 *   there and collapses back, with the fresh need, if it no longer fits);
 * - otherwise stay. Returns the same object when nothing changes.
 */
export function nextFitState(state: FitState, measure: FitMeasure, maxLevel: number): FitState {
  const { level, needs } = state;
  if (measure.required > measure.available) {
    if (level >= maxLevel) return state;
    const next = needs.slice(0, level);
    next[level] = measure.required;
    return { level: level + 1, needs: next };
  }
  const need = level > 0 ? needs[level - 1] : undefined;
  if (need !== undefined && measure.available >= need) return { level: level - 1, needs: needs.slice(0, level - 1) };
  return state;
}
