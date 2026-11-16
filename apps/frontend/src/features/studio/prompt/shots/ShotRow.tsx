// One shot of the 逐鏡描述 dialog: the reference picture and time range on the left; on the right the shot's fixed
// prefix, its chips, the description (English) and the live check. Chips: shot size (replaces the opening phrase); who
// is in this shot (each defined character, pressed while the description names it: pressing an unpressed one inserts
// <Subject N> and its signature phrase at the caret, pressing a pressed one takes the character out); viewpoint
// (正面 … 仰角, picked while looking at the reference picture: replaces the viewpoint another chip wrote, or goes right
// after the characters). The chips are one Tab stop (← → Home End move between them), so Tab goes chips → description
// → the next shot. After a chip the caret lands right after what it wrote.
// Motion: chips press (pressable) and pressed chips take the brand fill; the check's lines fade in as they appear; the
// status mark fades when it changes.
import { CircleCheck, CircleX, TriangleAlert, UserRound } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Textarea } from "@/components/ui/controls";
import { CARD } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  applyShotSize,
  applyViewpoint,
  blocksSave,
  currentShotSize,
  currentViewpoint,
  insertAt,
  issueKey,
  issueText,
  namedSubjects,
  removeSubject,
  SHOT_SIZES,
  shotSizeLabels,
  sizePhrase,
  subjectInsertion,
  type ShotIssue,
  type SubjectCheck,
  type TextEdit,
} from "./checks";
import { continuesPrefix, type ShotLine } from "./layout";
import { ShotThumb, type ShotPicture } from "./ShotThumb";
import { VIEWPOINTS, viewpointLabels } from "./wording";

const CHIP =
  "pressable inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-caption font-medium whitespace-nowrap select-none disabled:cursor-not-allowed disabled:border-line-subtle disabled:bg-transparent disabled:text-fg-disabled [&_svg]:size-3.5";
const CHIP_IDLE = "border-line bg-raised/60 text-fg-secondary hover:border-line-strong hover:bg-raised hover:text-fg active:bg-sunken";
const CHIP_ON = "border-brand-blue/60 bg-brand-gradient-soft text-fg";

