import { CircleAlert, CircleCheck, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { TOOL_BUTTON } from "@/components/ui/look";
import type { ChangeNoticeState } from "./useChangeNotice";
import { t } from "@/i18n";

/** 最近一次結構性改動的結果（可復原）或被拒絕的原因。出現時 rise-in。 */
export function ChangeNotice({ state, className }: { state: ChangeNoticeState; className?: string }) {
  if (!(state.error != null && state.error !== "") && !state.entry) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-1.5 text-caption animate-rise-in",
        (state.error != null && state.error !== "") ? "border-danger/40 bg-danger/8 text-danger" : "border-line-subtle bg-canvas/60 text-fg-secondary",
        className,
      )}
    >
      {(state.error != null && state.error !== "") ? <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />}
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {state.error ?? state.entry?.message}
        {!(state.error != null && state.error !== "") && state.entry && !state.canUndo ? <span className="text-fg-tertiary">{t("（之後又修改過，無法復原）")}</span> : null}
      </p>
      {!(state.error != null && state.error !== "") && state.entry ? (
        <Button size="sm" variant="quiet" className="min-h-6 px-1.5" icon={<Undo2 aria-hidden />} onClick={state.undo} disabled={!state.canUndo}>
          {t("復原")}
        </Button>
      ) : null}
      <button type="button" onClick={state.dismiss} aria-label={t("關閉提示")} className={cn(TOOL_BUTTON, "size-6 text-fg-tertiary")}>
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
