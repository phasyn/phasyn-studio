// 渲染進度的顯示元件：階段矩陣格內的細進度條、佇列項目的分段進度條，以及 DiT 逐步進度卡（render/DitProgress.tsx，
// 從這裡一併匯出：其他畫面一直由這個檔案取用這三個元件）。
// 只畫有證據的數字：進度條要有總步數與逐步訊號；推導值標「推導」，未量測就寫未量測。
// 外觀（Phasyn）：進度＝品牌漸層（線性移動，不用彈簧）；執行中的段加 shimmer 高光；完成、失敗等狀態另以文字與圖示表示
// （漸層不代表成功）。表格內的細進度條不加動畫（資料密集區保持俐落）。
import type { CSSProperties } from "react";
import type { WireRun } from "@/api/types";
import { cn } from "@/lib/cn";
import { SHIMMER } from "@/components/ui/look";
import { pipelineSegments, progressHeadline, runActivity, SOURCE_LABELS, totalText, type BranchView, type ProviderLookup } from "../model/progress";
import { StepMeter } from "./render/StepMeter";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export { DitProgressPanel } from "./render/DitProgress";

/**
 * 分段進度條的連續漸層：每段只顯示整條漸層對應位置的那一片（background-size／position），所有完成的段拼起來是同一條
 * 青→藍→紫。start、size＝這一段在整條上的起點與寬度（0–1）。
 */
function gradientSlice(start: number, size: number): CSSProperties {
  if (size >= 1) return {};
  return { backgroundSize: `${100 / size}% 100%`, backgroundPosition: `${(start / (1 - size)) * 100}% 0` };
}

/** 階段矩陣中「DiT 去噪」格的進度（只在執行中顯示）。 */
export function StepCellProgress({ view }: { view: BranchView }) {
  const { progress } = view;
  if (view.phase === "awaiting_record") {
    const text = t("等待紀錄上報・共 {progress} 步", { progress: totalText(progress) });
    return (
      <span className="mt-0.5 block truncate text-[11px] text-fg-tertiary" title={text}>
        {text}
      </span>
    );
  }
  if (view.phase !== "live") return null;
  if (progress.completed === null) {
    const text = t("共 {progress} 步・等待逐步事件", { progress: totalText(progress) });
    return (
      <span className="mt-0.5 block truncate text-[11px] text-fg-tertiary" title={t("{text}（{detail}）", { text, detail: SOURCE_LABELS.none.detail })}>
        {text}
      </span>
    );
  }
  return (
    <span className="mt-1 grid min-w-0 gap-0.5" title={t("{view}（{short}：{detail}）", { view: progressHeadline(view), short: SOURCE_LABELS[progress.source].short, detail: SOURCE_LABELS[progress.source].detail })}>
      <StepMeter progress={progress} tone="info" label={t("DiT 去噪進度")} />
      <span className="machine truncate text-[11px] text-fg-secondary">{progressHeadline(view)}</span>
    </span>
  );
}

/** 各狀態的段：完成＝漸層片段（進度）；執行中＝淡底＋依步數填滿的漸層；失敗、取消、中斷用狀態色；未開始是軌道色。 */
const SEGMENT_TONE: Record<string, string> = {
  succeeded: "bg-brand-gradient",
  running: "bg-line",
  waiting: "bg-line",
  pending: "bg-line-subtle",
  failed: "bg-danger/80",
  cancelled: "bg-warning/60",
  interrupted: "bg-warning/60",
  skipped: "bg-line-subtle",
  unknown: "bg-line-subtle",
};

/**
 * 佇列項目的分段進度條：每段＝pipeline 的一個步驟（等寬，不代表耗時），分支之間留較寬的間隔；完成的段拼成一條連續的
 * 品牌漸層，執行中的 DiT 段依實測步數填滿（沒有逐步證據時整段淡淡地亮著並掃過 shimmer，只表示「進行中」）。
 * counts＝false：不列「已完成步驟 n／m」（呼叫端已在別處顯示同一個計數時）。
 */
export function RunQueueProgress({ run, views, noun, lookup, counts = true }: { run: WireRun; views: readonly BranchView[]; noun: string; lookup?: ProviderLookup; counts?: boolean }) {
  const groups = pipelineSegments(run, lookup);
  const activity = runActivity(run, views, noun, lookup);
  const fractions = new Map(views.map((view) => [view.stepId, view.state === "running" ? view.progress.fraction : null]));
  return (
    <span className="grid gap-1">
      <span aria-hidden className="flex h-1.5 gap-1">
        {groups.map((group, groupIndex) => (
          <span key={group[0]?.stepId ?? "empty"} className="flex min-w-0 flex-1 gap-px">
            {group.map((segment, index) => {
              const fraction = fractions.get(segment.stepId) ?? null;
              const size = 1 / (groups.length * group.length);
              const slice = gradientSlice((groupIndex + index / group.length) / groups.length, size);
              const running = segment.state === "running";
              return (
                <span
                  key={segment.stepId}
                  className={cn("relative min-w-0 flex-1 overflow-hidden rounded-full", SEGMENT_TONE[segment.state] ?? SEGMENT_TONE.pending)}
                  style={segment.state === "succeeded" ? slice : undefined}
                >
                  {running ? (
                    <span
                      className={cn("absolute inset-0 bg-brand-gradient transition-[clip-path] duration-(--duration-base) ease-linear", SHIMMER, fraction === null && "opacity-45")}
                      style={{ ...slice, clipPath: fraction === null ? undefined : `inset(0 ${(1 - fraction) * 100}% 0 0)` }}
                    />
                  ) : null}
                </span>
              );
            })}
          </span>
        ))}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-caption text-fg-tertiary">
        <span className="min-w-0 flex-1 truncate" title={activity.text || undefined}>
          {activity.text || t("準備中")}
        </span>
        {counts ? (
          <span className="machine shrink-0" title={t("已完成的 pipeline 步驟")}>
            <T source={"<0>已完成步驟 </0>{done}／{total}"} values={{ done: activity.done, total: activity.total }} slots={[<span className="sr-only" />]} />
          </span>
        ) : null}
      </span>
    </span>
  );
}
