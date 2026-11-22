// 逐鏡描述 (opened from the Prompt toolbar when the prompt has [Shot N] lines): one row per shot with the reference
// video's picture at that shot, its time range and its description (English), plus shot-size, who-is-in-this-shot and
// viewpoint chips and a live check of the measured rules (state the shot size and the viewpoint the reference shot
// has; restate each character's hair colour and one accessory; negate nothing). The characters' list says which
// defined character no shot names (H3 draws a character that is listed but not in the segment).
// The dialog edits a copy taken when it opened (the editor mounts it once per opening). 儲存 writes the whole prompt once
// through the editor's change notice (one change, one 復原): only the shot texts change, a description left as it was
// keeps whatever the prompt has now, and nothing is written when the shots changed meanwhile. 取消, Esc and the close
// button change nothing; a click outside does not close it while there are edits.
// Keyboard: the first description has the focus; Tab goes chips → description → next shot; Ctrl/⌘+Enter saves (not
// while an input method composes) and always stops there: the inspector's Ctrl+Enter would render the shot; Esc cancels
// (not while an input method composes).
// Motion: the shared dialog entrance; the characters and the rows rise in one after another (motion.reveal); pictures,
// check lines and the footer's status fade in; chips and buttons press.
import { Check, ImageOff, ListVideo } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { cancelThumbs } from "../../swap/sourceThumbs";
import { formatSeconds, rangeLabel } from "../blocks";
import { PROMPT_MAX_LENGTH } from "../compile";
import { blocksSave, namedSubjects, shotIssues, type SubjectCheck } from "./checks";
import { parseShotLayout, writeShotTexts, type ShotLayout } from "./layout";
import { ShotRow } from "./ShotRow";
import type { ShotPicture } from "./ShotThumb";
import { distinctWords, signaturePhrase, signatureWords } from "./signature";
import { clipEnd, frameSeconds, motionSource, shotTimings, type MotionSourceResult, type ShotTiming } from "./source";
import { SubjectLegend } from "./SubjectLegend";

export interface ShotDescriptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The prompt as it is now (read again when saving). */
  value: string;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** The shot's length in seconds (where the last shot ends when the reference window does not say). */
  durationSeconds: number | null;
  disabled?: boolean;
  /** Writes the whole prompt as one undoable change; false = it was refused. */
  onSave: (next: string, message: string) => boolean;
}

function rangeText(timing: ShotTiming): string {
  if (timing.start === null) return t("時間未知");
  if (timing.end === null) return t("{start} 秒起", { start: formatSeconds(timing.start, 1) });
  return rangeLabel({ start: timing.start, end: timing.end }, 1);
}

function pictureOf(timing: ShotTiming, source: MotionSourceResult): ShotPicture {
  if (!source.ok) return { reason: source.reason };
  const seconds = frameSeconds(timing, source.source);
  if (seconds === null) return { reason: t("這個鏡頭沒有切鏡時間，對不到參考影片的畫面") };
  return { url: source.source.url, seconds, title: t("@{alias} 第 {seconds} 秒的畫面", { alias: source.source.alias, seconds: formatSeconds(seconds, 2) }) };
}

/** Reading pictures stops when the dialog's content goes away (pictures already read stay for the next opening). */
function ThumbReads() {
  useEffect(() => cancelThumbs, []);
  return null;
}

