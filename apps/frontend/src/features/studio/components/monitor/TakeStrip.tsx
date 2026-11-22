// The take strip under the monitor's transport: every take of the selected shot as a card, in take order (numbers
// read left to right, a new take appears at the right end next to 設為使用中 and no card ever moves), the takes that
// ended without a video (and those of archived runs) behind one 「其他 n」 control, and 設為使用中 at the end — with
// 「套用這個 take 的設定」 before it once the shot has variant takes (it copies the seed, references and route of the
// take in A to the shot and makes it the active one). A single-select listbox whose
// selection is the take shown in A and follows the focus, so ← → browse the takes in the monitor; Home / End go to
// the ends, Enter makes the focused take the active one, B pins it as B (as Alt+click and the card's B control do),
// Esc unpins B and Space plays or pauses. Its keys never reach the timeline (data-arrow-keys, data-delete-keys).
// The project's take reviews (scorer results, read every minute) put a chip on each finished take's frame; the chip or
// R on the focused card opens the review detail, and closing it with Esc gives focus back to the card.
// 修正 (next to 檢查影片) opens the Fix menu for the take in A; the fix runs of the shot follow the takes as small
// progress cards until their result comes back as a new take (fix/).
import { ChevronLeft, CircleCheck, ClipboardCheck } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { useTakeReviews } from "@/api/studioReviews";
import { ActionButton } from "@/components/common/ActionButton";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/time";
import { t } from "@/i18n";
import { formatList, joinInline } from "@/i18n/format";
import { useEditor } from "../../editor/editorContext";
import { useShotActions } from "../../hooks/useShotActions";
import { findRoute } from "../../model/routes";
import { takeNumber } from "../../model/takeDownload";
import { summarizeReviews, UNREVIEWED } from "../../model/takeReviews";
import { hasVariantTakes } from "../../model/variants";
import { FixButton, FixRunCards, FixRunWatcher } from "../../fix";
import { TakeCard } from "./TakeCard";
import { TakeSignalReview } from "./TakeSignalReview";
import { ReviewPopover } from "./TakeReview";
import { activateBlockedReason, applyBlockedReason, isEnded, isPlayable, TAKE_END_LABELS, takeGroups } from "./monitorTakes";

/** Scrolls the strip (smoothly, only as far as needed) so the card is in view with a small margin. */
function revealCard(list: HTMLElement, card: HTMLElement): void {
  const margin = 8;
  const left = card.offsetLeft;
  const right = left + card.offsetWidth;
  if (left - margin < list.scrollLeft) list.scrollTo({ left: Math.max(0, left - margin), behavior: "smooth" });
  else if (right + margin > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right + margin - list.clientWidth, behavior: "smooth" });
}

function cardOf(list: HTMLElement | null, takeId: string | null | undefined): HTMLElement | null {
  return list && (takeId != null && takeId !== "") ? list.querySelector<HTMLElement>(`[data-take-card="${CSS.escape(takeId)}"]`) : null;
}

/** 「失敗 1・已取消 2・已封存 1」: why the takes behind 「其他」 wait there. */
function othersSummary(takes: readonly StudioTake[]): string {
  const ended = Object.keys(TAKE_END_LABELS).flatMap((state) => {
    const count = takes.filter((take) => take.state === state).length;
    return count > 0 ? [`${TAKE_END_LABELS[state] ?? state} ${String(count)}`] : [];
  });
  const archived = takes.filter((take) => !isEnded(take)).length;
  return joinInline(archived > 0 ? [...ended, `${t("已封存")} ${String(archived)}`] : ended);
}

export interface TakeStripProps {
  shot: StudioShot;
  /** The take shown in A. */
  viewed: StudioTake | null;
  /** The take pinned as B (it stays pinned while A moves). */
  pinnedId: string | null;
  /** An A/B comparison is on the picture now. */
  comparing: boolean;
}

