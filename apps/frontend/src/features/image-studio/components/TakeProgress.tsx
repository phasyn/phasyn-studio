// 生成中的 take：各階段狀態、DiT 步數（中間預覽的步數，或 recorder 的逐步紀錄）、已執行時間、中間預覽（標示
// 「預覽（非最終結果）」）、取消 run（先確認範圍：整個批次一起停止）。預覽以雙緩衝顯示：新的預覽解碼完成才換上，
// DiT 結束後預覽檔被刪除時保留最後一張直到最終圖片出現。
// The cancel confirmation belongs to the viewer (Viewer.tsx), not to this view: the view leaves as soon as the run ends,
// and the confirmation has to stay to show its result.
import { Ban, LoaderCircle } from "lucide-react";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { WireRun } from "@/api/types";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { Button } from "@/components/ui/button";
import { Stepper } from "@/components/workbench/Stepper";
import { CircularProgress } from "@/components/common/CircularProgress";
import { HUD_CHIP } from "@/components/ui/look";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { cn } from "@/lib/cn";
import { elapsedMs, formatElapsed, useNow } from "@/lib/time";
import { useTakeProgress } from "../hooks/useTakeProgress";
import { useImageStudio } from "../imageStudioContext";
import { PREVIEW_LABELS } from "../model/constants";
import { stageSteps } from "../model/flow";
import { takePreview } from "../model/outcome";
import { takeSnapshot } from "../model/params";
import { storedImageDeclaration } from "../model/declaredImage";
import { takeActivity } from "../model/progress";
import type { RunStepPreview, StudioImageTake } from "../types";
import { t } from "@/i18n";

interface Frame {
  url: string;
  step: number;
  total: number;
  note: string | null;
}

/**
 * 雙緩衝預覽：新的一張解碼完成才換上（不閃）；讀取失敗（步驟剛結束的 404、Node 已刪除預覽檔）時保留上一張。
 * 步驟結束後 run 狀態不再帶 preview：保留最後一張並改標「最後一張預覽」，直到最終圖片出現（由呼叫端切換）。
 */
function PreviewFrame({ current, waiting }: { current: RunStepPreview | null; waiting: string }) {
  const [shown, setShown] = useState<Frame | null>(null);
  const pending = current && current.url !== shown?.url ? current : null;
  // 步驟還在執行（run 狀態仍帶 preview）就是「預覽」；步驟結束後顯示的是最後一張
  const live = current !== null;
  const label = shown ? t("{value}（非最終結果）・第 {step}／{total} 步{value2}", { value: live ? t("預覽") : t("最後一張預覽"), step: shown.step, total: shown.total, value2: (shown.note != null && shown.note !== "") ? t("・{note}", { note: shown.note }) : "" }) : t("預覽（非最終結果）");
  return (
    <>
      {shown ? <img key={shown.url} src={shown.url} alt={label} draggable={false} className="absolute inset-0 size-full object-contain animate-fade-in" /> : null}
      {pending ? (
        <img
          key={pending.url}
          src={pending.url}
          alt=""
          aria-hidden
          hidden
          onLoad={() => { setShown({ url: pending.url, step: pending.step, total: pending.total, note: pending.note }); }}
          onError={() => undefined}
        />
      ) : null}
      <span className={cn(HUD_CHIP, "absolute top-2.5 left-2.5 max-w-[calc(100%-4.5rem)] truncate border-warning/45 text-warning")} title={label}>
        {label}
      </span>
      {!shown ? (
        <span className="max-w-[44ch] px-4 text-center text-caption text-fg-tertiary">{current ? t("讀取預覽…") : waiting}</span>
      ) : !live ? (
        <span className={cn(HUD_CHIP, "absolute bottom-2.5 left-2.5 max-w-[calc(100%-1.25rem)] truncate text-fg-secondary")}>{t("等待最終圖片…")}</span>
      ) : null}
    </>
  );
}

export interface TakeProgressProps {
  take: StudioImageTake;
  /** Asks to confirm cancelling the run; `opener` is the button that asked (focus returns to it while it is there). */
  onCancel: (run: WireRun, opener: HTMLElement) => void;
  /** The view is leaving the page (its run ended) while it holds keyboard focus: the viewer takes focus instead. */
  onFocusLeave: () => void;
}

