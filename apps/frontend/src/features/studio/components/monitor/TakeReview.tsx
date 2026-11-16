// A take's reviews in the take strip (scorer results written by agents, model/takeReviews.ts). On the card's frame, at
// the bottom left: a small chip with the residue light (red = confirmed residue, amber = needs a look, green = checked
// clean, grey = not checked) and the adherence score (red below 60 %, amber below 80 %). Hovering the card lists the
// failed prompt items in its tooltip; clicking the chip (or R on the focused card) opens the detail popover: every
// statement with ✓／✗／? (failed first, the ones kept out of the score last) and the residue frame ranges with who.
// The chip is presentational like the card's B control (an option holds no nested control); the card's label reads
// the same summary. Motion: the chip fades in and swaps when its numbers change; the popover pops in from the chip.
import { useId } from "react";
import type { StudioTakeReview, StudioTakeReviewStatement } from "@/api/generated/contracts";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { joinInline } from "@/i18n/format";
import { formatTimestamp } from "@/lib/format";
import { orderedStatements, scoreTone, type ResidueState, type ScoreTone, type TakeReviewSummary } from "../../model/takeReviews";
import { Popover } from "../generation/Popover";
import { kindLabel, percent, residueLabel, roleLabel, verdictLabel } from "./reviewWords";

/** Above this share of unclear answers the score is flagged as unreliable. */
const UNRELIABLE_UNCLEAR = 0.3;

const RESIDUE_DOT: Record<ResidueState, string> = {
  confirmed: "bg-danger",
  suspect: "bg-warning",
  clean: "bg-success",
  unchecked: "bg-fg-disabled",
};
const SCORE_TEXT: Record<ScoreTone, string> = { low: "text-danger", fair: "text-warning", good: "text-fg" };
const VERDICT_MARK: Record<string, { mark: string; tone: string }> = {
  yes: { mark: "✓", tone: "text-success" },
  no: { mark: "✗", tone: "text-danger" },
  unclear: { mark: "?", tone: "text-warning" },
  "n/a": { mark: "–", tone: "text-fg-tertiary" },
};

/** The chip on the card's frame; a click opens the detail (the card itself is not selected). */
export function ReviewChip({ summary, onOpen }: { summary: TakeReviewSummary; onOpen: (anchor: HTMLElement) => void }) {
  const score = summary.adherence?.score ?? null;
  const fade = useChangeFade<HTMLSpanElement>(`${summary.residue}:${score ?? ""}`);
  return (
    <span
      ref={fade}
      aria-hidden
      data-review-chip=""
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
      className="pressable material-hud absolute bottom-0.5 left-0.5 inline-flex h-4 cursor-pointer items-center gap-1 rounded-full border border-white/15 px-1 text-[10px] leading-none font-semibold animate-fade-in hover:border-white/35"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full transition-colors", RESIDUE_DOT[summary.residue])} />
      {score !== null ? <span className={cn("machine", SCORE_TEXT[scoreTone(score)])}>{percent(score)}</span> : null}
    </span>
  );
}

function StatementRow({ statement }: { statement: StudioTakeReviewStatement }) {
  const verdict = VERDICT_MARK[statement.verdict] ?? { mark: "?", tone: "text-fg-tertiary" };
  const unscored = statement.scored === false;
  const where = statement.shot === null || statement.shot === undefined ? null : t("鏡頭 {shot}", { shot: statement.shot });
  const facts = [kindLabel(statement.kind), where, unscored ? t("不計分") : null].filter((part): part is string => part !== null);
  return (
    <li className={cn("grid grid-cols-[1rem_1fr] gap-x-1.5 py-1", unscored && "opacity-60")}>
      <span className={cn("text-body leading-5 font-semibold", verdict.tone)} title={verdictLabel(statement.verdict)}>
        {verdict.mark}
        <span className="sr-only">{verdictLabel(statement.verdict)}</span>
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className={cn("text-caption leading-5 break-words", statement.verdict === "no" && !unscored ? "text-fg" : "text-fg-secondary")}>{statement.text}</span>
        <span className="text-[11px] leading-4 text-fg-tertiary">
          {joinInline(facts)}
          {statement.p_yes === null || statement.p_yes === undefined ? null : <span className="machine">{` · p(yes) ${statement.p_yes.toFixed(2)}`}</span>}
        </span>
      </span>
    </li>
  );
}

