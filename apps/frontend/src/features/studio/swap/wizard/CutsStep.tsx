// Wizard step 3: cut detection on the source video (media probe run), its parameters and the result.
import { Ban, CircleCheck, Cpu, LoaderCircle, ScanSearch, Settings2, TriangleAlert } from "lucide-react";
import { useId } from "react";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { SHIMMER } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/time";
import { Fact, Facts, NoteList, NumberField, Section } from "../fields";
import { type ProbeSupport, SCENE_DEFAULTS, SCENE_LIMITS, SCENE_QUICK_CUTS, type SceneParameters } from "../probe";
import type { DetectionView } from "../useCutDetection";
import type { SwapDraftApi } from "../useSwapDraft";
import { SKIP_DETECTION_LABEL, type WizardDerived } from "../wizardModel";
import { Label } from "./Label";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function CutsStep({
  api,
  derived,
  detection,
  probe,
  support,
  blockedReason,
  notice,
  cancelling,
  onDetect,
  onCancel,
}: {
  api: SwapDraftApi;
  derived: WizardDerived;
  detection: DetectionView;
  probe: ComponentDescriptor | null;
  support: ProbeSupport;
  /** 不能送出偵測的其他原因（沒有來源、主控正在跑別的 run…）。 */
  blockedReason: string | null;
  /** 取消偵測的回應（未受理或失敗）。 */
  notice: string | null;
  cancelling: boolean;
  onDetect: () => void;
  onCancel: () => void;
}) {
  const { draft, update } = api;
  const id = useId();
  const running = detection.status === "running" || detection.status === "submitting";
  const now = useNow(detection.status === "running");
  const elapsed = detection.status === "running" && now !== null ? Math.max(0, Math.round((now - Date.parse(detection.createdAt)) / 1000)) : null;
  const inRange = (derived.detectedCuts ?? []).filter((cut) => cut > draft.startSeconds && cut < (draft.endSeconds ?? derived.facts?.duration_seconds ?? Infinity));
  return (
    <div className="grid gap-5">
      <p className="text-caption text-fg-tertiary">
        {t("在原影片的切鏡處分段，接縫通常看不出來；同一個鏡頭被切開時，前後兩段各自生成（ref2va 不能接首幀），頭髮、服裝細節或光線可能跳動。偵測用 DiT 所在 Node 的媒體探測元件跑一個步驟的 run（只讀影片，不用 GPU）。")}
      </p>
      <Section title={t("媒體探測元件")} icon={<Cpu />}>
        <Facts className="text-caption">
          <Fact label={t("元件")}>{probe ? <code className="machine">{probe.component_id}</code> : t("找不到 media.probe")}</Fact>
          <Fact label={t("狀態")}>{probe ? `${probe.state}${support.scenes ? t("・已宣告切鏡偵測（scenes）") : t("・目錄還沒宣告 scenes")}` : "—"}</Fact>
        </Facts>
        <NoteList tone="warning" icon={<TriangleAlert aria-hidden />} items={[support.reason, support.warning].filter((item): item is string => Boolean(item))} />
      </Section>
      <Section title={t("參數")} icon={<Settings2 />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-threshold`} hint={t("{min}–{max}；越小切得越多", { min: SCENE_LIMITS.threshold.min, max: SCENE_LIMITS.threshold.max })}>
              {t("切鏡門檻")}
            </Label>
            <NumberField id={`${id}-threshold`} value={draft.scene.threshold} min={SCENE_LIMITS.threshold.min} max={SCENE_LIMITS.threshold.max} onCommit={(value) => update({ scene: { ...draft.scene, threshold: value ?? draft.scene.threshold } })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-gap`} hint={t("兩個切鏡之間至少相隔（秒）")}>
              {t("最短間隔")}
            </Label>
            <NumberField id={`${id}-gap`} value={draft.scene.min_gap_seconds} min={SCENE_LIMITS.min_gap_seconds.min} max={SCENE_LIMITS.min_gap_seconds.max} onCommit={(value) => update({ scene: { ...draft.scene, min_gap_seconds: value ?? draft.scene.min_gap_seconds } })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-caption text-fg-tertiary" role="group" aria-label={t("常用的切鏡設定")}>
          {t("常用：")}
          {(
            [
              [SCENE_DEFAULTS, t("一般影片（{threshold}／{gap} 秒）", { threshold: SCENE_DEFAULTS.threshold, gap: SCENE_DEFAULTS.min_gap_seconds })],
              [SCENE_QUICK_CUTS, t("快剪動畫（{threshold}／{gap} 秒）", { threshold: SCENE_QUICK_CUTS.threshold, gap: SCENE_QUICK_CUTS.min_gap_seconds })],
            ] as const satisfies readonly (readonly [SceneParameters, string])[]
          ).map(([preset, label]) => {
            const active = draft.scene.threshold === preset.threshold && draft.scene.min_gap_seconds === preset.min_gap_seconds;
            return (
              <Button key={label} size="sm" variant={active ? "secondary" : "quiet"} aria-pressed={active} disabled={running} onClick={() => update({ scene: preset })} className="min-h-7 px-2">
                {label}
              </Button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 偵測進行中（送出或執行中）按鈕保持 pending：不會再送出第二個偵測 run */}
          <ActionButton size="sm" variant="secondary" icon={<ScanSearch aria-hidden />} pending={running} disabledReason={running ? null : (support.reason ?? blockedReason)} onClick={onDetect} title={running ? t("偵測進行中") : undefined}>
            {detection.status === "succeeded" || detection.status === "failed" ? t("重新偵測") : t("開始偵測")}
          </ActionButton>
          {detection.status === "running" ? (
            <Button size="sm" variant="danger" icon={<Ban aria-hidden />} pending={cancelling} onClick={onCancel}>
              {t("取消偵測")}
            </Button>
          ) : null}
        </div>
        {notice ? (
          <p role="status" className="text-caption text-warning [overflow-wrap:anywhere]">
            {notice}
          </p>
        ) : null}
      </Section>
      <label className="flex items-start gap-2 text-data text-fg">
        <input type="checkbox" checked={draft.skipDetection} onChange={(event) => update({ skipDetection: event.target.checked })} className="mt-1 size-3.5 accent-action" />
        <span>
          {SKIP_DETECTION_LABEL}
          <span className="block text-caption text-fg-tertiary">{t("只用在「分段計畫」手動加的切鏡；超過每段上限的範圍會在鏡頭中間平均切開（接縫可能看得到）。偵測失敗時不會自動改成這樣，要明確勾選。")}</span>
        </span>
      </label>
      <div aria-live="polite" className="grid gap-2">
        {detection.status === "running" ? (
          <div className="grid gap-1.5">
            <p role="status" className="flex items-center gap-1.5 text-caption text-info">
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
              <T source={"偵測中（run <0>{runId}</0>）{value}"} values={{ runId: detection.runId.slice(0, 8), value: elapsed !== null ? t("・已 {elapsed} 秒", { elapsed }) : "" }} slots={[<code className="machine" />]} />
            </p>
            {/* 只表示進行中（偵測沒有進度比例） */}
            <span aria-hidden className="relative block h-1 w-full max-w-xs overflow-hidden rounded-full bg-line-subtle">
              <span className={cn("absolute inset-0 bg-brand-gradient opacity-60", SHIMMER)} />
            </span>
          </div>
        ) : detection.status === "failed" ? (
          <NoteList tone="danger" icon={<TriangleAlert aria-hidden />} items={[t("{message}。不會自動重試：Node 更新或調整參數後按「重新偵測」，或明確勾選「{skipDetectionLabel}」。", { message: detection.message, skipDetectionLabel: SKIP_DETECTION_LABEL })]} />
        ) : detection.status === "succeeded" ? (
          <p role="status" className="flex items-start gap-1.5 text-caption text-success [overflow-wrap:anywhere] animate-rise-in">
            <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <T source={"偵測完成：整支影片 {value} 個切鏡，範圍內 {inRangeCount} 個；影片長度與音軌已改用偵測結果。在「分段計畫」可以取消個別切鏡或手動加切鏡。{value2}"} values={{ value: detection.info.scene_cuts_seconds?.length ?? 0, inRangeCount: inRange.length, value2: detection.info.scene_detection ? (
                <span className="machine block text-fg-tertiary">
                  {t("實際參數：門檻 {threshold}・最短間隔 {min_gap_seconds} 秒", { threshold: detection.info.scene_detection.threshold, min_gap_seconds: detection.info.scene_detection.min_gap_seconds })}
                </span>
              ) : null }} />
            </span>
          </p>
        ) : (
          <p className="text-caption text-fg-tertiary">{t("還沒偵測。")}</p>
        )}
      </div>
    </div>
  );
}
