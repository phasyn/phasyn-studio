// SRT import and export of the sequence's captions. An import is parsed completely, inside the document's bounds,
// before any caption of the project changes: one block that cannot be read refuses the whole file.
import type { TimelineCaption } from "@/api/generated/contracts";
import { MAX_CAPTIONS, MAX_SEQUENCE_FRAMES, MAX_SRT_CHARS, MAX_TEXT_CHARS } from "@/api/generated/timelineLimits";
import { t } from "@/i18n";
import { localId } from "../model/project";

/** An SRT time (HH:MM:SS,mmm; a dot is accepted too) in milliseconds; null when the text is not one. */
function milliseconds(value: string): number | null {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value.trim());
  if (!match) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

/** The captions of an SRT text, at the bottom in the medium size. Throws with the reason when the text is not usable. */
export function parseSrt(text: string, fps: number): TimelineCaption[] {
  if (text.length > MAX_SRT_CHARS) throw new Error(t("字幕檔不得超過 1 MB"));
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/);
  if (blocks.length > MAX_CAPTIONS || !text.trim()) throw new Error(t("字幕檔需包含 1–500 段字幕"));
  return blocks.map((block, index) => {
    const lines = block.split("\n");
    // The counter line is optional
    if (/^\d+$/.test(lines[0] ?? "")) lines.shift();
    const times = (lines.shift() ?? "").split(/\s+-->\s+/);
    const start = (times[0] != null && times[0] !== "") ? milliseconds(times[0]) : null;
    const end = (times[1] != null && times[1] !== "") ? milliseconds(times[1]) : null;
    const content = lines.join("\n").trim();
    const first = start === null ? -1 : Math.round((start * fps) / 1000);
    const last = end === null ? -1 : Math.round((end * fps) / 1000);
    if (times.length !== 2 || first < 0 || last <= first || last > MAX_SEQUENCE_FRAMES || !content || content.length > MAX_TEXT_CHARS) {
      throw new Error(t("第 {index} 段字幕的時間或文字格式無效", { index: index + 1 }));
    }
    return { caption_id: localId("caption"), start_frame: first, end_frame: last, text: content, position: "bottom", size: "medium" };
  });
}

function srtTime(frame: number, fps: number): string {
  const ms = Math.round((frame * 1000) / fps);
  const part = (value: number, digits: number) => String(value).padStart(digits, "0");
  return `${part(Math.floor(ms / 3600000), 2)}:${part(Math.floor(ms / 60000) % 60, 2)}:${part(Math.floor(ms / 1000) % 60, 2)},${part(ms % 1000, 3)}`;
}

/** The captions as SRT text, in time order. */
export function toSrt(captions: TimelineCaption[], fps: number): string {
  const blocks = [...captions]
    .sort((a, b) => a.start_frame - b.start_frame)
    .map((caption, index) => `${String(index + 1)}\n${srtTime(caption.start_frame, fps)} --> ${srtTime(caption.end_frame, fps)}\n${caption.text}`);
  return `${blocks.join("\n\n")}\n`;
}

/** Saves the captions as sequence.srt through the browser's download. */
export function downloadSrt(captions: TimelineCaption[], fps: number): void {
  const url = URL.createObjectURL(new Blob([toSrt(captions, fps)], { type: "application/x-subrip;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "sequence.srt";
  link.click();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
}
