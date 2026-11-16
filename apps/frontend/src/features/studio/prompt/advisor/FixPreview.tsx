// 套用修正或改寫前的預覽：逐行差異（刪除／新增／未變更），使用者按「套用」才會改字。展開時 reveal。
import { Check, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { diffHunks, diffLines, diffStats, type DiffLine } from "@/lib/textDiff";
import { t } from "@/i18n";

const LINE_STYLE: Record<DiffLine["kind"], { marker: string; label: string; className: string }> = {
  del: { marker: "−", label: t("刪除："), className: "bg-danger/10 text-fg" },
  add: { marker: "+", label: t("新增："), className: "bg-success/10 text-fg" },
  same: { marker: " ", label: "", className: "text-fg-tertiary" },
};

export interface FixPreviewProps {
  id: string;
  label: string;
  before: string;
  after: string;
  /** 不能套用的原因（例如編輯器停用）；null＝可以套用。 */
  blockedReason: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FixPreview({ id, label, before, after, blockedReason, onConfirm, onCancel }: FixPreviewProps) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const hunks = useMemo(() => diffHunks(lines, 1), [lines]);
  const stats = diffStats(lines);
  const unchanged = before === after;
  const blocked = unchanged ? t("這個改動不會改變目前的文字") : blockedReason;
  return (
    <div id={id} role="group" aria-label={t("預覽改動：{label}", { label })} className="grid gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-2 animate-reveal">
      <p className="flex flex-wrap items-center gap-x-2 text-caption text-fg-secondary">
        <span className="font-medium text-fg">{label}</span>
        <span className="machine text-success">+{stats.added}</span>
        <span className="machine text-danger">−{stats.removed}</span>
        <span>{t("行")}</span>
      </p>
      {unchanged ? (
        <p className="text-caption text-fg-tertiary">{t("目前的文字已經符合，不需要修改。")}</p>
      ) : (
        <div role="region" className="max-h-72 overflow-auto rounded-md border border-line-subtle bg-sunken py-1 text-caption leading-5" tabIndex={0} aria-label={t("修改前後的差異")}>
          {hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex}>
              {hunk.skipped > 0 ? <p className="px-2 text-fg-disabled">{t("⋯ 略過 {skipped} 行未變更", { skipped: hunk.skipped })}</p> : null}
              {hunk.lines.map((line, lineIndex) => {
                const style = LINE_STYLE[line.kind];
                return (
                  <p key={lineIndex} className={cn("flex gap-1.5 px-2 whitespace-pre-wrap [overflow-wrap:anywhere]", style.className)}>
                    <span aria-hidden className="machine w-3 shrink-0 select-none">
                      {style.marker}
                    </span>
                    <span className="min-w-0">
                      {style.label ? <span className="sr-only">{style.label}</span> : null}
                      {line.text || " "}
                    </span>
                  </p>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {blocked && !unchanged ? <span className="mr-auto text-caption text-fg-tertiary">{blocked}</span> : null}
        <Button size="sm" variant="quiet" icon={<X aria-hidden />} onClick={onCancel} autoFocus={Boolean(blocked)}>
          {t("取消")}
        </Button>
        <Button size="sm" variant="primary" icon={<Check aria-hidden />} disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={onConfirm} autoFocus={!blocked}>
          {t("套用")}
        </Button>
      </div>
    </div>
  );
}
