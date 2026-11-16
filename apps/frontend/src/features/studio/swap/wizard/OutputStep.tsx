// Wizard step 5: project title, compute route, format, audio, the plugin items the new project keeps (the current
// project's selection, each can be left out, checked against every segment prompt), auto export and the summary.
import { AudioLines, CircleCheck, Info, Puzzle, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { Input, Select } from "@/components/ui/controls";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { CapabilityBadge, ReadyDot, RouteCaveatLine, RouteReadiness } from "../../components/routeParts";
import { FORMAT_PRESETS } from "../../model/project";
import { batchCount, nextBatch, swapBatchSize } from "../batchSize";
import { STEP_IDS, type StepId } from "../draft";
import type { SwapAudioMode } from "../job";
import type { SwapPluginsView } from "../plugins";
import { Fact, Facts, Section } from "../fields";
import { formatCueTime } from "../prompt";
import { STEP_LABELS } from "../steps";
import type { SwapDraftApi } from "../useSwapDraft";
import type { WizardDerived } from "../wizardModel";
import { Label } from "./Label";
import { PlanSummary } from "./PlanSummary";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** The summary's 原聲 fact: whether the source has a soundtrack, and whether the model gets it. */
function sourceSound(hasAudio: boolean | null, audio: SwapAudioMode): string {
  if (hasAudio === false) return t("沒有");
  if (hasAudio === null) return t("未知（建議先做切鏡偵測，probe 會確認）");
  return audio === "original" ? t("有（prompt 引用 <Audio 1>）") : t("有（不送給模型；台詞照備註的 <d> 生成）");
}

export function OutputStep({
  api,
  derived,
  problems,
  renderBlockedReason,
  plugins,
  onGoto,
}: {
  api: SwapDraftApi;
  derived: WizardDerived;
  problems: Record<StepId, string[]>;
  /** 不能在建立後立即開始渲染的原因（主控有其他 run、路由未就緒…）。 */
  renderBlockedReason: string | null;
  plugins: SwapPluginsView;
  onGoto: (step: StepId) => void;
}) {
  const { draft, update } = api;
  const id = useId();
  const mattes = draft.characters.filter((character) => character.image?.check === "transparent").length;
  // The first render sends one batch; the swap panel sends the rest (each batch can be checked before the next)
  const batchSize = swapBatchSize.use();
  const segments = derived.plan.segments.length;
  const first = nextBatch(derived.plan.segments.map((_, index) => String(index)), derived.perRun, batchSize).length;
  const batches = batchCount(segments, derived.perRun, batchSize);
  const firstBatchText =
    batches > 1
      ? t("先渲染第一批 {first} 段（共 {segments} 段、{batches} 批）；每段完成就能在「一鍵換角」比對原片，再送下一批。每批段數可以在「一鍵換角」改。", { first, segments, batches })
      : t("所有段落放進同一個 run，在同一張卡依序執行；不會自動重試失敗的段落。");
  const other = STEP_IDS.filter((step) => step !== "output" && problems[step].length > 0);
  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-title`} hint={t("會建立一個新的 Studio 專案；目前的專案不會被修改")}>
          {t("專案名稱")}
        </Label>
        <Input id={`${id}-title`} compact maxLength={200} value={draft.title} onChange={(event) => update({ title: event.target.value, titleEdited: true })} />
      </div>

      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="pb-1 text-caption font-medium text-fg-secondary">{t("運算路由（ref2va 元件組合）")}</legend>
        {derived.routes.length === 0 ? <p className="text-caption text-warning">{t("沒有 ref2va 元件組合可用。")}</p> : null}
        {derived.routes.map((route) => (
          <label key={route.id} className={cn(OPTION_CARD, "flex cursor-pointer items-start gap-2 px-2.5 py-2", route.id === derived.route?.id ? OPTION_SELECTED : OPTION_IDLE)}>
            <input type="radio" name={`${id}-route`} checked={route.id === derived.route?.id} onChange={() => update({ routeId: route.id })} className="mt-0.5 accent-action" />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <ReadyDot ready={route.ready} />
                <span className="min-w-0 text-data text-fg [overflow-wrap:anywhere]">{route.label}</span>
                <CapabilityBadge task={route.capability} />
              </span>
              <code className="machine truncate text-[11px] text-fg-tertiary" title={route.id}>
                {route.id}
              </code>
              <RouteReadiness route={route} />
              <RouteCaveatLine route={route} />
            </span>
          </label>
        ))}
        {derived.route && !derived.route.ready ? (
          <p className="text-caption text-fg-tertiary">
            {t("未就緒的元件組合也可以建立專案；建立後在新專案的「渲染引擎」啟動需要的元件，再到「一鍵換角」按「渲染剩下的段落」。")}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-format`}>
            {t("畫面格式")}
          </Label>
          <Select id={`${id}-format`} compact value={draft.format} onChange={(event) => update({ format: event.target.value })}>
            {FORMAT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="pb-1 text-caption font-medium text-fg-secondary">
          <AudioLines aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
          {t("聲音")}
        </legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(
            [
              {
                value: "generated",
                label: t("生成的聲音（預設）"),
                hint: t("台詞與聲音照 prompt 生成：每段備註的 <d>[語言] 原文</d> 由新角色說出，嘴型與聲線一致；沒寫台詞的段落只有環境聲與動作聲。鏡頭中間的接縫處，前後兩段的聲音各自生成，可能聽得出跳動。"),
              },
              {
                value: "original",
                label: t("原影片音軌"),
                hint: t("原聲當聲音參考送給模型（<Audio 1>），匯出時整段改用原影片的聲音（從範圍起點對齊、長度等於整段），段落之間沒有聲音接縫。"),
              },
            ] as const
          ).map((option) => (
            <label key={option.value} className={cn(OPTION_CARD, "flex cursor-pointer items-start gap-2 px-2.5 py-2", option.value === draft.audio ? OPTION_SELECTED : OPTION_IDLE)}>
              <input type="radio" name={`${id}-audio`} checked={option.value === draft.audio} onChange={() => update({ audio: option.value })} className="mt-0.5 accent-action" />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-data text-fg">{option.label}</span>
                <span className="text-caption text-fg-tertiary">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.audio === "original" ? (
          <p role="status" className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning animate-fade-in">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {t("原影片的台詞是原角色的聲音：嘴型與聲線會對不上新角色。要角色說話時改用「生成的聲音」，在每段備註寫 <d> 台詞。")}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="pb-1 text-caption font-medium text-fg-secondary">
          <Puzzle aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
          {t("插件（套用到新專案）")}
        </legend>
        {plugins.items.length === 0 ? (
          <p className="text-caption text-fg-tertiary">{t("目前的專案沒有選用插件，新專案也不會套用；在專案的「插件」分頁選好風格再回來。")}</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {plugins.items.map((item) => {
              const checked = plugins.refs.includes(item.ref);
              return (
                <li key={item.ref}>
                  <label className={cn(OPTION_CARD, "flex cursor-pointer items-start gap-2 px-2.5 py-2", checked ? OPTION_SELECTED : OPTION_IDLE)}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        const next = event.target.checked ? plugins.items.map((other) => other.ref).filter((ref) => ref === item.ref || plugins.refs.includes(ref)) : plugins.refs.filter((ref) => ref !== item.ref);
                        update({ plugins: next });
                      }}
                      className="mt-0.5 accent-action"
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate text-data text-fg" title={item.label}>{item.label}</span>
                      {item.plugin ? <span className="truncate text-caption text-fg-tertiary" title={item.plugin}>{item.plugin}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {plugins.refs.length > 0 ? (
          plugins.problem ? (
            <div role="alert" className="grid gap-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning animate-fade-in">
              <p className="flex items-center gap-1.5 font-medium">
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                {t("「{title}」的 prompt 不符合所選插件；取消勾選擋下它的項目，或回到前面的步驟調整：", { title: plugins.problem.title })}
              </p>
              <ul className="grid gap-0.5 pl-5">
                {plugins.problem.reasons.map((reason) => (
                  <li key={reason} className="list-disc [overflow-wrap:anywhere]">{reason}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-caption text-success animate-fade-in">
              <CircleCheck aria-hidden className="size-3.5 shrink-0" />
              {t("每一段的 prompt 都符合所選的 {count} 個插件項目", { count: plugins.refs.length })}
            </p>
          )
        ) : null}
      </fieldset>

      <div className="grid gap-1">
        <label className="flex items-start gap-2 text-data text-fg">
          <input type="checkbox" checked={draft.autoExport} onChange={(event) => update({ autoExport: event.target.checked })} className="mt-1 size-3.5 accent-action" />
          <span>
            <T source={"全部段落完成後自動匯出一次<0>只自動送一次；失敗或之後要再匯出時，在「一鍵換角」按「匯出」。</0>"} slots={[<span className="block text-caption text-fg-tertiary" />]} />
          </span>
        </label>
        <label className={cn("flex items-start gap-2 text-data", renderBlockedReason ? "text-fg-disabled" : "text-fg")}>
          <input type="checkbox" checked={draft.startRender && !renderBlockedReason} disabled={Boolean(renderBlockedReason)} aria-describedby={renderBlockedReason ? `${id}-render-reason` : undefined} onChange={(event) => update({ startRender: event.target.checked })} className="mt-1 size-3.5 accent-action" />
          <span>
            <T source={"建立後立即開始渲染{span}"} values={{ span: <span id={`${id}-render-reason`} className="block text-caption text-fg-tertiary">
              {renderBlockedReason ? t("現在不能：{renderBlockedReason}。專案仍會建立，之後在專案的「一鍵換角」開始。", { renderBlockedReason }) : firstBatchText}
            </span> }} />
          </span>
        </label>
      </div>

      <Section title={t("摘要")} icon={<Info />}>
        <Facts className="text-caption">
          <Fact label={t("來源")}>{draft.source?.name ?? "—"}</Fact>
          <Fact label={t("範圍")}>{derived.plan.total_frames > 0 ? t("{start_frame}–{end_frame}（{total_frames} 影格）", { start_frame: formatCueTime(derived.plan.start_frame), end_frame: formatCueTime(derived.plan.end_frame), total_frames: derived.plan.total_frames }) : "—"}</Fact>
          <Fact label={t("角色")}>{t("{charactersCount} 個{value}", { charactersCount: draft.characters.length, value: mattes > 0 ? t("；{mattes} 張透明圖會另存白底副本", { mattes }) : "" })}</Fact>
          <Fact label={t("原聲")}>{sourceSound(derived.facts?.has_audio ?? null, draft.audio)}</Fact>
        </Facts>
        <PlanSummary derived={derived} />
      </Section>
      {other.length > 0 ? (
        <div role="alert" className="grid gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning">
          <p className="font-medium">{t("建立前還要處理：")}</p>
          <ul className="grid gap-1">
            {other.map((step) => (
              <li key={step} className="flex flex-wrap items-center gap-x-2">
                <span className="[overflow-wrap:anywhere]">
                  <T source={"{step}：{problems}"} values={{ step: STEP_LABELS[step], problems: problems[step][0] }} />
                </span>
                <button type="button" onClick={() => onGoto(step)} className="pressable rounded-md px-1.5 text-action-fg underline-offset-2 hover:bg-raised hover:underline">
                  {t("前往")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
