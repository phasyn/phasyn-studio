// The notice after 換參考檔案 (BatchReplaceDialog), at the bottom of the shot list: how many shots changed and what each
// @ name became, with 復原, which puts the previous references back in one project edit into every shot that still has
// what the replacement set (a shot whose references were changed again afterwards is left alone, and the notice says how
// many). It closes after 8 s, paused while hovered or focused; focus inside it goes back to the list when it closes.
// Motion: rises in with the snappy spring, fades out on the exit timing (inert from the start of the exit).
import { CircleCheck, Undo2, X } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { TOOL_BUTTON } from "@/components/ui/look";
import { motionTransition } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useHoverFocusTimeout } from "@/lib/useHoverFocusPause";
import { sameReferences, type ReplacedShot } from "../../references/batchReplace";
import { useStudio } from "../../studioContext";

const NOTICE_MS = 8000;

export interface AppliedReplace {
  /** Distinguishes two replacements in a row (a new notice replaces the old one). */
  id: number;
  title: string;
  /** One line per @ name that changed. */
  lines: string[];
  shots: ReplacedShot[];
}

export function ReplaceNotice({ notice, onDismiss, returnFocus }: { notice: AppliedReplace; onDismiss: () => void; returnFocus: () => void }) {
  const { project, dispatch } = useStudio();
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const { pauseHandlers } = useHoverFocusTimeout(NOTICE_MS, present, onDismiss);
  // The shots that still have what the replacement set: only those go back
  const undoable = useMemo(() => {
    const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
    return notice.shots.filter((change) => {
      const shot = byId.get(change.shotId);
      return shot !== undefined && sameReferences(shot.references ?? [], change.references);
    });
  }, [project.shots, notice.shots]);
  const changedSince = notice.shots.length - undoable.length;

  const close = () => {
    const hadFocus = ref.current?.contains(document.activeElement) ?? false;
    onDismiss();
    if (hadFocus) returnFocus();
  };
  const undo = () => {
    if (undoable.length === 0) return;
    for (const change of undoable) dispatch({ type: "updateShot", shotId: change.shotId, patch: { references: change.before } });
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
      className="material-popover absolute inset-x-1 bottom-1 z-20 flex items-start gap-2 rounded-xl px-2.5 py-2 text-fg forced-colors:border forced-colors:border-[CanvasText]"
    >
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-data font-medium">{notice.title}</p>
        {notice.lines.map((line) => (
          <p key={line} className="text-caption text-fg-secondary [overflow-wrap:anywhere]">
            {line}
          </p>
        ))}
        {changedSince > 0 && undoable.length > 0 ? (
          <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{t("其中 {count} 個鏡頭之後又改過參考，復原時不會動它們", { count: changedSince })}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <Button
            size="sm"
            variant="secondary"
            className="min-h-7 px-2"
            icon={<Undo2 aria-hidden />}
            disabled={undoable.length === 0}
            title={undoable.length === 0 ? t("這些鏡頭之後又改過參考，無法復原") : undefined}
            onClick={undo}
          >
            {changedSince > 0 && undoable.length > 0 ? t("復原 {count} 個鏡頭", { count: undoable.length }) : t("復原")}
          </Button>
        </div>
      </div>
      <button type="button" onClick={close} aria-label={t("關閉提示")} className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}>
        <X aria-hidden />
      </button>
    </motion.div>
  );
}
