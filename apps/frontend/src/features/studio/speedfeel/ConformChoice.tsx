// The conform tab's choice between its edits (依動作同步, 對齊切點, 整段平移 as the fallback): one row per edit with
// what it does and its scores, or why it cannot be made; the recommended row is marked 「建議」 and chosen until another
// is; one edit is ever applied (they are never chained). Below the tables, the chosen motion edit's note.
// Look (Phasyn): form option cards (brand hairline and soft fill when chosen), native radios (arrow keys move and
// choose), the dot pops in, the rows enter one after another (Motion).
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { readyMethods, type ConformMethod, type ConformOptions } from "./choice";
import { retimeEffectText, retimeText, scoreText, shiftText, syncEffectText } from "./conformView";

const NAMES: Record<ConformMethod, () => string> = {
  retime: () => t("依動作同步"),
  cut: () => t("對齊切點"),
  shift: () => t("整段平移"),
};

/** A row's line: what the edit does with its scores, or why it cannot be made. */
function detail(options: ConformOptions, method: ConformMethod): string {
  const score = options.scores[method];
  if (method === "retime") return options.retime?.ok && score ? retimeText(options.retime.plan, score) : options.retime && !options.retime.ok ? options.retime.reason : "";
  if (method === "shift") return options.shift?.ok && score ? shiftText(options.shift.plan.lag, score) : options.shift && !options.shift.ok ? options.shift.reason : "";
  return options.cut?.ok && score ? scoreText(score) : options.cut && !options.cut.ok ? options.cut.reason : "";
}

export function MethodChoice({ options, selected, onSelect }: { options: ConformOptions; selected: ConformMethod | null; onSelect: (method: ConformMethod) => void }) {
  const name = useId();
  const recommended = options.recommendation.kind === "method" ? options.recommendation.method : null;
  const ready = readyMethods(options);
  return (
    <fieldset className="grid min-w-0 gap-1.5">
      <legend className="mb-1.5 text-caption text-fg-tertiary">{t("做法（選一種套用，不會疊加）")}</legend>
      {options.listed.map((method, index) => {
        const chosen = selected === method;
        const can = options.scores[method] !== null;
        return (
          <label
            key={method}
            ref={reveal(index)}
            className={cn(
              OPTION_CARD,
              "grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 px-2.5 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
              chosen ? OPTION_SELECTED : can ? cn("cursor-pointer", OPTION_IDLE) : "cursor-not-allowed border-line-subtle bg-canvas/30",
            )}
          >
            <input type="radio" name={name} checked={chosen} disabled={!can} onChange={() => onSelect(method)} className="sr-only" />
            <span aria-hidden className={cn("mt-0.5 grid size-3.5 place-items-center rounded-full border transition-colors duration-(--duration-fast)", chosen ? "border-brand-cyan" : "border-line-control")}>
              {chosen ? <span className="size-1.5 rounded-full bg-brand-cyan animate-pop-in" /> : null}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={cn("text-data font-medium", can ? "text-fg" : "text-fg-tertiary")}>{NAMES[method]()}</span>
              {recommended === method ? <Badge tone="action">{t("建議")}</Badge> : null}
            </span>
            <span className={cn("col-start-2 text-caption [overflow-wrap:anywhere]", can ? "text-fg-secondary" : "text-fg-tertiary")}>{detail(options, method)}</span>
          </label>
        );
      })}
      {recommended === null && ready.length > 0 ? <p className="text-caption text-fg-secondary">{t("沒有建議的做法，所以沒有預先選擇；要套用請自己選一種。")}</p> : null}
      <p className="text-caption text-fg-tertiary">{t("動作節奏相關：逐格畫面變化（灰階差）和原片的相關，−1～1，越接近 1 越一致。")}</p>
    </fieldset>
  );
}

/** What the chosen motion edit (the retime or the shift) does, after the tables. */
export function MotionNote({ options, method }: { options: ConformOptions; method: "retime" | "shift" }) {
  const retime = method === "retime" && options.retime?.ok ? options.retime.plan : null;
  const shift = method === "shift" && options.shift?.ok ? options.shift.plan : null;
  const line = retime ? retimeEffectText(retime) : shift ? syncEffectText(shift) : null;
  if (line === null) return null;
  // The retime repeats frames where a late take would have run past the clip's out point (the shift's line says it itself)
  return (
    <section aria-label={t("套用後")} className="grid gap-1 rounded-lg border border-line-subtle bg-sunken/60 p-3 text-caption text-fg-secondary animate-reveal">
      <h4 className="font-semibold text-fg-secondary">{t("套用後")}</h4>
      <p>{line}</p>
      {retime?.capped ? <p>{t("片段出點之後的畫格可能畫出原角色，不使用；改用停格補上。")}</p> : null}
      {(retime ?? shift)?.linked ? <p>{t("連結的聲音（這個 take 自己的聲音）跟著畫面一起調整，保持同步。")}</p> : null}
    </section>
  );
}
