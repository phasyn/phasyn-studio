// What both tools of the speed-feel dialog show: the body (the note after an edit was applied, with how to undo it;
// why the clip cannot be analysed; the tool's introduction; the reading progress — the take first, then the original:
// each half of the way, the brand gradient growing by transform only; the failure; or the tool's result), the verdict
// with the way to the shot, and the footer (the analysis or the undo on the left, closing and applying on the right).
// The body's states fade into each other (useChangeFade).
import { CircleAlert, CircleCheck, CircleX, LoaderCircle, Play, RotateCcw, Square, Undo2, Wand2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { useEditor } from "../editor/editorContext";
import { chordOf } from "../editor/keymap";
import { NoteList } from "../swap/fields";
import type { SpeedFeelTargetResult } from "./target";
import type { FeelTone, FeelVerdictView } from "./view";

/** What the dialog gives each tool. */
export interface ToolProps {
  clipId: string;
  /**
   * The history step the tool applied, kept while the other tool shows (the clip is then the first part of itself: it
   * is not read again); null before.
   */
  applied: string | null;
  onApplied: (label: string | null) => void;
  onClose: () => void;
}

/** What a tool's reader says about the clip (SpeedFeelStatus, ConformStatus). */
type ReadStatus = { status: "running"; clip: "take" | "original"; done: number; total: number } | { status: "done" } | { status: "failed"; reason: string };

const TONE_TEXT: Record<FeelTone, string> = { info: "text-info", success: "text-success", warning: "text-warning" };

/** Undo's shortcut as this platform writes it (⌘ or Ctrl). */
function undoShortcut(): string {
  const apple = detectApplePlatform();
  return chordOf("undo")
    .split("+")
    .map((key) => modifierLabel(key, apple))
    .join("+");
}

function Reading({ clip, done, total }: { clip: "take" | "original"; done: number; total: number }) {
  // The take is read first, then the original: each is half of the way
  const share = ((clip === "take" ? 0 : 1) + (total > 0 ? done / total : 0)) / 2;
  return (
    <div role="status" className="grid gap-1.5">
      <p className="flex items-center gap-1.5 text-data text-info">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        {total === 0 ? t("開啟影片…") : clip === "take" ? t("讀取生成影片的影格 {done}／{total}…", { done, total }) : t("讀取原片的影格 {done}／{total}…", { done, total })}
      </p>
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-raised">
        <span className="block h-full origin-left rounded-full bg-brand-gradient transition-transform duration-(--duration-base) ease-standard" style={{ transform: `scaleX(${String(share)})` }} />
      </span>
    </div>
  );
}

function AppliedNote({ label }: { label: string }) {
  return (
    <div role="status" className="grid gap-1.5 rounded-lg border border-success/30 bg-success/8 p-3 animate-reveal">
      <p className="flex items-start gap-1.5 text-data text-success">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{t("已套用「{label}」。在節目監看器播放這段就能看到效果。", { label })}</span>
      </p>
      <p className="text-caption text-fg-secondary">{t("要還原，按下面的「復原」；關閉這個視窗後也可以按 {shortcut}，或在「歷程」面板選前一步。", { shortcut: undoShortcut() })}</p>
    </div>
  );
}

interface ToolBodyProps {
  /** The history step the tool applied; null before. */
  applied: string | null;
  target: SpeedFeelTargetResult;
  /** The tool's analysis of the target; null before the first read. */
  status: ReadStatus | null;
  /** What the tool does, shown before the first read. */
  intro: string;
  /** The finished analysis. */
  children: ReactNode;
}

export function ToolBody({ applied, target, status, intro, children }: ToolBodyProps) {
  const state = applied !== null ? "applied" : !target.ok ? "unavailable" : (status?.status ?? "idle");
  const fade = useChangeFade<HTMLDivElement>(state);
  return (
    <DialogBody>
      <div ref={fade} className="grid min-w-0 content-start gap-4">
        {applied !== null ? (
          <AppliedNote label={applied} />
        ) : !target.ok ? (
          <NoteList tone="info" icon={<CircleAlert aria-hidden />} title={t("沒有辦法分析這個片段")} items={[target.reason]} />
        ) : status === null ? (
          <p className="text-data text-fg-secondary">{intro}</p>
        ) : status.status === "running" ? (
          <Reading clip={status.clip} done={status.done} total={status.total} />
        ) : status.status === "failed" ? (
          <NoteList tone="warning" icon={<CircleX aria-hidden />} title={t("分析沒有完成")} items={[status.reason]} />
        ) : (
          children
        )}
      </div>
    </DialogBody>
  );
}

interface VerdictProps {
  verdict: FeelVerdictView;
  /** The tool's icon for the verdict's tone. */
  icon: LucideIcon;
  /** The way to the shot's generation, when the verdict asks for it. */
  regenerate: { href: string; label: string; onLeave: () => void } | null;
}

export function Verdict({ verdict, icon: Icon, regenerate }: VerdictProps) {
  return (
    <div className="grid gap-2">
      <p role="status" className={cn("flex items-start gap-2 text-data [overflow-wrap:anywhere]", TONE_TEXT[verdict.tone])}>
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="grid gap-0.5">
          <strong className="font-semibold">{verdict.label}</strong>
          <span className="text-fg">{verdict.line}</span>
        </span>
      </p>
      {regenerate ? (
        <Link to={regenerate.href} onClick={regenerate.onLeave} className="pressable inline-flex min-h-8 w-fit items-center gap-1.5 rounded-md px-2 text-data text-brand-cyan hover:bg-raised">
          <Wand2 aria-hidden className="size-3.5" />
          {regenerate.label}
        </Link>
      ) : null}
    </div>
  );
}

interface ToolFooterProps {
  /** The history step the tool applied (its undo replaces the analysis' buttons); null before. */
  applied: string | null;
  onUndone: () => void;
  /** The analysis' state with its start and cancel; null when the clip cannot be analysed. */
  reading: { status: ReadStatus["status"] | null; start: () => void; cancel: () => void } | null;
  /** The tool's apply button. */
  children: ReactNode;
}

export function ToolFooter({ applied, onUndone, reading, children }: ToolFooterProps) {
  const editor = useEditor();
  const { steps, position } = editor.history;
  const ownStep = applied !== null && position > 0 && steps[position - 1]?.label === applied;
  const undo = () => {
    editor.undo();
    onUndone();
  };
  return (
    <DialogFooter>
      {/* The analysis (or the undo) on the left, closing and applying on the right */}
      {applied !== null ? (
        <ActionButton className="mr-auto" icon={<Undo2 aria-hidden />} disabledReason={ownStep ? null : t("這一步已經不是最後一步：請在「歷程」面板選它之前的一步")} onClick={undo}>
          {t("復原")}
        </ActionButton>
      ) : reading?.status === "running" ? (
        <Button className="mr-auto" variant="quiet" icon={<Square aria-hidden />} onClick={reading.cancel}>
          {t("取消分析")}
        </Button>
      ) : reading ? (
        <Button className="mr-auto" variant="quiet" icon={reading.status === null ? <Play aria-hidden /> : <RotateCcw aria-hidden />} onClick={reading.start}>
          {reading.status === null ? t("開始分析") : t("重新分析")}
        </Button>
      ) : null}
      <DialogClose asChild>
        <Button>{t("關閉")}</Button>
      </DialogClose>
      {children}
    </DialogFooter>
  );
}
