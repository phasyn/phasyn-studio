// 段尾凍結 in the one-click swap panel (an existing swap project): the summary's line says how many segments hold the
// last frame of their @Video1 reference, and 「改用段尾凍結…」 opens a dialog that lists every segment it changes (its
// @Video1 window before and after, and whether its prompt is rewritten with it), the prompts that need adjusting by hand
// and the segments it leaves alone (holdTail.ts decides all of it). 套用 is one document edit (one updateShot per changed
// segment, in one event), which the autosave sends once; shot settings are not in the edit history, so the notice
// afterwards offers 復原, which puts the references and prompts back into every segment that still has what 套用 wrote.
// The changed segments show as 設定已改, and 「重新渲染設定已改的段落…」 renders them. Mounted once per opening (the line
// keys it) and kept through its exit animation: after 套用 it goes on showing the plan it applied while it fades.
// Keyboard: the apply button has the focus; Ctrl/⌘+Enter applies; Esc cancels. Motion: the shared dialog entrance and
// exit; the rows rise in one after another; the footer's status fades when it changes; the notice rises in with the
// snappy spring and fades out on the exit timing.
import { CircleCheck, Info, Snowflake, TriangleAlert, Undo2, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useMemo, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TOOL_BUTTON } from "@/components/ui/look";
import { motionTransition, reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { sameReferences } from "../references/batchReplace";
import { useStudio } from "../studioContext";
import { Fact, NoteList } from "./fields";
import { heldSegmentCount, holdTailPlan, type HoldTailChange, type HoldTailPlan, type HoldTailSkip } from "./holdTail";
import type { SwapProgress, SwapProjectInfo } from "./job";
import { DEFAULT_HOLD_TAIL } from "./planner";
import { formatCueTime } from "./prompt";

interface AppliedHold {
  /** Distinguishes two applications in a row (a new notice replaces the old one). */
  id: number;
  changes: HoldTailChange[];
}

/** The summary line: how many segments hold, 「改用段尾凍結…」 while some do not, and the notice after applying. */
export function HoldTailFact({ progress, info }: { progress: SwapProgress; info: SwapProjectInfo }) {
  const shots = useMemo(() => progress.segments.map((segment) => segment.shot), [progress.segments]);
  const held = heldSegmentCount(shots);
  const total = shots.length;
  const [dialog, setDialog] = useState<{ open: boolean; session: number } | null>(null);
  const [applied, setApplied] = useState<AppliedHold | null>(null);
  // No segment in the film (all taken off the timeline): nothing to say, the segment table explains it
  if (total === 0) return null;
  const state = held === total ? t("每一段都在段尾後凍結最後一格") : held === 0 ? t("沒有使用：參考影片帶著下一段的鏡頭，模型可能提早畫出來") : t("{held}／{total} 段使用", { held, total });
  return (
    <Fact label={t("段尾凍結")}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{state}</span>
        {held < total ? (
          <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<Snowflake aria-hidden />} onClick={() => setDialog((current) => ({ open: true, session: (current?.session ?? 0) + 1 }))}>
            {t("改用段尾凍結…")}
          </Button>
        ) : null}
      </span>
      <AnimatePresence>{applied ? <HoldTailNotice key={applied.id} applied={applied} onDismiss={() => setApplied(null)} /> : null}</AnimatePresence>
      {dialog ? (
        <HoldTailDialog
          key={dialog.session}
          open={dialog.open}
          shots={shots}
          info={info}
          onApplied={(changes) => setApplied({ id: dialog.session, changes })}
          onClose={() => setDialog((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
    </Fact>
  );
}

/** `00:39.333–00:42.458` (seconds of the source video; end null = to the file's end). */
function windowText(start: number, end: number | null, fps: number): string {
  return `${formatCueTime(Math.round(start * fps), fps)}–${end === null ? t("結尾") : formatCueTime(Math.round(end * fps), fps)}`;
}

/** The skipped segments, one line per reason. */
function skippedLines(plan: HoldTailPlan): string[] {
  const of = (reason: HoldTailSkip) => plan.skipped.filter((item) => item.reason === reason);
  const titles = (reason: HoldTailSkip) => formatList(of(reason).map((item) => item.title));
  return [
    of("held").length > 0 ? t("已經是段尾凍結：{count} 段", { count: of("held").length }) : null,
    of("no-video").length > 0 ? t("沒有 @Video1 參考影片，不改：{titles}", { titles: titles("no-video") }) : null,
    of("no-range").length > 0 ? t("鏡頭名稱與備註都讀不到原影片範圍，不改：{titles}", { titles: titles("no-range") }) : null,
    of("outside").length > 0 ? t("原影片範圍放不進參考影片或生成長度，不改：{titles}", { titles: titles("outside") }) : null,
  ].filter((line): line is string => line !== null);
}

function HoldTailDialog({
  open,
  shots,
  info,
  onApplied,
  onClose,
}: {
  open: boolean;
  /** The swap's segments in film order (read again on every render until 套用). */
  shots: readonly StudioShot[];
  info: SwapProjectInfo;
  onApplied: (changes: HoldTailChange[]) => void;
  onClose: () => void;
}) {
  const { project, dispatch } = useStudio();
  const applyButton = useRef<HTMLButtonElement>(null);
  const live = useMemo(() => holdTailPlan(shots, { fps: info.job.fps, library: project.library ?? [] }), [shots, info.job.fps, project.library]);
  /** The plan as it was applied (shown while the dialog fades out). */
  const [done, setDone] = useState<HoldTailPlan | null>(null);
  const plan = done ?? live;
  const fps = info.job.fps;
  const count = plan.changes.length;
  const manual = plan.changes.filter((change) => change.manualPrompt);
  const reason = count === 0 ? t("沒有要改的段落") : null;
  const status = reason ?? (manual.length > 0 ? t("會改 {count} 段的 @Video1；{manual} 段的 prompt 要自己調整", { count, manual: manual.length }) : t("會改 {count} 段的 @Video1 與 prompt", { count }));
  const statusRef = useChangeFade<HTMLParagraphElement>(status);
  const shortcut = t("{key}+Enter 套用・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  const apply = () => {
    if (reason !== null || done !== null) return;
    for (const change of plan.changes) dispatch({ type: "updateShot", shotId: change.shotId, patch: { references: change.after.references, prompt: change.after.prompt } });
    onApplied(plan.changes);
    setDone(plan);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        wide
        onOpenAutoFocus={(event) => {
          if (!applyButton.current) return;
          event.preventDefault();
          applyButton.current.focus();
        }}
        onKeyDown={(event) => {
          // The keys stay in the dialog: the swap panel and the editor have their own
          event.stopPropagation();
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          apply();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Snowflake aria-hidden className="size-4 text-brand-cyan" />
            {t("改用段尾凍結")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "每一段的 @Video1 改成從段落起點到段尾後 {leadOut} 秒（至少 {minReal} 秒原片），之後凍結最後一格、聲音補靜音；一鍵換角寫的 prompt 會一起改寫切鏡與凍結的時間。改過的段落會變成「設定已改」，用「重新渲染設定已改的段落…」重新渲染，原本的 take 留在 take 列。",
              { leadOut: DEFAULT_HOLD_TAIL.leadOutFrames / fps, minReal: DEFAULT_HOLD_TAIL.minRealFrames / fps },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-3">
          {count > 0 ? (
            <ul className="grid gap-0.5" aria-label={t("會改的段落（{count}）", { count })}>
              {plan.changes.map((change, index) => (
                <li key={change.shotId} ref={reveal(index)} className="grid gap-0.5 rounded-md px-2 py-1.5 transition-colors duration-(--duration-fast) hover:bg-raised/40">
                  <span className="truncate text-data text-fg" title={change.title}>
                    {change.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-caption text-fg-tertiary">
                    <span className="machine">{t("參考 {from} → {to}，之後凍結", { from: windowText(change.from.start, change.from.end, fps), to: windowText(change.to.start, change.to.end, fps) })}</span>
                    <span className={change.manualPrompt ? "text-warning" : "text-fg-secondary"}>{change.manualPrompt ? t("prompt 要自己調整") : t("prompt 一起改寫")}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <NoteList tone="warning" icon={<TriangleAlert aria-hidden />} title={t("這些段落的 prompt 需要自己調整")} items={manual.map((change) => change.title)} />
          <NoteList tone="info" icon={<Info aria-hidden />} items={skippedLines(plan)} />
        </DialogBody>
        <DialogFooter className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2">
          <p ref={statusRef} role="status" aria-live="polite" className={cn("col-span-3 text-caption [overflow-wrap:anywhere]", reason === null ? "text-fg" : "text-fg-tertiary")}>
            {status}
          </p>
          <span className="min-w-0 truncate text-caption text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button>{t("取消")}</Button>
          </DialogClose>
          <ActionButton ref={applyButton} variant="primary" icon={<Snowflake aria-hidden />} disabledReason={reason} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={apply}>
            {count > 0 ? t("改用段尾凍結 {count} 段", { count }) : t("改用段尾凍結")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** After 套用: how many segments changed, the prompts left to adjust, and 復原 for the segments that still have what it wrote. */
function HoldTailNotice({ applied, onDismiss }: { applied: AppliedHold; onDismiss: () => void }) {
  const { project, dispatch } = useStudio();
  const present = useIsPresent();
  const undoable = useMemo(() => {
    const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
    return applied.changes.filter((change) => {
      const shot = byId.get(change.shotId);
      return shot !== undefined && shot.prompt === change.after.prompt && sameReferences(shot.references ?? [], change.after.references);
    });
  }, [project.shots, applied.changes]);
  const changedSince = applied.changes.length - undoable.length;
  const manual = applied.changes.filter((change) => change.manualPrompt).map((change) => change.title);
  const undo = () => {
    if (undoable.length === 0) return;
    for (const change of undoable) dispatch({ type: "updateShot", shotId: change.shotId, patch: { references: change.before.references, prompt: change.before.prompt } });
    onDismiss();
  };
  return (
    <motion.div
      role="status"
      inert={!present}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, transition: motionTransition("exit", "exit") }}
      transition={motionTransition("spring-snappy", "spring-snappy")}
      className="mt-1.5 flex items-start gap-2 rounded-lg border border-line-subtle bg-sunken/60 px-2.5 py-2"
    >
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-data font-medium text-fg">{t("已改用段尾凍結：{count} 段", { count: applied.changes.length })}</p>
        {manual.length > 0 ? <p className="text-caption text-warning [overflow-wrap:anywhere]">{t("這些段落的 prompt 需要自己調整：{titles}", { titles: formatList(manual) })}</p> : null}
        <p className="text-caption text-fg-secondary">{t("按「重新渲染設定已改的段落…」重新渲染這些段落。")}</p>
        {changedSince > 0 && undoable.length > 0 ? <p className="text-caption text-fg-tertiary">{t("其中 {count} 段之後又改過，復原時不會動它們", { count: changedSince })}</p> : null}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <Button
            size="sm"
            variant="secondary"
            className="min-h-7 px-2"
            icon={<Undo2 aria-hidden />}
            disabled={undoable.length === 0}
            title={undoable.length === 0 ? t("這些段落之後又改過，無法復原") : undefined}
            onClick={undo}
          >
            {changedSince > 0 && undoable.length > 0 ? t("復原 {count} 段", { count: undoable.length }) : t("復原")}
          </Button>
        </div>
      </div>
      <button type="button" onClick={onDismiss} aria-label={t("關閉提示")} className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}>
        <X aria-hidden />
      </button>
    </motion.div>
  );
}
