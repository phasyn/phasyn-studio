// The row under the inline editor that exists only while there is something to act on: the last structural change with
// its undo, problems that block the render (an @ name without a reference), references the prompt never names (they
// are still sent to H3) and the length once it passes 80 % of the limit. At most three lines of findings, each at most
// two lines (the full text in the tooltip); more are one click away in the professional editor, which lists them all.
// Motion: the row and the notice rise in (reveal); state colors change on the fast duration.
import { CircleX, TriangleAlert } from "lucide-react";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { ChangeNotice } from "./ChangeNotice";
import { PROMPT_MAX_LENGTH } from "./compile";
import type { ChangeNoticeState } from "./useChangeNotice";

/** The length warning starts here (a share of the limit). */
const LENGTH_WARNING = 0.8;
const MAX_LINES = 3;

interface Finding {
  key: string;
  tone: "danger" | "warning";
  text: string;
}

function findings(problems: readonly string[], unused: readonly string[], length: number): Finding[] {
  const out: Finding[] = problems.map((text) => ({ key: `problem:${text}`, tone: "danger", text }));
  if (unused.length > 0) {
    out.push({ key: "unused", tone: "warning", text: t("{aliases} 沒有在 prompt 中使用（仍會送給 H3）", { aliases: formatList(unused.map((alias) => `@${alias}`)) }) });
  }
  if (length > PROMPT_MAX_LENGTH * LENGTH_WARNING) {
    const values = { valueCount: length.toLocaleString("en-US"), promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") };
    out.push({ key: "length", tone: "warning", text: t("{valueCount} / {promptMaxLength} 字元", values) });
  }
  return out;
}

export function ProblemsRow({
  problems,
  unused,
  length,
  notice,
  onShowAll,
}: {
  /** Problems that block the render (compilePrompt). */
  problems: readonly string[];
  /** Aliases of references the prompt never names. */
  unused: readonly string[];
  /** Characters in the prompt. */
  length: number;
  notice: ChangeNoticeState;
  /** Opens the professional editor (it lists every finding). */
  onShowAll: () => void;
}) {
  const items = findings(problems, unused, length);
  const hasNotice = Boolean((notice.error ?? "") || notice.entry);
  if (items.length === 0 && !hasNotice) return null;
  const shown = items.length > MAX_LINES ? items.slice(0, MAX_LINES - 1) : items;
  const hidden = items.length - shown.length;
  return (
    <div className="grid shrink-0 gap-1.5 animate-reveal">
      <ChangeNotice state={notice} />
      {items.length > 0 ? (
        <ul aria-label={t("Prompt 的問題與提醒")} className="grid gap-1">
          {shown.map((item) => {
            const Icon = item.tone === "danger" ? CircleX : TriangleAlert;
            return (
              <li key={item.key} title={item.text} className={cn("flex min-w-0 items-start gap-1.5 text-caption", item.tone === "danger" ? "text-danger" : "text-warning")}>
                <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{item.text}</span>
              </li>
            );
          })}
          {hidden > 0 ? (
            <li>
              <button type="button" onClick={onShowAll} className="pressable rounded-sm text-caption text-action-fg underline-offset-2 hover:underline">
                {t("還有 {count} 項，在專業編輯器查看", { count: hidden })}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
