// One take of the monitor's take strip (an option of its listbox): a frame of it, its render progress or how it ended;
// its number and when it was rendered — or, for a variant take (several takes of the shot in one run, all rendered at
// the same time), its variant badge: what it has that the shot does not (「seed 42・@Video1 night-…blur.mp4」), on a
// wider card; under that 「使用中」 for the active take, the render's stage while it renders, or a few tags of what
// differs from the active take (details in the tooltip). The active take's frame has the cyan outline, the take shown
// in A the selected look, and the B control pins the take as B. Once the project has take reviews, the frame carries
// the review chip (TakeReview.tsx): the residue light and the adherence score, with the failed items in the tooltip.
// The strip owns selection, focus and keys.
import { Film, LoaderCircle, Star } from "lucide-react";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { CircularProgress } from "@/components/common/CircularProgress";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED, HUD_CHIP, THUMB_ZOOM } from "@/components/ui/look";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { isoToMs } from "@/lib/time";
import { t } from "@/i18n";
import { formatRelativeTime, joinInline } from "@/i18n/format";
import { useFilmstrip } from "../../hooks/useMediaPreview";
import { useVariantBadge } from "../../hooks/useVariantBadge";
import { activeTake } from "../../model/project";
import { routeDisplayLabel, routeName } from "../../model/routes";
import { takeDifferences, type TakeDifference } from "../../model/takeDiff";
import { takeNumber } from "../../model/takeDownload";
import type { TakeReviewSummary } from "../../model/takeReviews";
import type { VariantBadge } from "../../model/variants";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { TakeStateMark } from "../marks";
import { takeUrl } from "./media";
import { ditFraction, renderStage } from "./renderStage";
import { reviewWords } from "./reviewWords";
import { ReviewChip } from "./TakeReview";
import { cardWords, isEnded, isPlayable } from "./monitorTakes";
import { useTakeRender } from "./useTakeRender";

/** Tags a card shows; the rest are counted (「+2」) and listed in the tooltip. */
const VISIBLE_TAGS = 2;

export interface TakeCardProps {
  shot: StudioShot;
  take: StudioTake;
  /** Place in the strip (entrance stagger). */
  index: number;
  /** Shown in A: the option's selection. */
  viewed: boolean;
  /** Pinned as B. */
  compared: boolean;
  /** Its run is archived (it waits behind 「其他」 unless it is the active take). */
  archived: boolean;
  /** An A/B comparison is on the picture: the take in A carries an 「A」. */
  comparing: boolean;
  /** The strip's single tab stop. */
  focusable: boolean;
  /** The strip's clock for 「3 分鐘前」; null before its first tick. */
  now: number | null;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The B control: pin this take as B, or unpin it. */
  onCompare: () => void;
  /** Its reviews; null when the project has none (no chip). */
  review: TakeReviewSummary | null;
  /** The review chip was clicked: open the detail next to it. */
  onOpenReview: (anchor: HTMLElement) => void;
}

/** The picture of the card: a frame of the take, its render progress, or the mark of how it ended. */
function CardPicture({ take, active, fraction }: { take: StudioTake; active: boolean; fraction: number | null }) {
  // The same middle frame and width as the shot list's thumbnail, so the active take's frame comes from one capture
  const frame = useFilmstrip(takeUrl(take), 1, 128)[0];
  const box = cn("relative grid h-10 w-18 shrink-0 place-items-center overflow-hidden rounded-md bg-stage", active && "ring-2 ring-brand-cyan ring-offset-1 ring-offset-canvas");
  if (take.state === "rendering") {
    return (
      <GeneratingFrame active progress={fraction} className={box}>
        {fraction !== null ? <CircularProgress value={fraction} label={t("DiT 去噪進度")} size={26} strokeWidth={3} /> : <LoaderCircle aria-hidden className="size-5 text-brand-cyan animate-spin" />}
      </GeneratingFrame>
    );
  }
  if (isEnded(take)) {
    return (
      <span className={box}>
        <TakeStateMark state={take.state} />
      </span>
    );
  }
  return (
    <span className={box}>
      {frame ? <img src={frame} alt="" draggable={false} className={cn("size-full object-cover animate-fade-in", THUMB_ZOOM)} /> : <Film aria-hidden className="size-4 text-fg-disabled" />}
    </span>
  );
}

/** Under the number: 「使用中」, the render's stage, or what differs from the active take. */
function CardNote({ take, active, stage, differences }: { take: StudioTake; active: boolean; stage: string | null; differences: readonly TakeDifference[] }) {
  const fade = useChangeFade<HTMLSpanElement>(active);
  if (take.state === "rendering") return <span className="truncate text-info">{stage ?? t("渲染中")}</span>;
  if (active) {
    return (
      <span ref={fade} className="inline-flex min-w-0 items-center gap-1 text-brand-cyan">
        <Star aria-hidden className="size-3 shrink-0 fill-current" />
        <span className="truncate">{t("使用中")}</span>
      </span>
    );
  }
  const rest = differences.length - VISIBLE_TAGS;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {differences.slice(0, VISIBLE_TAGS).map((item) => (
        <span key={item.key} className="shrink-0 rounded-sm bg-overlay px-1 text-[11px] leading-4 text-fg-secondary">
          {item.label}
        </span>
      ))}
      {rest > 0 ? <span className="machine shrink-0 text-[11px] leading-4 text-fg-tertiary">{`+${rest}`}</span> : null}
    </span>
  );
}

