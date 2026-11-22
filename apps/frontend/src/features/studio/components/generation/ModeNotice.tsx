// The one notice after a 方式 change, just above the generation row: what changed (route, first frame, references that
// are no longer sent) with 復原, which puts the route and the first-frame setting back in one project edit while the
// shot still has what the change set (a later edit is never overwritten). It closes after 8 s, paused while hovered or
// focused; focus inside it goes back to the 方式 field when it closes. A route that is not ready yet offers the engine
// sheet on that route's components.
// Motion: rises in with the snappy spring, fades out on the exit timing (inert from the start of the exit).
import { CircleCheck, Cpu, Undo2, X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useRef } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { TOOL_BUTTON } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useHoverFocusTimeout } from "@/lib/useHoverFocusPause";
import { sameContinuity } from "../../model/generationMode";
import { useStudio } from "../../studioContext";
import { showEngine } from "./engineView";
import { t } from "@/i18n";

const NOTICE_MS = 8000;

/** The route and first frame a shot had or has. */
export interface ShotSetup {
  route: string;
  continuity: StudioShot["continuity"];
}

export interface AppliedMode {
  /** Distinguishes two changes in a row (a new notice replaces the old one). */
  id: number;
  title: string;
  detail: string;
  before: ShotSetup;
  after: ShotSetup;
  /** The route whose components are not ready yet; null when the route is ready. */
  notReadyRouteId: string | null;
}

export function ModeNotice({ shot, notice, onDismiss, returnFocus }: { shot: StudioShot; notice: AppliedMode; onDismiss: () => void; returnFocus: () => void }) {
  const { dispatch, setEngineOpen } = useStudio();
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const { pauseHandlers } = useHoverFocusTimeout(NOTICE_MS, present, onDismiss);
  const canUndo = shot.route === notice.after.route && sameContinuity(shot.continuity, notice.after.continuity);

  const close = () => {
    const hadFocus = ref.current?.contains(document.activeElement) ?? false;
    onDismiss();
    if (hadFocus) returnFocus();
  };
  const undo = () => {
    if (!canUndo) return;
    dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { route: notice.before.route, ...(notice.before.continuity === undefined ? {} : { continuity: notice.before.continuity }) } });
    close();
  };

  return (
    <motion.div
      ref={ref}
      role="status"
      inert={!present}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, transition: motionTransition("exit", "exit") }}
      transition={motionTransition("spring-snappy", "spring-snappy")}
      {...pauseHandlers}
      className="material-popover absolute inset-x-1 bottom-full z-20 mb-1.5 flex items-start gap-2 rounded-xl px-2.5 py-2 text-fg forced-colors:border forced-colors:border-[CanvasText]"
    >
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-data font-medium">{notice.title}</p>
        {notice.detail ? <p className="text-caption text-fg-secondary [overflow-wrap:anywhere]">{notice.detail}</p> : null}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <Button size="sm" variant="secondary" className="min-h-7 px-2" icon={<Undo2 aria-hidden />} disabled={!canUndo} title={canUndo ? undefined : t("之後又改過路線或首幀，無法復原")} onClick={undo}>
            {t("復原")}
          </Button>
          {(notice.notReadyRouteId != null && notice.notReadyRouteId !== "") ? (
            <Button
              size="sm"
              variant="quiet"
              className="min-h-7 px-2"
              icon={<Cpu aria-hidden />}
              onClick={() => {
                // The sheet gives focus back to the 方式 field, which outlives this notice
                returnFocus();
                showEngine({ tab: "components", routeId: notice.notReadyRouteId }, setEngineOpen);
              }}
            >
              {t("開啟渲染引擎")}
            </Button>
          ) : null}
        </div>
      </div>
      <button type="button" onClick={close} aria-label={t("關閉提示")} className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}>
        <X aria-hidden />
      </button>
    </motion.div>
  );
}