export function TakeStrip({ shot, viewed, pinnedId, comparing }: TakeStripProps) {
  const { project, engine, monitorMode, setMonitorMode, setSourceTakeId, setCompareTakeId, sourceMonitor, transport, archivedRunIds } = useEditor();
  const actions = useShotActions();
  const now = useNow(true, 30_000);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [othersOpen, setOthersOpen] = useState(false);
  /** Read out by the polite status region: what a key or a click just did. */
  const [message, setMessage] = useState("");
  /** The take whose review detail was opened last and what it is placed next to (its chip, or its card for R); kept while it closes. */
  const [reviewTarget, setReviewTarget] = useState<{ takeId: string; anchor: HTMLElement } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewsQuery = useTakeReviews(project.project_id);
  const reviewList = reviewsQuery.data?.reviews;
  const reviews = useMemo(() => (reviewList && reviewList.length > 0 ? summarizeReviews(reviewList) : null), [reviewList]);

  const { usable, others } = takeGroups(shot, archivedRunIds);
  const collapsible = usable.length > 0 && others.length > 0;
  const viewedId = viewed?.take_id ?? null;
  const viewedIsOther = others.some((take) => take.take_id === viewedId);
  const showOthers = others.length > 0 && (!collapsible || othersOpen || viewedIsOther);
  const visible = showOthers ? [...usable, ...others] : usable;
  const tabStop = visible.some((take) => take.take_id === viewedId) ? viewedId : (visible[0]?.take_id ?? null);
  const newestId = shot.takes.at(-1)?.take_id ?? null;

  // The take shown in A stays in view when it changes from anywhere (a key here, the shot list, the Render workspace)
  useEffect(() => {
    const list = listRef.current;
    const card = cardOf(list, viewedId);
    if (list && card) revealCard(list, card);
  }, [viewedId]);
  // A take that just started rendering is brought into view (the strip may be scrolled to older takes)
  const newestRef = useRef(newestId);
  useEffect(() => {
    if (newestRef.current === newestId) return;
    newestRef.current = newestId;
    const list = listRef.current;
    const card = cardOf(list, newestId);
    if (list && card) revealCard(list, card);
  }, [newestId]);

  const view = (take: StudioTake) => {
    setSourceTakeId(take.take_id);
    setMonitorMode("source");
  };
  const pin = (take: StudioTake) => {
    if (!isPlayable(take)) return;
    const unpin = pinnedId === take.take_id;
    setCompareTakeId(unpin ? null : take.take_id);
    setMonitorMode("source");
    setMessage(unpin ? t("已取消 B 比較") : t("take {number} 已放到 B 比較", { number: takeNumber(shot, take) }));
  };
  const use = (take: StudioTake | null) => {
    const reason = activateBlockedReason(shot, take);
    if ((reason ?? "") || !take) {
      setMessage(reason ?? "");
      return;
    }
    actions.selectTake(shot.shot_id, take.take_id);
    setMessage(t("take {number} 已設為使用中", { number: takeNumber(shot, take) }));
  };
  // 套用這個 take 的設定: offered once the shot has variant takes, for the take in A (routes count as known until the engine is read)
  const variants = hasVariantTakes(shot);
  const routeKnown = (routeId: string) => engine.status !== "ready" || findRoute(engine.routes, routeId) !== null;
  const applyReason = variants ? applyBlockedReason(shot, viewed, project.library ?? [], routeKnown) : null;
  const apply = (take: StudioTake | null) => {
    if ((applyReason ?? "") || !take) {
      setMessage(applyReason ?? "");
      return;
    }
    const changes = actions.applyTake(shot.shot_id, take.take_id);
    if (changes) setMessage(t("已把 take {number} 的設定（{changes}）套用到鏡頭，並設為使用中", { number: takeNumber(shot, take), changes: formatList(changes) }));
  };
  const openReview = (take: StudioTake, anchor: HTMLElement) => {
    if (!reviews || !isPlayable(take)) return;
    const again = reviewOpen && reviewTarget?.takeId === take.take_id;
    setReviewTarget({ takeId: take.take_id, anchor });
    setReviewOpen(!again);
  };
  const closeReview = (restoreFocus: boolean) => {
    setReviewOpen(false);
    if (restoreFocus && reviewTarget) cardOf(listRef.current, reviewTarget.takeId)?.focus({ preventScroll: true });
  };
  const reviewTake = reviewTarget ? (shot.takes.find((take) => take.take_id === reviewTarget.takeId) ?? null) : null;

  const go = (index: number) => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!target) return;
    view(target);
    requestAnimationFrame(() => cardOf(listRef.current, target.take_id)?.focus({ preventScroll: true }));
  };

  const onCardKey = (take: StudioTake) => (event: KeyboardEvent<HTMLDivElement>) => {
    // Modified keys (undo, save, the browser's own) are not the strip's
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const index = visible.indexOf(take);
    switch (event.key) {
      case "ArrowLeft":
        go(index - 1);
        break;
      case "ArrowRight":
        go(index + 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(visible.length - 1);
        break;
      case "Enter":
        use(take);
        break;
      case " ":
        if (monitorMode === "source") sourceMonitor.current()?.toggle();
        else transport.toggle();
        break;
      case "b":
      case "B":
        pin(take);
        break;
      case "r":
      case "R":
        if (!reviews || !isPlayable(take)) return;
        openReview(take, event.currentTarget);
        break;
      case "Escape":
        if (pinnedId === null) return;
        setCompareTakeId(null);
        setMessage(t("已取消 B 比較"));
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const toggleOthers = () => {
    if (!showOthers) {
      setOthersOpen(true);
      return;
    }
    setOthersOpen(false);
    // The take shown in A leaves with its group: A goes back to the active take
    if (viewedIsOther) setSourceTakeId(null);
  };

  const card = (take: StudioTake) => (
    <TakeCard
      key={take.take_id}
      shot={shot}
      take={take}
      index={visible.indexOf(take)}
      viewed={take.take_id === viewedId}
      compared={take.take_id === pinnedId}
      archived={archivedRunIds.has(take.run_id)}
      comparing={comparing}
      focusable={take.take_id === tabStop}
      now={now}
      onClick={(event) => { if (event.altKey) { pin(take); } else { view(take); } }}
      onKeyDown={onCardKey(take)}
      onCompare={() => { pin(take); }}
      review={reviews ? (reviews.get(take.take_id) ?? UNREVIEWED) : null}
      onOpenReview={(anchor) => { openReview(take, anchor); }}
    />
  );

  return (
    <div className="relative flex h-16 shrink-0 items-center gap-2 border-t border-line-subtle px-2">
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("{title} 的 take", { title: shot.title })}
        aria-orientation="horizontal"
        data-arrow-keys=""
        data-delete-keys=""
        className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden py-0.5"
      >
        {usable.map(card)}
        {showOthers && collapsible ? (
          <div role="group" aria-label={t("其他 take")} className="flex shrink-0 items-center gap-1.5 border-l border-line-subtle pl-1.5 animate-fade-in">
            {others.map(card)}
          </div>
        ) : null}
        {showOthers && !collapsible ? others.map(card) : null}
      </div>
      <FixRunCards shot={shot} now={now} startIndex={visible.length} />
      <FixRunWatcher />
      {collapsible ? (
        <button
          type="button"
          aria-expanded={showOthers}
          aria-controls={listId}
          title={t("其他 take：{list}", { list: othersSummary(others) })}
          onClick={toggleOthers}
          className={cn(
            "pressable inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-caption whitespace-nowrap",
            showOthers ? "border-line-strong bg-raised text-fg" : "border-line-subtle bg-canvas text-fg-secondary hover:border-line-strong hover:bg-raised/60 hover:text-fg",
          )}
        >
          <ChevronLeft aria-hidden className={cn("size-3.5 transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", showOthers && "rotate-180")} />
          {t("其他 {count}", { count: others.length })}
        </button>
      ) : null}
      {viewed ? <TakeSignalReview key={JSON.stringify([project.project_id, shot.shot_id, viewed.take_id, viewed.asset?.file.sha256])} shot={shot} take={viewed} /> : null}
      <FixButton shot={shot} take={viewed} />
      {variants ? (
        <ActionButton
          size="sm"
          variant="secondary"
          icon={<ClipboardCheck aria-hidden />}
          disabledReason={applyReason}
          title={t("把這個 take 的 seed、參考與路線複製到鏡頭，並設為使用中：鏡頭的設定就和它一致")}
          onClick={() => { apply(viewed); }}
          className="animate-fade-in"
        >
          {t("套用這個 take 的設定")}
        </ActionButton>
      ) : null}
      <ActionButton
        size="sm"
        variant="primary"
        icon={<CircleCheck aria-hidden />}
        disabledReason={activateBlockedReason(shot, viewed)}
        title={t("時間軸與匯出改用這個 take")}
        onClick={() => { use(viewed); }}
      >
        {t("設為使用中")}
      </ActionButton>
      <ReviewPopover
        open={reviewOpen && reviewTake !== null}
        anchor={reviewTarget?.anchor ?? null}
        title={reviewTake ? t("take {number}", { number: takeNumber(shot, reviewTake) }) : ""}
        summary={reviewTake && reviews ? (reviews.get(reviewTake.take_id) ?? UNREVIEWED) : null}
        onClose={closeReview}
      />
      <span role="status" className="sr-only">
        {message}
      </span>
    </div>
  );
}
