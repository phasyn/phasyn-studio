// The detail area under the caption list: the selected caption's text, its In and Out in frames, its position and
// its size. Text and numbers commit on blur or with Ctrl/⌘+Enter / Enter (and with Save, through the draft registry);
// Esc puts the document value back. Text that cannot be kept stays in the field with the reason under it.
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { TimelineCaption } from "@/api/generated/contracts";
import { MAX_TEXT_CHARS } from "@/api/generated/timelineLimits";
import { Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";
import { MAX_TIMELINE_FRAMES } from "../../model";
import { NumberField, Segmented, SelectField } from "../controls/fields";
import { useTextDraft } from "../controls/useFieldDraft";
import { CAPTION_POSITIONS, CAPTION_SIZES, captionTextProblem } from "./captionEdits";

interface CaptionTextProps {
  text: string;
  /** The caption was just added: its text takes the focus, selected, ready to be typed over. */
  fresh: boolean;
  onCommit: (text: string) => boolean;
}

function CaptionText({ text, fresh, onCommit }: CaptionTextProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [field, draft] = useTextDraft<HTMLTextAreaElement>({ value: text, validate: captionTextProblem, onCommit, inputRef: input });
  useEffect(() => {
    if (!fresh) return;
    input.current?.focus();
    input.current?.select();
  }, [fresh]);
  return (
    <>
      <Textarea
        ref={field}
        compact
        rows={2}
        maxLength={MAX_TEXT_CHARS}
        aria-label={t("字幕文字")}
        title={t("字幕文字：Enter 換行，Ctrl／⌘＋Enter 或離開欄位套用")}
        value={draft.text}
        className="min-h-0 resize-none border-line-strong"
        aria-invalid={draft.error ? true : undefined}
        aria-describedby={draft.error ? `${id}-error` : undefined}
        onChange={(event) => draft.setText(event.target.value)}
        onBlur={draft.commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            draft.commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            draft.revert();
          }
        }}
      />
      {draft.error ? (
        <p id={`${id}-error`} role="alert" className="text-caption text-danger">
          {t("{error}（Esc 還原）", { error: draft.error })}
        </p>
      ) : null}
    </>
  );
}

/** A short label in front of its control; a refused value's reason takes the line under the pair. */
function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <span className="shrink-0 text-caption text-fg-tertiary">{label}</span>
      {children}
    </div>
  );
}

export interface CaptionDetailProps {
  caption: TimelineCaption;
  /** The caption was just added (see CaptionText). */
  fresh: boolean;
  /** Commits a change of the caption; false when the editor refused it. */
  onChange: (change: Partial<TimelineCaption>) => boolean;
}

export function CaptionDetail({ caption, fresh, onChange }: CaptionDetailProps) {
  return (
    // In a panel too short for it the detail area gives way and scrolls: the list above always keeps a row
    <section aria-label={t("字幕內容")} className="grid min-h-0 content-start gap-1.5 overflow-y-auto border-t border-line-subtle bg-canvas/40 p-2">
      <CaptionText text={caption.text} fresh={fresh} onCommit={(text) => onChange({ text })} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pair label={t("入點")}>
          <NumberField
            label={t("字幕入點（影格）")}
            value={caption.start_frame}
            min={0}
            max={caption.end_frame - 1}
            suffix={t("影格")}
            hint={t("字幕從這個影格開始")}
            onCommit={(start_frame) => onChange({ start_frame })}
          />
        </Pair>
        <Pair label={t("出點")}>
          <NumberField
            label={t("字幕出點（影格）")}
            value={caption.end_frame}
            min={caption.start_frame + 1}
            max={MAX_TIMELINE_FRAMES}
            suffix={t("影格")}
            hint={t("字幕在這個影格之前結束")}
            onCommit={(end_frame) => onChange({ end_frame })}
          />
        </Pair>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pair label={t("位置")}>
          <SelectField label={t("字幕位置")} value={caption.position} options={CAPTION_POSITIONS} onChange={(position) => void onChange({ position })} className="w-28" />
        </Pair>
        <Pair label={t("大小")}>
          <Segmented label={t("字幕字級")} value={caption.size} options={CAPTION_SIZES} onChange={(size) => void onChange({ size })} />
        </Pair>
      </div>
    </section>
  );
}