/** ← → Home End move between the chips of a row (the row's chips are one Tab stop). */
function moveChipFocus(event: KeyboardEvent<HTMLDivElement>) {
  const chips = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = chips.findIndex((chip) => chip === event.target);
  if (at < 0) return;
  const next =
    event.key === "ArrowRight" ? chips[(at + 1) % chips.length] : event.key === "ArrowLeft" ? chips[(at - 1 + chips.length) % chips.length] : event.key === "Home" ? chips[0] : event.key === "End" ? chips.at(-1) : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function StatusMark({ issues }: { issues: readonly ShotIssue[] }) {
  if (issues.length === 0) {
    return (
      <span key="ok" className="inline-flex text-success animate-fade-in" title={t("沒有提醒")}>
        <CircleCheck aria-hidden className="size-3.5" />
        <span className="sr-only">{t("沒有提醒")}</span>
      </span>
    );
  }
  const blocking = issues.some(blocksSave);
  const Icon = blocking ? CircleX : TriangleAlert;
  return (
    <span key={blocking ? "block" : "warn"} className={cn("inline-flex items-center gap-0.5 text-caption animate-fade-in", blocking ? "text-danger" : "text-warning")}>
      <Icon aria-hidden className="size-3.5" />
      <span aria-hidden className="machine">
        {issues.length}
      </span>
      <span className="sr-only">{t("{count} 個提醒", { count: issues.length })}</span>
    </span>
  );
}

export interface ShotRowProps {
  /** Position in the dialog (the stagger of the entrance). */
  index: number;
  /** Id of the description field. */
  fieldId: string;
  shot: ShotLine;
  /** The time range, already in words. */
  range: string;
  picture: ShotPicture;
  text: string;
  issues: readonly ShotIssue[];
  subjects: readonly SubjectCheck[];
  disabled: boolean;
  onText: (next: string) => void;
}

export function ShotRow({ index, fieldId, shot, range, picture, text, issues, subjects, disabled, onText }: ShotRowProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // Until the caret has been in the field, a character chip writes at the end (a new field's caret sits at its start)
  const placed = useRef(false);
  const labels = shotSizeLabels();
  const viewLabels = viewpointLabels();
  const size = currentShotSize(text);
  const viewpoint = currentViewpoint(text);
  const named = namedSubjects(text);
  const lowerCase = continuesPrefix(shot);
  const issuesId = `${fieldId}-issues`;
  const number = shot.number;

  // After a chip's edit reaches the field: the caret goes right after what the chip wrote
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const field = fieldRef.current;
    if (caret === null || !field) return;
    pendingCaret.current = null;
    field.focus();
    field.setSelectionRange(caret, caret);
  }, [text]);

  const commit = (edit: TextEdit) => {
    if (edit.text !== text) {
      pendingCaret.current = edit.caret;
      onText(edit.text);
      return;
    }
    fieldRef.current?.focus();
    fieldRef.current?.setSelectionRange(edit.caret, edit.caret);
  };
  const toggleSubject = (subject: SubjectCheck) => {
    if (named.has(subject.number)) {
      commit(removeSubject(text, subject));
      return;
    }
    const field = fieldRef.current;
    const start = field && placed.current ? field.selectionStart : text.length;
    const end = field && placed.current ? field.selectionEnd : text.length;
    commit(insertAt(text, start, end, subjectInsertion(subject)));
  };

  return (
    <li ref={reveal(index)} className={cn(CARD, "grid grid-cols-[12rem_minmax(0,1fr)] gap-3 p-3")}>
      <div className="grid content-start gap-1.5">
        <ShotThumb picture={picture} label={t("鏡頭 {number} 的畫面", { number })} />
        <p className="machine text-caption text-fg-tertiary">{range}</p>
      </div>
      <div className="grid min-w-0 content-start gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <StatusMark issues={issues} />
          <h3 id={`${fieldId}-title`} className="text-data font-semibold text-fg">
            {t("鏡頭 {number}", { number })}
          </h3>
          <span className="machine min-w-0 text-caption text-fg-tertiary [overflow-wrap:anywhere]" title={t("固定的開頭：切鏡時間不會改")}>
            {shot.prefix.trim()}
          </span>
          <label id={`${fieldId}-label`} htmlFor={fieldId} className="ml-auto text-caption text-fg-tertiary">
            {t("描述（英文）")}
          </label>
        </div>
        <div role="toolbar" aria-label={t("鏡頭 {number} 的景別、角色與視角", { number })} onKeyDown={moveChipFocus} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {SHOT_SIZES.map((item, chip) => (
              <button
                key={item.id}
                type="button"
                tabIndex={chip === 0 ? 0 : -1}
                disabled={disabled}
                aria-pressed={size === item.id}
                title={t("開頭寫成「{phrase}」", { phrase: sizePhrase(item, lowerCase) })}
                onClick={() => commit(applyShotSize(text, item, lowerCase))}
                className={cn(CHIP, size === item.id ? CHIP_ON : CHIP_IDLE)}
              >
                {labels[item.id]}
              </button>
            ))}
          </div>
          {subjects.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
              {subjects.map((subject) => {
                const tag = `<Subject ${subject.number}>`;
                const inShot = named.has(subject.number);
                return (
                  <button
                    key={subject.number}
                    type="button"
                    tabIndex={-1}
                    disabled={disabled}
                    aria-pressed={inShot}
                    title={inShot ? t("從這一鏡拿掉 {subject}", { subject: tag }) : t("插入「{text}」", { text: subjectInsertion(subject) })}
                    onClick={() => toggleSubject(subject)}
                    className={cn(CHIP, inShot ? CHIP_ON : CHIP_IDLE, "machine")}
                  >
                    <UserRound aria-hidden />
                    {tag}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
            {VIEWPOINTS.map((item) => (
              <button
                key={item.id}
                type="button"
                tabIndex={-1}
                disabled={disabled}
                aria-pressed={viewpoint === item.id}
                title={t("視角寫成「{phrase}」", { phrase: item.phrase })}
                onClick={() => commit(applyViewpoint(text, item, subjects))}
                className={cn(CHIP, viewpoint === item.id ? CHIP_ON : CHIP_IDLE)}
              >
                {viewLabels[item.id]}
              </button>
            ))}
          </div>
        </div>
        <Textarea
          ref={fieldRef}
          id={fieldId}
          compact
          rows={3}
          lang="en"
          spellCheck={false}
          value={text}
          disabled={disabled}
          aria-labelledby={`${fieldId}-title ${fieldId}-label`}
          aria-describedby={issues.length > 0 ? issuesId : undefined}
          aria-invalid={issues.some(blocksSave) || undefined}
          placeholder="A close-up of <Subject 1> with long silver hair and a red ribbon, raising her staff against the night sky"
          onFocus={() => {
            placed.current = true;
          }}
          onChange={(event) => onText(event.target.value)}
          className="field-sizing-content max-h-60 min-h-[5.375rem] leading-6"
        />
        {issues.length > 0 ? (
          <ul id={issuesId} className="grid gap-1">
            {issues.map((issue) => {
              const Icon = blocksSave(issue) ? CircleX : TriangleAlert;
              return (
                <li key={issueKey(issue)} className={cn("flex min-w-0 items-start gap-1.5 text-caption animate-reveal", blocksSave(issue) ? "text-danger" : "text-warning")}>
                  <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{issueText(issue)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </li>
  );
}
