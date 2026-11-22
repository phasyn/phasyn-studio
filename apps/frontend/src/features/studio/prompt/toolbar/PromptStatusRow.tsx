// The prompt's status row, right under the editor (one 30 px line): what the checks found about the prompt — 建議 n
// (the advisor's findings, its panel with one-click fixes) and the caller's badges (the shot's plugin check: 插件 5 ✓,
// or 插件 5 · 3 項不符). Each is stated once, here, next to the text it is about; the toolbar above holds only tools.
// Narrower than its badges, the row keeps their icon, count and state and drops the words (fit.ts, STATUS_FIT_LEVELS;
// the words stay in the accessible names and tooltips).
import { useMemo, useRef, type ReactNode } from "react";
import { getLocale, t } from "@/i18n";
import { hasSlotContent } from "@/lib/dom";
import { useFitLevel } from "@/lib/useFitLevel";
import { AdvisorBadgeSlot, type AdvisorBadgeSlotProps } from "../advisorSlot";
import { STATUS_FIT_LEVELS, ToolbarFitContext, statusFit } from "./fit";

export function PromptStatusRow({ advisor, status, statusKey = "" }: { advisor: AdvisorBadgeSlotProps; status?: ReactNode; statusKey?: string }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const level = useFitLevel(rowRef, STATUS_FIT_LEVELS, `${getLocale()}\u0000${statusKey}`);
  const fit = useMemo(() => statusFit(level), [level]);
  return (
    <ToolbarFitContext value={fit}>
      <div ref={rowRef} role="group" aria-label={t("Prompt 檢查")} data-fit={level} className="flex h-[30px] min-w-0 shrink-0 items-center gap-1">
        <AdvisorBadgeSlot {...advisor} />
        {hasSlotContent(status) ? <span className="flex shrink-0 items-center">{status}</span> : null}
      </div>
    </ToolbarFitContext>
  );
}
