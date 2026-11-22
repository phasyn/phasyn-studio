// The running render in the toolbar, just left of 渲染鏡頭, shown only while this project's render runs: a 40 px capsule
// with a progress arc, the item being worked on (「2／3」), the estimated share and time left (「約 38%・剩 9:23」) or,
// without an estimate, the counted steps (「5／14 步」); it opens the popover (RenderPopover). Compact (the toolbar's first
// fit level): the arc and the time left (or the counted steps) only. The confirmation of 取消… lives here, beside the
// capsule, so it stays with the Controller's answer when the run ends meanwhile. When the run ends while focus is on the
// capsule or in its popover, focus goes to the render button beside it instead of falling to the page.
// Motion: the capsule pops in (snappy spring) and fades out (Motion presence, inert while it leaves); the chevron turns.
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useSearchParams } from "react-router";
import type { WireRun } from "@/api/types";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { CircularProgress } from "@/components/common/CircularProgress";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { joinInline } from "@/i18n/format";
import type { RenderActivity } from "../../model/renderActivity";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { RenderPopover } from "./RenderPopover";
import {
  activityLine,
  activitySubject,
  cancelScope,
  figureDetail,
  figureText,
  itemPosition,
  leftText,
  remainingText,
  runFigure,
  runHref,
} from "./renderActivityView";
import { t } from "@/i18n";

/** The chevron turns with the popover on the snappy spring. */
const TURN = "transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)";

/** The capsule's figures, left to right; compact keeps the time left (or the counted steps) alone. */
function capsuleParts(activity: RenderActivity, compact: boolean): string[] {
  const figure = runFigure(activity);
  if (compact) {
    const left = leftText(activity, false);
    return (left != null && left !== "") ? [left] : figure ? [figureText(figure)] : [];
  }
  const position = itemPosition(activity);
  const parts = position !== null ? [t("{index}／{total}", { index: position, total: activity.total })] : [];
  if (figure) parts.push(figureText(figure));
  const left = figure?.kind === "estimated" ? leftText(activity, true) : null;
  if (left != null && left !== "") parts.push(left);
  return parts;
}

interface CapsuleProps {
  activity: RenderActivity;
  compact: boolean;
  open: boolean;
  popoverId: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onEscape: () => void;
}

function Capsule({ activity, compact, open, popoverId, buttonRef, onToggle, onEscape }: CapsuleProps) {
  const exiting = !useIsPresent();
  const figure = runFigure(activity);
  const parts = capsuleParts(activity, compact);
  const subject = activitySubject(activity);
  const details = [activityLine(activity), remainingText(activity)];
  return (
    <motion.button
      ref={buttonRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      aria-label={t("渲染進度：{subject}", { subject: joinInline([subject, ...details]) })}
      title={[subject, ...details, ...(figure ? [figureDetail(figure)] : [])].join("\n")}
      inert={exiting}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: motionTransition("exit", "exit") }}
      transition={motionTransition("spring-snappy", "spring-snappy")}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // This Escape closes the popover only: no Studio shortcut behind it
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
      className={cn(
        "group/capsule pressable inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-info/35 bg-info/8 pr-2.5 pl-2",
        "text-data text-fg hover:border-info/60 hover:bg-info/14 active:bg-info/18 aria-expanded:border-info/70 aria-expanded:bg-info/14",
        "forced-colors:border-[ButtonText]",
      )}
    >
      <span aria-hidden className="grid size-5 shrink-0 place-items-center">
        {figure ? <CircularProgress value={figure.share} size={20} strokeWidth={3} /> : <LoaderCircle className="size-4 animate-spin text-info" />}
      </span>
      {parts.length > 0 ? (
        <span aria-hidden className="machine flex items-center gap-1.5 whitespace-nowrap">
          {withOccurrenceKeys(parts, (part) => part).map(({ item: part, key }, index) => (
            <span key={key} className="flex items-center gap-1.5">
              {index > 0 ? <span className="size-[3px] rounded-full bg-fg-tertiary" /> : null}
              {part}
            </span>
          ))}
        </span>
      ) : null}
      <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-fg-tertiary group-aria-expanded/capsule:rotate-180", TURN)} />
    </motion.button>
  );
}

/** The run asked to be cancelled (as it was when asked) and what else stops with it. */
interface Confirming {
  run: WireRun;
  scope: string | undefined;
}

export function RenderCapsule({ compact, fallbackFocus }: { compact: boolean; fallbackFocus: RefObject<HTMLElement | null> }) {
  const activity = useRenderActivity();
  const { project } = useStudio();
  const [params] = useSearchParams();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const focusInsideRef = useRef(false);
  const popoverId = useId();
  // The run ended: its popover goes with it (and does not come back with the next run)
  if (anchor !== null && activity === null) setAnchor(null);
  const open = anchor !== null && activity !== null;

  const ended = activity === null;
  useLayoutEffect(() => {
    if (!ended || !focusInsideRef.current) return;
    focusInsideRef.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || Boolean(wrapperRef.current?.contains(active))) fallbackFocus.current?.focus({ preventScroll: true });
  }, [ended, fallbackFocus]);

  const close = (restoreFocus: boolean) => {
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
    setAnchor(null);
  };

  return (
    <>
      {/* `contents`: no box of its own; it only sees focus enter and leave the capsule and its popover */}
      <span /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Focus and blur from the buttons and popup bubble to this display-contents wrapper. */
        ref={wrapperRef}
        className="contents"
        onFocus={() => {
          focusInsideRef.current = true;
        }}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusInsideRef.current = false;
        }}
      >
        <AnimatePresence>
          {activity ? (
            <Capsule
              key="capsule"
              activity={activity}
              compact={compact}
              open={open}
              popoverId={popoverId}
              buttonRef={buttonRef}
              onToggle={(event) => { setAnchor(open ? null : event.currentTarget); }}
              onEscape={() => { close(true); }}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {open ? (
            <RenderPopover
              key="popover"
              id={popoverId}
              activity={activity}
              anchor={anchor}
              href={runHref(project.project_id, activity.run.run_id, params.get("shot"))}
              onClose={close}
              onCancel={() => {
                setConfirming({ run: activity.run, scope: cancelScope(activity) });
                setAnchor(null);
              }}
            />
          ) : null}
        </AnimatePresence>
      </span>
      {/* Beside the capsule, not in it: the confirmation stays with the Controller's answer when the run ends meanwhile */}
      {confirming ? (
        <CancelRunDialog
          run={confirming.run}
          open
          onOpenChange={(next) => { if (!(next)) { setConfirming(null); } }}
          scope={confirming.scope}
          onCloseAutoFocus={(event) => {
            // Back to the capsule, or to the render button when the run ended meanwhile
            event.preventDefault();
            const target = (buttonRef.current?.isConnected === true) ? buttonRef.current : fallbackFocus.current;
            target?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </>
  );
}
