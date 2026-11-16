// The audio meters beside the timeline: the output of the Program monitor as a left and a right bar with peak hold, a
// dB scale, a clipping lamp per channel that stays lit until it is clicked, and the loudest peak so far. They move
// only while the sequence plays (and for the moment the bars need to fall back afterwards).
import { LevelMeter, LevelScale } from "@/components/workbench/LevelMeter";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatDb } from "./mixer/decibels";
import { useLevelMeters } from "./mixer/useLevelMeters";

const TICKS: readonly number[] = [0, -6, -12, -24, -48];
/** One column for the scale, one per bar. */
const COLUMNS = "grid grid-cols-[0.75rem_minmax(0,1fr)_minmax(0,1fr)] gap-0.5";

function Lamp({ lit }: { lit: boolean }) {
  return <span aria-hidden className={cn("h-1.5 rounded-full transition-colors duration-(--duration-fast)", lit ? "bg-danger" : "bg-line-strong")} />;
}

export function AudioMeters() {
  const { leftRef, rightRef, clipped, loudest, reset } = useLevelMeters();
  const over = clipped.left || clipped.right;
  return (
    <section aria-label={t("音訊表")} data-keep-focus="" className="flex min-h-0 min-w-0 flex-col gap-1 rounded-xl border border-line-subtle bg-surface px-1 py-1.5 shadow-edge">
      <button
        type="button"
        onClick={reset}
        aria-label={over ? t("輸出曾經削波；按一下清除削波指示") : t("削波指示：沒有削波")}
        title={over ? t("輸出曾經削波（達到 0 dBFS）；按一下清除") : t("削波指示：輸出達到 0 dBFS 時亮起，按一下清除")}
        className={cn(COLUMNS, "pressable h-4 shrink-0 items-center rounded-sm hover:bg-raised")}
      >
        <span aria-hidden />
        <Lamp lit={clipped.left} />
        <Lamp lit={clipped.right} />
      </button>
      <div className={cn(COLUMNS, "min-h-0 flex-1")} title={t("輸出電平（dBFS）")}>
        <LevelScale ticks={TICKS} />
        <LevelMeter ref={leftRef} ticks={TICKS} />
        <LevelMeter ref={rightRef} ticks={TICKS} />
      </div>
      <div aria-hidden className={cn(COLUMNS, "shrink-0 text-center text-[10px] leading-3 text-fg-tertiary")}>
        <span />
        <span>L</span>
        <span>R</span>
      </div>
      <button
        type="button"
        onClick={reset}
        aria-label={t("輸出最大峰值 {value} dBFS；按一下重設", { value: formatDb(loudest) })}
        title={t("輸出的最大峰值（dBFS）；按一下重設")}
        className={cn("pressable machine h-5 shrink-0 rounded-sm text-center text-[10px] leading-5 whitespace-nowrap hover:bg-raised", over ? "text-danger" : "text-fg-secondary")}
      >
        {formatDb(loudest)}
      </button>
    </section>
  );
}