function ReviewMeta({ review }: { review: StudioTakeReview }) {
  const parts = [review.source, roleLabel(review.role ?? null), review.checked_by ? t("檢查者：{name}", { name: review.checked_by }) : null, review.created_at ? formatTimestamp(review.created_at) : null].filter(
    (part): part is string => part !== null,
  );
  return (
    <p className="text-[11px] leading-4 text-fg-tertiary break-words" title={[review.model, review.version].filter(Boolean).join("\n") || undefined}>
      {joinInline(parts)}
    </p>
  );
}

function AdherenceSection({ review }: { review: StudioTakeReview }) {
  const statements = orderedStatements(review.statements ?? []);
  const score = review.score ?? null;
  const unclear = review.unclear_frac ?? null;
  return (
    <section className="grid gap-1">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-caption font-semibold text-fg">{t("遵從度")}</h3>
        {score !== null ? <span className={cn("machine text-body font-semibold", SCORE_TEXT[scoreTone(score)])}>{percent(score)}</span> : null}
      </header>
      <ReviewMeta review={review} />
      {unclear !== null && unclear > UNRELIABLE_UNCLEAR ? <p className="text-[11px] leading-4 text-warning">{t("{share} 的項目無法判斷，這個分數不可靠", { share: percent(unclear) })}</p> : null}
      {statements.length > 0 ? (
        <ul className="divide-y divide-line-subtle">
          {statements.map((statement, index) => (
            <StatementRow key={statement.id ?? index} statement={statement} />
          ))}
        </ul>
      ) : (
        <p className="text-caption text-fg-tertiary">{t("這份審查沒有逐項結果")}</p>
      )}
    </section>
  );
}

function ResidueSection({ review }: { review: StudioTakeReview }) {
  const state: ResidueState = review.residue ?? "unchecked";
  const ranges = review.ranges ?? [];
  return (
    <section className="grid gap-1">
      <header className="flex items-center gap-1.5">
        <span className={cn("size-2 shrink-0 rounded-full", RESIDUE_DOT[state])} />
        <h3 className="text-caption font-semibold text-fg">{residueLabel(state)}</h3>
      </header>
      <ReviewMeta review={review} />
      {ranges.length > 0 ? (
        <ul className="grid gap-0.5">
          {ranges.map((range, index) => (
            <li key={`${range.start_frame}-${range.end_frame}-${index}`} className="text-caption leading-5 text-fg-secondary break-words">
              <span className="machine text-fg">{t("影格 {start}–{end}", { start: range.start_frame, end: range.end_frame })}</span> {range.who}
              {range.note ? <span className="text-fg-tertiary">{` · ${range.note}`}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {review.note ? <p className="text-caption text-fg-tertiary break-words">{review.note}</p> : null}
    </section>
  );
}

export interface ReviewPopoverProps {
  open: boolean;
  anchor: HTMLElement | null;
  /** 「take 3」 */
  title: string;
  summary: TakeReviewSummary | null;
  onClose: (restoreFocus: boolean) => void;
}

/** The detail of a take's reviews: adherence item by item, then residue. */
export function ReviewPopover({ open, anchor, title, summary, onClose }: ReviewPopoverProps) {
  const id = useId();
  const label = t("{title} 的審查", { title });
  return (
    <Popover id={id} open={open && summary !== null} anchor={anchor} label={label} onClose={onClose} className="w-[min(26rem,calc(100vw-1rem))]">
      <div className="grid gap-3 overflow-y-auto p-3" tabIndex={-1} data-autofocus="">
        <h2 className="text-body font-semibold text-fg">{label}</h2>
        {summary?.adherenceAll.map((review) => (
          <AdherenceSection key={`${review.source}:${review.role ?? ""}`} review={review} />
        ))}
        {summary && summary.adherenceAll.length === 0 ? <p className="text-caption text-fg-tertiary">{t("還沒有遵從度審查")}</p> : null}
        {summary?.residueAll.map((review) => (
          <ResidueSection key={review.source} review={review} />
        ))}
        {summary && summary.residueAll.length === 0 ? (
          <p className="inline-flex items-center gap-1.5 text-caption text-fg-tertiary">
            <span className={cn("size-2 shrink-0 rounded-full", RESIDUE_DOT.unchecked)} />
            {residueLabel("unchecked")}
          </p>
        ) : null}
      </div>
    </Popover>
  );
}
