// The running render's popover under the toolbar capsule (420 px): what the run produces, what it does now, its time
// left and completion (estimated from the cost profiles, or why there is none), one row per item (its stage, a thin bar
// of its pipeline steps and its own time), the switch of the sound that tells when it ends (with a preview), and the two
// ways on: 在工作清單查看 (the Render workspace's 工作 list with this run selected) and 取消… (the confirmed cancellation, which the capsule opens). A non-modal dialog kept in the React tree with position: fixed under its capsule, like the action
// menus: focus moves into it when it opens, Escape closes it and gives focus back to the capsule, a click elsewhere or
// focus leaving it closes it. Motion: it springs in from the capsule (snappy) and fades out (Motion presence, inert
// while it leaves); rows rise in one after another and a row's new stage fades in.
import { Ban, Clapperboard, CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Link } from "react-router";
import type { RunStepView } from "@/api/types";
import { CircularProgress } from "@/components/common/CircularProgress";
import { Button } from "@/components/ui/button";
import { SHIMMER } from "@/components/ui/look";
import { placeMenu } from "@/components/ui/menuModel";
import { motionTransition, reveal, useChangeFade } from "@/components/ui/motion";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import type { ProviderLookup } from "../../model/progress";
import type { ActivityItem, ActivityItemState, RenderActivity } from "../../model/renderActivity";
import { RunRemainingNote } from "../render/RemainingNote";
import { useLookup } from "../render/useLookup";
import { activityLine, activitySubject, figureDetail, figureText, itemCompletions, itemView, runFigure } from "./renderActivityView";
import { RenderSoundToggle } from "./RenderSoundToggle";
import { t } from "@/i18n";

const STATE_ICON: Record<ActivityItemState, { icon: LucideIcon; className: string }> = {
  waiting: { icon: CircleDashed, className: "text-fg-tertiary" },
  running: { icon: LoaderCircle, className: "animate-spin text-info" },
  succeeded: { icon: CircleCheck, className: "text-success" },
  failed: { icon: CircleX, className: "text-danger" },
  // As the run states show everywhere (components/common/statusSpec.ts): cancelled is neutral, interrupted a warning
  cancelled: { icon: Ban, className: "text-fg-secondary" },
  interrupted: { icon: TriangleAlert, className: "text-warning" },
};

/** Fill of a pipeline step's segment by its state (finished = the brand gradient, failures in their status colours). */
const SEGMENT: Record<RunStepView["state"], string> = {
  succeeded: "bg-brand-gradient",
  skipped: "bg-line",
  running: "bg-line",
  waiting: "bg-line",
  pending: "bg-line-subtle",
  failed: "bg-danger/80",
  cancelled: "bg-warning/60",
  interrupted: "bg-warning/60",
  unknown: "bg-line-subtle",
};

/** The part of one continuous gradient a segment shows, so the finished segments read as one bar. */
function gradientSlice(index: number, count: number) {
  if (count < 2) return undefined;
  return { backgroundSize: `${String(count * 100)}% 100%`, backgroundPosition: `${String((index / (count - 1)) * 100)}% 0` };
}

/** The running step's fill: the measured share of a DiT with step evidence, otherwise only a sweep (in progress). */
const RUNNING_FILL = "absolute inset-0 bg-brand-gradient transition-[clip-path] duration-(--duration-base) ease-linear";

/**
 * The item's pipeline steps as equal segments (steps, not time). The running DiT fills by its measured steps; another
 * running step, or a DiT without step evidence, only shows that it is in progress.
 */
