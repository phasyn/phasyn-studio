// 專業編輯器底部的狀態列（一行）：左邊是能不能送出（擋下渲染的問題數、不符合的插件規則數或「可以送出」）與 @ 名稱對到的
// H3 標籤，右邊是統計（字元、區塊、鏡頭長度）。統計從標題列搬到這裡，標題列只留名稱。字元超過上限 90 % 時以琥珀色顯示。
// 只有 prompt 本身與插件規則都沒問題時才說「可以送出」：兩套檢查不會給出相反的結論。
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatSeconds } from "./blocks";
import { PROMPT_MAX_LENGTH } from "./compile";

export function WorkbenchStatus({
  problemCount,
  blockers,
  mapping,
  length,
  blocks,
  durationSeconds,
}: {
  problemCount: number;
  /** prompt 以外擋下渲染的原因（鏡頭的插件檢查）。 */
  blockers: readonly string[];
  /** "@Image1 → <Picture 1>" pairs of the names the prompt uses, in order. */
  mapping: readonly string[];
  length: number;
  blocks: number;
  durationSeconds: number | null;
}) {
  const mapped = mapping.join("  ");
  return (
    <footer className="flex min-h-8 shrink-0 items-center gap-x-3 border-t border-line-subtle px-4 py-1 text-caption">
      {problemCount > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-danger">
          <CircleX aria-hidden className="size-3.5" />
          {t("{problemsCount} 個問題會擋下渲染", { problemsCount: problemCount })}
        </span>
      ) : blockers.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-warning" title={blockers.map((item) => `• ${item}`).join("\n")}>
          <TriangleAlert aria-hidden className="size-3.5" />
          {t("{count} 項插件規則不符，還不能渲染", { count: blockers.length })}
          <span className="sr-only">{blockers.join(t("；"))}</span>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-success">
          <CircleCheck aria-hidden className="size-3.5" />
          {t("prompt 可以送出")}
        </span>
      )}
      <span className="machine min-w-0 flex-1 truncate text-fg-tertiary" title={mapped || undefined}>
        {mapped}
      </span>
      <dl className="flex shrink-0 items-center gap-x-3 text-fg-tertiary">
        <div className="flex gap-1">
          <dt className="sr-only">{t("字元")}</dt>
          <dd className={cn("machine", length > PROMPT_MAX_LENGTH * 0.9 ? "text-warning" : "text-fg-secondary")}>
            {t("{valueCount} / {promptMaxLength} 字元", { valueCount: length.toLocaleString("en-US"), promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") })}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="sr-only">{t("區塊")}</dt>
          <dd className="text-fg-secondary">{t("{blocksCount} 個區塊", { blocksCount: blocks })}</dd>
        </div>
        {durationSeconds !== null ? (
          <div className="flex gap-1">
            <dt>{t("鏡頭長度")}</dt>
            <dd className="machine text-fg-secondary">{t("{durationSeconds} 秒", { durationSeconds: formatSeconds(durationSeconds, 2) })}</dd>
          </div>
        ) : null}
      </dl>
    </footer>
  );
}
