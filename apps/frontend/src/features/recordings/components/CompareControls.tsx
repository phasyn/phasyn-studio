// 「加入比較」：收集最多 8 筆 recording，連到 /comparisons?ids=…；滿額時說明原因。
import { GitCompareArrows, ListPlus, ListX } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { comparisonHref, MAX_COMPARE, useCompareSelection } from "../model/compareStore";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function CompareToggle({ recordingId }: { recordingId: string }) {
  const reasonId = useId();
  const compare = useCompareSelection();
  const included = compare.has(recordingId);
  const blocked = !included && compare.full;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        aria-pressed={included}
        icon={included ? <ListX aria-hidden /> : <ListPlus aria-hidden />}
        onClick={() => { compare.toggle(recordingId); }}
        disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        className="aria-pressed:border-brand-blue/60 aria-pressed:bg-brand-gradient-soft pointer-coarse:min-h-11"
      >
        {included ? t("移出比較") : t("加入比較")}
      </Button>
      {blocked ? (
        <span id={reasonId} className="text-caption text-warning">
          {t("比較清單已滿 {maxCompare} 筆，先移除一筆。", { maxCompare: MAX_COMPARE })}
        </span>
      ) : null}
    </span>
  );
}

/** 比較清單摘要：筆數與連結；不足 2 筆時說明還差幾筆。 */
export function CompareTray({ className }: { className?: string }) {
  const compare = useCompareSelection();
  const count = compare.ids.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-data", className)}>
      <span className="inline-flex items-center gap-2 text-fg-secondary">
        <span>
          <T source={"比較清單 <0>{count}</0>/{maxCompare}"} values={{ count, maxCompare: MAX_COMPARE }} slots={[<span key="slot-0" className="machine" />]} />
        </span>
        {/* 已選筆數的格位（純裝飾；數字已在旁邊） */}
        <span aria-hidden className="flex items-center gap-0.5">
          {Array.from({ length: MAX_COMPARE }, (_, index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 w-2.5 rounded-full transition-colors duration-(--duration-base) ease-standard",
                index < count ? "bg-linear-to-r from-brand-cyan via-brand-blue to-brand-violet" : "bg-line",
              )}
            />
          ))}
        </span>
      </span>
      {count >= 2 ? (
        <Link to={comparisonHref(compare.ids)} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "pressable no-underline pointer-coarse:min-h-11")}>
          <GitCompareArrows aria-hidden />
          {t("開啟比較")}
        </Link>
      ) : (
        <span className="text-caption text-fg-tertiary">{count === 0 ? t("在明細或列表勾選「加入比較」，至少 2 筆") : t("再加入 1 筆即可比較")}</span>
      )}
      {count > 0 ? (
        <Button size="sm" variant="quiet" onClick={compare.clear} className="pointer-coarse:min-h-11">
          {t("清空")}
        </Button>
      ) : null}
    </div>
  );
}