function StepSegments({ steps, ditStepId, fraction }: { steps: readonly RunStepView[]; ditStepId: string | null; fraction: number | null }) {
  return (
    <span aria-hidden className="flex h-1 w-28 shrink-0 gap-px overflow-hidden rounded-full">
      {steps.map((step, index) => {
        const measured = step.step_id === ditStepId ? fraction : null;
        const slice = gradientSlice(index, steps.length);
        return (
          <span key={step.step_id} className={cn("relative min-w-0 flex-1", SEGMENT[step.state])} style={step.state === "succeeded" ? slice : undefined}>
            {step.state === "running" ? (
              <span
                className={cn(RUNNING_FILL, SHIMMER, measured === null && "opacity-45")}
                style={{ ...slice, clipPath: measured === null ? undefined : `inset(0 ${String((1 - measured) * 100)}% 0 0)` }}
              />
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

interface ItemRowProps {
  activity: RenderActivity;
  item: ActivityItem;
  index: number;
  completion: number | null;
  lookup: ProviderLookup;
}

/** One item: state mark, name and time on the first line, its stage and its steps on the second (52 px). */
function ItemRow({ activity, item, index, completion, lookup }: ItemRowProps) {
  const { label, state, stage, time, steps } = itemView(activity, item, completion, lookup);
  const fade = useChangeFade<HTMLSpanElement>(stage);
  const mark = STATE_ICON[state];
  const running = state === "running";
  return (
    <li
      ref={reveal(index)}
      className={cn("grid h-13 grid-cols-[1rem_minmax(0,1fr)_auto] content-center items-center gap-x-2.5 gap-y-0.5 rounded-lg px-2.5", running && "bg-white/4")}
    >
      <mark.icon aria-hidden className={cn("size-3.5", mark.className)} />
      <span className="truncate text-data text-fg" title={label}>
        {label}
      </span>
      <span
        className={cn("machine justify-self-end text-caption whitespace-nowrap", running ? "text-fg" : "text-fg-tertiary")}
        title={(time?.title ?? "") || undefined}
      >
        {time?.text ?? ""}
      </span>
      <span ref={fade} className="col-start-2 truncate text-caption text-fg-tertiary">
        {stage}
      </span>
      <StepSegments steps={steps} ditStepId={item.dit?.stepId ?? null} fraction={item.fraction} />
    </li>
  );
}

export interface RenderPopoverProps {
  id: string;
  activity: RenderActivity;
  anchor: HTMLElement;
  /** The render workspace with this run selected. */
  href: string;
  /** restoreFocus: give focus back to the capsule (Escape, the link); not when the user went elsewhere. */
  onClose: (restoreFocus: boolean) => void;
  onCancel: () => void;
}

export function RenderPopover({ id, activity, anchor, href, onClose, onCancel }: RenderPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const exiting = !useIsPresent();
  const lookup = useLookup();
  const figure = runFigure(activity);
  const completions = itemCompletions(activity);

  // Under the capsule (right-aligned when it would leave the window); placed again after every render (rows can change)
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const box = anchor.getBoundingClientRect();
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const position = placeMenu(box, size, { width: window.innerWidth, height: window.innerHeight }, 6);
    panel.style.left = `${String(position.left)}px`;
    panel.style.top = `${String(position.top)}px`;
    panel.style.transformOrigin = position.left === box.left ? "top left" : "top right";
  });

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || Boolean(panelRef.current?.contains(target)) || anchor.contains(target)) return;
    onClose(false);
  });
  const onResize = useEffectEvent(() => { onClose(false); });
  useEffect(() => {
    const pointer = (event: PointerEvent) => { onOutsidePointer(event); };
    const resize = () => { onResize(); };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys stay in the popover: no monitor or timeline shortcut fires behind it
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose(true);
  };

  const subject = activitySubject(activity);
  return (
    <motion.div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={t("渲染進度：{subject}", { subject })}
      tabIndex={-1}
      inert={exiting}
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -2, scale: 0.98, transition: motionTransition("exit", "exit") }}
      transition={motionTransition("spring-snappy", "spring-snappy")}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && (event.currentTarget.contains(next) || anchor.contains(next))) return;
        if (next !== null) onClose(false);
      }}
      className={cn(
        "material-popover fixed top-0 left-0 z-50 flex max-h-[calc(100vh-5rem)] w-105 max-w-[calc(100vw-1rem)] flex-col rounded-xl text-fg outline-none",
        "forced-colors:border forced-colors:border-[CanvasText]",
      )}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-white/8 px-4 pt-3.5 pb-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center">
          {figure ? (
            <CircularProgress value={figure.share} size={32} strokeWidth={3} label={figureDetail(figure)} />
          ) : (
            <LoaderCircle aria-hidden className="size-6 animate-spin text-brand-cyan" />
          )}
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="min-w-0 truncate text-body font-semibold text-fg" title={subject}>
              {subject}
            </p>
            {figure ? (
              <span className="machine ml-auto shrink-0 text-caption text-fg-secondary" title={figureDetail(figure)}>
                {figureText(figure)}
              </span>
            ) : null}
          </div>
          <p className="truncate text-caption text-fg-secondary">{activityLine(activity)}</p>
          {activity.remaining ? (
            <RunRemainingNote remaining={activity.remaining} now={activity.now} pending={activity.estimating} />
          ) : activity.estimating ? (
            <span className="text-caption text-fg-tertiary">{t("估算中…")}</span>
          ) : null}
        </div>
      </div>
      {/* About six rows; a long batch scrolls here (the only scroller of the popover) */}
      <ol aria-label={t("渲染項目")} className="grid max-h-88 min-h-0 flex-1 content-start gap-0.5 overflow-y-auto p-1.5">
        {activity.items.map((item, index) => (
          <ItemRow key={item.suffix} activity={activity} item={item} index={index} completion={completions[index] ?? null} lookup={lookup} />
        ))}
      </ol>
      <RenderSoundToggle />
      <div className="flex shrink-0 items-center gap-2 border-t border-white/8 px-3 py-2.5">
        <Link to={href} onClick={() => { onClose(true); }} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "no-underline")}>
          <Clapperboard aria-hidden />
          {t("在工作清單查看")}
        </Link>
        <Button size="sm" variant="danger" icon={<Ban aria-hidden />} title={t("取消這個 run（會先確認）")} onClick={onCancel} className="ml-auto">
          {t("取消…")}
        </Button>
      </div>
    </motion.div>
  );
}