export function TakeProgress({ take, onCancel, onFocusLeave }: TakeProgressProps) {
  const { runs, lookup } = useImageStudio();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusLeaves = useEffectEvent(onFocusLeave);
  // React runs this cleanup before it removes the view from the page, so focus inside it (the cancel button when the
  // run ends) can still be seen and handed to the viewer instead of falling to the page.
  useLayoutEffect(() => {
    const node = rootRef.current;
    return () => {
      if (node?.contains(document.activeElement) === true) focusLeaves();
    };
  }, []);
  const run = runs.get(take.run_id);
  const { stages, dit } = useTakeProgress(run, take, lookup);
  const preview = takePreview(run, take);
  const activity = takeActivity(stages, preview, dit);
  const running = run?.state === "running";
  const now = useNow(running);
  const snapshot = takeSnapshot(take);
  const declaration = storedImageDeclaration(take.params_snapshot);
  const previewMode = declaration && !declaration.controls.includes("preview") ? "off" : snapshot?.preview.mode ?? "off";
  const steps = stageSteps(stages);
  const stepCount = preview && preview.total > 0 ? { step: preview.step, total: preview.total } : dit?.total != null && dit.current !== null ? { step: dit.current, total: dit.total } : null;
  return (
    <div ref={rootRef} className="grid size-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2.5 p-3 animate-fade-in">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="inline-flex min-w-0 items-center gap-1.5 text-data font-medium text-fg">
            <LoaderCircle aria-hidden className="size-4 shrink-0 text-brand-cyan animate-spin" />
            <span className="truncate">{activity.text || t("準備中")}</span>
          </span>
          <span className="machine text-caption text-fg-tertiary">{t("已執行 {formatElapsed}", { formatElapsed: formatElapsed(run ? elapsedMs(run.created_at, null, now) : null) })}</span>
          {run ? (
            <span className="ml-auto">
              <Button size="sm" variant="danger" icon={<Ban aria-hidden />} onClick={(event) => { onCancel(run, event.currentTarget); }}>
                {t("取消生成")}
              </Button>
            </span>
          ) : null}
        </div>
        <ProgressTrack
          value={activity.fraction}
          tone="running"
          label={declaration ? t("生成進度") : t("DiT 去噪進度")}
          valueText={activity.fraction !== null ? `${String(Math.round(activity.fraction * 100))}%` : activity.text || t("準備中")}
        />
        {steps.length > 0 ? (
          <Stepper steps={steps} label={t("這張圖片的階段")} size="sm" />
        ) : (
          <p className="text-caption text-fg-tertiary">{run ? t("讀取 run 狀態…") : t("等待 run 狀態（每 2 秒讀取一次）…")}</p>
        )}
      </div>
      <GeneratingFrame active={running} progress={activity.fraction} className="min-h-0">
        <div className="relative grid size-full min-h-0 place-items-center overflow-hidden rounded-[inherit] bg-stage">
          {previewMode === "off" && !preview ? (
            <p className="max-w-[44ch] px-4 text-center text-caption text-fg-tertiary">{t("這次沒有開啟中間預覽；完成後顯示最終圖片。")}</p>
          ) : (
            <PreviewFrame key={take.take_id} current={preview} waiting={declaration ? t("等待元件送出預覽…") : t("{previewMode}・每 {value} 步；DiT 開始去噪後出現（元件不支援預覽時不會出現）", { previewMode: PREVIEW_LABELS[previewMode], value: snapshot?.preview.every ?? "?" })} />
          )}
          {stepCount ? (
            <span className="material-hud absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-white/10 py-1 pr-2.5 pl-1">
              <CircularProgress value={stepCount.step / stepCount.total} label={declaration ? t("生成步數") : t("DiT 步數")} size={22} />
              <span className="machine text-caption text-fg">{t("{step}／{total}", { step: stepCount.step, total: stepCount.total })}</span>
            </span>
          ) : null}
        </div>
      </GeneratingFrame>
      {dit?.typicalMs !== null && dit?.typicalMs !== undefined ? (
        <p className="machine text-caption text-fg-tertiary">{t("每步（中位數）{typicalMs}・{value}", { typicalMs: formatElapsed(dit.typicalMs), value: dit.source === "step" ? t("實測") : t("推導") })}</p>
      ) : (
        <span />
      )}
    </div>
  );
}