/** A variant take's badge next to its number: brand-tinted when it differs from the shot, quiet when it matches; it fades when that changes. */
function VariantTag({ badge }: { badge: VariantBadge }) {
  const fade = useChangeFade<HTMLSpanElement>(badge.text);
  return (
    <span ref={fade} className={cn("min-w-0 truncate rounded-sm px-1 text-[11px] leading-4", badge.same ? "bg-overlay text-fg-tertiary" : "bg-brand-soft text-fg-secondary")}>
      {badge.text}
    </span>
  );
}

/** The B control: the mouse twin of Alt+click and of the B key (an option's content is presentational, so it is no nested control). */
function CompareControl({ compared, onCompare }: { compared: boolean; onCompare: () => void }) {
  return (
    <span
      aria-hidden
      title={compared ? t("取消 B 比較") : t("放到 B 比較（也可以 Alt＋點按卡片，或聚焦後按 B）")}
      onClick={(event) => {
        event.stopPropagation();
        onCompare();
      }}
      className={cn(
        "pressable absolute top-0.5 right-0.5 grid size-5 cursor-pointer place-items-center rounded-full border text-[11px] leading-none font-semibold",
        compared ? "border-transparent bg-entity text-on-accent" : "material-hud border-white/15 text-fg-secondary opacity-80 hover:text-fg hover:opacity-100",
      )}
    >
      B
    </span>
  );
}

export function TakeCard({ shot, take, index, viewed, compared, archived, comparing, focusable, now, onClick, onKeyDown, onCompare, review, onOpenReview }: TakeCardProps) {
  const { project, engine } = useStudio();
  const activity = useRenderActivity();
  const rendering = take.state === "rendering";
  const live = useTakeRender(rendering ? take : null);
  const reference = activeTake(shot);
  const active = reference?.take_id === take.take_id;
  const fps = project.format.fps.num / project.format.fps.den;
  const differences = useMemo(
    () => (reference && !active ? takeDifferences(take, reference, { routeLabel: (id) => routeName(routeDisplayLabel(engine.routes, id)).name, fps }) : null),
    [take, reference, active, engine.routes, fps],
  );
  const variant = useVariantBadge(shot, take);
  const stage = rendering ? renderStage(take, activity, live, true) : null;
  const created = isoToMs(take.created_at);
  const relative = now === null || created === null ? null : formatRelativeTime(created, now);
  const words = cardWords({ shot, take, active, compared, archived, relative, stage, differences, activeNumber: reference ? takeNumber(shot, reference) : null, variant });
  const playable = isPlayable(take);
  const reviewed = review && playable ? reviewWords(review) : null;
  const shortcuts = [playable ? "Enter B" : null, reviewed ? "R" : null].filter(Boolean).join(" ");
  return (
    <div
      ref={reveal(index)}
      role="option"
      aria-selected={viewed}
      aria-label={reviewed ? joinInline([words.label, reviewed.label]) : words.label}
      aria-keyshortcuts={shortcuts || undefined}
      data-take-card={take.take_id}
      tabIndex={focusable ? 0 : -1}
      title={reviewed ? `${words.tooltip}\n\n${reviewed.lines.join("\n")}` : words.tooltip}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        CHOICE_BASE,
        "group/tile flex h-12 shrink-0 cursor-pointer items-center gap-2 rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
        variant ? "w-64" : "w-46",
        viewed ? CHOICE_SELECTED : CHOICE_IDLE,
      )}
    >
      <span className="relative shrink-0">
        <CardPicture take={take} active={active} fraction={rendering ? ditFraction(take, activity, live) : null} />
        {comparing && viewed ? <span className={cn(HUD_CHIP, "pointer-events-none absolute top-0.5 left-0.5 px-1.5 py-0 text-[11px] leading-4")}>A</span> : null}
        {playable ? <CompareControl compared={compared} onCompare={onCompare} /> : null}
        {review && playable ? <ReviewChip summary={review} onOpen={onOpenReview} /> : null}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5 text-caption leading-4">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="machine shrink-0 font-semibold text-fg">{`#${takeNumber(shot, take)}`}</span>
          {variant ? <VariantTag badge={variant} /> : relative ? <span className="truncate text-fg-tertiary">{relative}</span> : null}
        </span>
        <CardNote take={take} active={active} stage={stage} differences={differences ?? []} />
      </span>
    </div>
  );
}
