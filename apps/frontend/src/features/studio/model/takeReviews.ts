// What the take strip shows of a take's reviews (written by scorers, see api/studioReviews.ts): one adherence score
// and one residue state per take, and the detail behind them in the order a person reads it (what failed first).
import type { StudioTakeReview, StudioTakeReviewStatement } from "@/api/generated/contracts";

/** Grey: no residue review yet. */
export type ResidueState = "confirmed" | "suspect" | "clean" | "unchecked";
export type ScoreTone = "low" | "fair" | "good";

export interface TakeReviewSummary {
  /** The adherence review the badge shows: against the shot's current prompt when there is one, else the prompt that made the take. */
  adherence: StudioTakeReview | null;
  /** Every adherence review of the take (several sources or roles), the shown one first. */
  adherenceAll: StudioTakeReview[];
  residue: ResidueState;
  /** Every residue review of the take, the worst first. */
  residueAll: StudioTakeReview[];
}

/** A take of a project that has reviews, without any of its own: the grey residue light, no score. */
export const UNREVIEWED: TakeReviewSummary = { adherence: null, adherenceAll: [], residue: "unchecked", residueAll: [] };

/** Below this share of yes the score is red, below FAIR amber. */
export const LOW_SCORE = 0.6;
export const FAIR_SCORE = 0.8;

const RESIDUE_RANK: Record<string, number> = { confirmed: 0, suspect: 1, clean: 2 };
const ROLE_RANK: Record<string, number> = { shot: 0, generated: 1 };
const VERDICT_RANK: Record<string, number> = { no: 0, unclear: 1, yes: 2, "n/a": 3 };

const newestFirst = (a: StudioTakeReview, b: StudioTakeReview) => (b.created_at ?? "").localeCompare(a.created_at ?? "");

export function scoreTone(score: number): ScoreTone {
  if (score < LOW_SCORE) return "low";
  return score < FAIR_SCORE ? "fair" : "good";
}

/** The reviews of each take, summarized; takes without reviews are absent. */
export function summarizeReviews(reviews: readonly StudioTakeReview[]): Map<string, TakeReviewSummary> {
  const byTake = new Map<string, StudioTakeReview[]>();
  for (const review of reviews) {
    const list = byTake.get(review.take_id);
    if (list) list.push(review);
    else byTake.set(review.take_id, [review]);
  }
  const out = new Map<string, TakeReviewSummary>();
  for (const [takeId, list] of byTake) {
    const adherenceAll = list
      .filter((review) => review.kind === "adherence")
      .sort((a, b) => (ROLE_RANK[a.role ?? ""] ?? 2) - (ROLE_RANK[b.role ?? ""] ?? 2) || newestFirst(a, b));
    const residueAll = list
      .filter((review) => review.kind === "residue")
      .sort((a, b) => (RESIDUE_RANK[a.residue ?? ""] ?? 3) - (RESIDUE_RANK[b.residue ?? ""] ?? 3) || newestFirst(a, b));
    const worst = residueAll[0]?.residue;
    out.set(takeId, { adherence: adherenceAll[0] ?? null, adherenceAll, residue: worst ?? "unchecked", residueAll });
  }
  return out;
}

/** Statements in reading order: failed, unclear, passed, not applicable; the ones kept out of the score last. */
export function orderedStatements(statements: readonly StudioTakeReviewStatement[]): StudioTakeReviewStatement[] {
  return statements
    .map((statement, index) => ({ statement, index }))
    .sort(
      (a, b) =>
        Number(a.statement.scored === false) - Number(b.statement.scored === false) ||
        (VERDICT_RANK[a.statement.verdict] ?? 4) - (VERDICT_RANK[b.statement.verdict] ?? 4) ||
        a.index - b.index,
    )
    .map((item) => item.statement);
}

/** The scored statements that failed (verdict no). */
export function failedStatements(review: StudioTakeReview | null): StudioTakeReviewStatement[] {
  return (review?.statements ?? []).filter((statement) => statement.verdict === "no" && statement.scored !== false);
}