export function ShotDescriptionsDialog({ open, onOpenChange, value, references, library, durationSeconds, disabled = false, onSave }: ShotDescriptionsDialogProps) {
  const id = useId();
  const fieldId = (index: number) => `${id}-shot-${String(index)}`;
  const [opened] = useState<ShotLayout | null>(() => parseShotLayout(value));
  const [texts, setTexts] = useState<string[]>(() => opened?.shots.map((shot) => shot.text) ?? []);
  const [phrases, setPhrases] = useState<string[]>(() => opened?.subjects.map((subject) => signaturePhrase(subject.text)) ?? []);
  const [error, setError] = useState<string | null>(null);

  const subjects = useMemo<SubjectCheck[]>(() => {
    const words = distinctWords(phrases.map(signatureWords));
    return (opened?.subjects ?? []).map((subject, index) => ({ number: subject.number, phrase: phrases[index] ?? "", words: words[index] ?? [] }));
  }, [opened, phrases]);
  const issues = useMemo(() => texts.map((text) => shotIssues(text, subjects)), [texts, subjects]);
  // Defined characters that no shot names: listed but not in the segment, H3 still draws them
  const unnamed = useMemo(() => {
    const named = new Set(texts.flatMap((text) => [...namedSubjects(text)]));
    return subjects.filter((subject) => !named.has(subject.number)).map((subject) => subject.number);
  }, [texts, subjects]);
  const source = useMemo(() => motionSource(opened?.motion ?? null, references, library), [opened, references, library]);
  const timings = useMemo(() => shotTimings(opened?.shots ?? [], clipEnd(source.ok ? source.source : null, durationSeconds)), [opened, source, durationSeconds]);
  const result = useMemo(() => (opened ? writeShotTexts(value, opened, texts) : null), [value, opened, texts]);

  const shots = opened?.shots ?? [];
  const dirty = shots.some((shot, index) => texts[index] !== shot.text);
  const blockedAt = issues.findIndex((list) => list.some(blocksSave));
  const blockedIssue = issues[blockedAt]?.find(blocksSave);
  const blockedNumber = shots[blockedAt]?.number ?? blockedAt + 1;
  const blockedReason = disabled
    ? t("編輯器目前停用")
    : blockedIssue
      ? blockedIssue.kind === "empty"
        ? t("鏡頭 {number} 的描述是空的", { number: blockedNumber })
        : t("鏡頭 {number} 的描述裡有 [Shot n] 標記", { number: blockedNumber })
      : !result
        ? t("這個 prompt 沒有 [Shot n] 行")
        : !result.ok
          ? result.reason
          : result.text.length > PROMPT_MAX_LENGTH
            ? t("結果會有 {nextCount} 字元，超過 {promptMaxLength} 字元上限", { nextCount: result.text.length.toLocaleString("en-US"), promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") })
            : null;
  const warned = issues.filter((list) => list.length > 0).length;
  const problem = error ?? blockedReason;
  const status =
    problem ??
    (warned > 0
      ? t("{count} 個鏡頭有提醒，仍可儲存", { count: warned })
      : unnamed.length > 0
        ? t("{subjects} 沒有出現在任何鏡頭，仍可儲存", { subjects: formatList(unnamed.map((number) => `<Subject ${String(number)}>`)) })
        : subjects.length > 0
          ? t("每個鏡頭都寫了景別、視角與角色特徵")
          : t("每個鏡頭都寫了景別"));
  const warning = warned > 0 || unnamed.length > 0;
  const statusRef = useChangeFade<HTMLParagraphElement>(status);
  const shortcut = t("{key}+Enter 儲存・Esc 取消", { key: modifierLabel("Mod", detectApplePlatform()) });

  const focusField = (index: number) => {
    const field = document.getElementById(fieldId(index));
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };
  const setText = (index: number, next: string) => {
    setError(null);
    setTexts((current) => current.map((text, at) => (at === index ? next : text)));
  };
  const save = () => {
    // The footer already says why; the description to fix gets the focus
    if (blockedReason !== null || !(result?.ok === true)) {
      if (blockedAt >= 0) focusField(blockedAt);
      return;
    }
    if (result.changed === 0) {
      onOpenChange(false);
      return;
    }
    if (onSave(result.text, t("已更新 {count} 個鏡頭的描述", { count: result.changed }))) onOpenChange(false);
    else setError(t("Prompt 編輯器沒有接受這次修改，沒有儲存"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wide
        aria-describedby={`${id}-description`}
        className="max-h-[min(92vh,60rem)] max-w-5xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusField(0);
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (dirty) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
          // Never reaches the inspector, not even while an input method composes (it would render the shot)
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          save();
        }}
      >
        <ThumbReads />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListVideo aria-hidden className="size-4 text-brand-cyan" />
            {t("逐鏡描述")}
            <span className="text-data font-normal text-fg-tertiary">{t("{count} 個鏡頭", { count: shots.length })}</span>
          </DialogTitle>
          <DialogDescription id={`${id}-description`}>
            {t("每個鏡頭寫一行英文：景別、角色、視角、姿勢、動作、場景。看著參考畫面選視角，畫面上的每個人物（連遠處的小人也算）都點名成其中一個角色，這一鏡沒有的角色不要寫；每個角色都寫出髮色和一個配件，否則 H3 會畫回原角色。只改這些描述，切鏡時間和其他段落不變。")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid content-start gap-3">
          {opened && opened.subjects.length > 0 ? (
            <SubjectLegend
              subjects={opened.subjects}
              phrases={phrases}
              unnamed={unnamed}
              references={references}
              library={library}
              disabled={disabled}
              onPhrase={(index, phrase) => { setPhrases((current) => current.map((item, at) => (at === index ? phrase : item))); }}
            />
          ) : null}
          {!source.ok ? (
            <p className="flex min-w-0 items-start gap-1.5 text-caption text-fg-tertiary">
              <ImageOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{source.reason}</span>
            </p>
          ) : null}
          {opened ? (
            <ol aria-label={t("鏡頭")} className="grid gap-2.5">
              {shots.map((shot, index) => {
                const timing = timings[index] ?? { start: shot.start, end: null };
                return (
                  <ShotRow
                    key={shot.number}
                    index={index + 1}
                    fieldId={fieldId(index)}
                    shot={shot}
                    range={rangeText(timing)}
                    picture={pictureOf(timing, source)}
                    text={texts[index] ?? ""}
                    issues={issues[index] ?? []}
                    subjects={subjects}
                    disabled={disabled}
                    onText={(next) => { setText(index, next); }}
                  />
                );
              })}
            </ol>
          ) : (
            <p className="text-data text-fg-secondary">{t("這個 prompt 沒有 [Shot n] 行")}</p>
          )}
        </DialogBody>
        <DialogFooter className="flex-nowrap">
          <p
            ref={statusRef}
            role="status"
            aria-live="polite"
            className={cn("mr-auto min-w-0 flex-1 text-caption [overflow-wrap:anywhere]", problem !== null ? "text-danger" : warning ? "text-warning" : "text-success")}
          >
            {status}
          </p>
          <span className="shrink-0 text-caption whitespace-nowrap text-fg-tertiary">{shortcut}</span>
          <DialogClose asChild>
            <Button variant="secondary">{t("取消")}</Button>
          </DialogClose>
          <ActionButton variant="primary" icon={<Check aria-hidden />} disabledReason={blockedReason} onClick={save}>
            {t("儲存")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
