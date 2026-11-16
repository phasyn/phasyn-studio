// Save state pill of the toolbar: saved / unsaved / saving / failed (with retry) / conflict, and the revision. A state
// change fades in briefly instead of flickering in the corner of the eye. The pill is not a live region (it would read
// every save cycle while typing); a hidden status line announces only failures and recovery (saveAnnouncement.ts).
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorText } from "@/lib/errors";
import { useChangeFade } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { SaveStatus } from "./document/docReducer";
import { initialAnnouncement, nextAnnouncement } from "./saveAnnouncement";
import { useStudioShell } from "./StudioShellContext";
import { t } from "@/i18n";

export function SaveIndicator() {
  const { doc, revision, saveNow } = useStudioShell();
  const specs: Record<SaveStatus, { icon: ReactNode; text: string; className: string }> = {
    saved: { icon: <Check aria-hidden />, text: t("已儲存"), className: "text-fg-tertiary" },
    dirty: { icon: <span aria-hidden className="size-1.5 rounded-full bg-warning" />, text: t("尚未儲存"), className: "text-fg-secondary" },
    saving: { icon: <LoaderCircle aria-hidden className="animate-spin" />, text: t("儲存中…"), className: "text-info" },
    error: { icon: <TriangleAlert aria-hidden />, text: t("儲存失敗"), className: "text-danger" },
    conflict: { icon: <TriangleAlert aria-hidden />, text: t("版本衝突"), className: "text-warning" },
  };
  const spec = specs[doc.status];
  const fade = useChangeFade<HTMLSpanElement>(doc.status);
  const detail = doc.status === "error" ? errorText(doc.error) : undefined;
  // Derived from the previous render's status (no effect): updated while rendering when the status changes
  const [announcement, setAnnouncement] = useState(() => initialAnnouncement(doc.status));
  const next = nextAnnouncement(announcement, doc.status);
  if (next !== announcement) setAnnouncement(next);
  return (
    <span
      title={detail}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line-subtle bg-surface/60 px-2.5 text-caption whitespace-nowrap transition-colors duration-(--duration-base) [&_svg]:size-3.5",
        spec.className,
      )}
    >
      <span ref={fade} className="inline-flex items-center gap-1.5">
        {spec.icon}
        {spec.text}
      </span>
      <span className="machine text-fg-tertiary">{`r${revision}`}</span>
      {doc.status === "error" ? (
        <button type="button" onClick={saveNow} className="pressable rounded-full px-1.5 text-action-fg hover:bg-raised active:bg-sunken">
          {t("重試")}
        </button>
      ) : null}
      <span role="status" className="sr-only">
        {next.message}
      </span>
    </span>
  );
}
