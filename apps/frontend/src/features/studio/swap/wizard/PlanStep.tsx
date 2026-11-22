// Wizard step 4: segment plan (per-segment limit, crossfade, the held segment tail, cuts in use) and the per-segment
// table, where each segment shows the original's frame in its middle (read when the row comes into view) so its
// characters can be ticked by sight. A segment's note may hold its spoken lines (<d>…</d>), which go into its first shot.
import { MessageSquareQuote, Scissors, SplitSquareHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useId } from "react";
import { mediaUrl } from "@/api/http";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { newLocalId } from "../../references/ids";
import { useSegmentEstimates } from "../../hooks/usePlanEta";
import { segmentEtaText } from "../../model/eta";
import { cutKey, segmentKey } from "../draft";
import { NumberField, Section } from "../fields";
import { joinLabel } from "../job";
import { DEFAULT_HOLD_TAIL, MAX_CROSSFADE_FRAMES, segmentFrameOptions } from "../planner";
import { FIELD_LIMITS, formatCueTime } from "../prompt";
import { cancelThumbs } from "../sourceThumbs";
import type { SwapDraftApi } from "../useSwapDraft";
import type { WizardDerived } from "../wizardModel";
import { Label } from "./Label";
import { LimitNote } from "./LimitNote";
import { PlanSummary } from "./PlanSummary";
import { SegmentThumb } from "./SegmentThumb";
import { frameSeconds, round3 } from "./format";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

/** Seconds of a held tail setting, for the option's line (0.5, 2). */
const holdSeconds = (frames: number, fps: number) => Number((frames / fps).toFixed(2));

export function PlanStep({ api, derived }: { api: SwapDraftApi; derived: WizardDerived }) {
  const { draft, update } = api;
  const id = useId();
  const plan = derived.plan;
  const estimates = useSegmentEstimates(derived.etaInputs).results;
  // Leaving the step drops the segment pictures still waiting to be read
  useEffect(() => cancelThumbs, []);
  const sourceUrl = draft.source ? mediaUrl(draft.source.file.node_id, draft.source.file.file_id) : null;
  const start = draft.startSeconds;
  const end = draft.endSeconds ?? derived.facts?.duration_seconds ?? null;
  const detected = (derived.detectedCuts ?? []).filter((cut) => cut > start && (end === null || cut < end));
  const disabled = new Set(draft.disabledCuts);
  const addCut = (value: number | null) => {
    if (value === null || draft.manualCuts.some((cut) => cutKey(cut.seconds) === cutKey(value))) return;
    update({ manualCuts: [...draft.manualCuts, { id: newLocalId("cut"), seconds: round3(value) }].sort((a, b) => a.seconds - b.seconds) });
  };
  // 段落設定以「原影片範圍」為 key：分段改變後，範圍沒變的段落保留備註與角色勾選
  const setNote = (key: string, value: string) => { update((current) => ({ notes: { ...current.notes, [key]: value } })); };
  const toggleAbsent = (key: string, characterId: string, present: boolean) => { update((current) => {
      const ids = new Set(current.absent[key] ?? []);
      if (present) ids.delete(characterId);
      else ids.add(characterId);
      return { absent: { ...current.absent, [key]: [...ids] } };
    }); };
  // Options stop at this character count's limit (maxFramesFor)
  const frameOptions = segmentFrameOptions(derived.frameLimit);
  const perCount = derived.limit.maxFramesByCharacters ? t("（{characters} 個角色）", { characters: derived.characters }) : "";
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-max`} hint={t("每段生成的最長長度（17n＋5 影格）；最長＝{label} 的{value}上限{perCount}", { label: derived.limit.label, value: derived.limit.source === "measured" ? t("量測") : t("預設"), perCount })}>
            {t("每段上限")}
          </Label>
          <Select
            id={`${id}-max`}
            compact
            value={derived.maxFrames}
            // 選最長的值＝跟著 DiT 的上限（換路由或改角色數時一起變）
            onChange={(event) => {
              const frames = Number(event.target.value);
              update({ maxFrames: frames >= derived.frameLimit ? null : frames });
            }}
          >
            {frameOptions.map((frames) => (
              <option key={frames} value={frames}>
                {t("{frames} 影格（{frames2}）{value}", { frames, frames2: frameSeconds(frames), value: frames === derived.frameLimit ? t("・上限") : "" })}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-fade`} hint={t("鏡頭中間的接縫重疊幾個影格（0–{maxCrossfadeFrames}；0＝直接接）", { maxCrossfadeFrames: MAX_CROSSFADE_FRAMES })}>
            {t("交叉溶接（影格）")}
          </Label>
          <NumberField id={`${id}-fade`} integer value={draft.crossfade} min={0} max={MAX_CROSSFADE_FRAMES} onCommit={(value) => { update({ crossfade: value ?? draft.crossfade }); }} />
        </div>
      </div>
      <Checkbox
        id={`${id}-hold`}
        checked={draft.holdTail}
        onChange={(event) => { update({ holdTail: event.target.checked }); }}
        label={t("段尾凍結（推薦）")}
        description={t("每段的參考影片只用到段尾後 {leadOut} 秒（至少 {minReal} 秒原片），之後凍結最後一格：模型不會提早畫出下一段的鏡頭。", {
          leadOut: holdSeconds(DEFAULT_HOLD_TAIL.leadOutFrames, plan.fps),
          minReal: holdSeconds(DEFAULT_HOLD_TAIL.minRealFrames, plan.fps),
        })}
        className="min-h-8 py-0"
      />
      <LimitNote derived={derived} api={api} />
      <PlanSummary derived={derived} />

      <Section title={t("切鏡（範圍內 {detectedCount} 個）", { detectedCount: detected.length + draft.manualCuts.filter((cut) => cut.seconds > start && (end === null || cut.seconds < end)).length })} icon={<Scissors />}>
        {detected.length === 0 && draft.manualCuts.length === 0 ? <p className="text-caption text-fg-tertiary">{t("範圍內沒有切鏡{value}；可以手動加入。", { value: derived.detectedCuts === null ? t("（還沒偵測）") : "" })}</p> : null}
        <ul className="grid max-h-48 gap-0.5 overflow-y-auto" aria-label={t("切鏡清單")}>
          {detected.map((cut) => {
            const key = cutKey(cut);
            const checked = !disabled.has(key);
            return (
              <li key={`d${key}`} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised/60">
                <input
                  id={`${id}-cut-${key}`}
                  type="checkbox"
                  checked={checked}
                  className="size-3.5 accent-action"
                  onChange={(event) => { update({ disabledCuts: event.target.checked ? draft.disabledCuts.filter((value) => value !== key) : [...draft.disabledCuts, key] }); }}
                />
                <label htmlFor={`${id}-cut-${key}`} className="flex flex-1 items-center gap-2 text-data">
                  <span className="machine text-fg">{formatCueTime(Math.round(cut * 24))}</span>
                  <Badge tone="info">{t("偵測")}</Badge>
                  {checked ? null : <span className="text-caption text-fg-tertiary">{t("不採用")}</span>}
                </label>
              </li>
            );
          })}
          {draft.manualCuts.map((cut) => (
            <li key={cut.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised/60">
              <span className="machine text-data text-fg">{formatCueTime(Math.round(cut.seconds * 24))}</span>
              <Badge tone="neutral">{t("手動")}</Badge>
              <Button size="icon-sm" variant="quiet" className="ml-auto" icon={<Trash2 aria-hidden />} aria-label={t("移除手動切鏡 {seconds} 秒", { seconds: cut.seconds })} title={t("移除")} onClick={() => { update({ manualCuts: draft.manualCuts.filter((item) => item.id !== cut.id) }); }} />
            </li>
          ))}
        </ul>
        <div className="flex items-start gap-1.5">
          <NumberField
            id={`${id}-manual`}
            value={null}
            allowEmpty
            min={0}
            max={derived.facts?.duration_seconds ?? 86_400}
            placeholder={t("秒，例如 12.5")}
            label={t("手動加入切鏡（新鏡頭開始的秒數），按 Enter 加入")}
            onCommit={addCut}
            className="w-44"
          />
          <span className="pt-1.5 text-caption text-fg-tertiary">{t("新鏡頭開始的秒數；按 Enter（或離開欄位）加入")}</span>
        </div>
      </Section>

      {plan.segments.length > 0 ? (
        <Section title={t("段落（{segmentsCount}）", { segmentsCount: plan.segments.length })} icon={<SplitSquareHorizontal />}>
          {draft.audio === "generated" && derived.facts?.has_audio !== false ? (
            // Generated sound: the source's lines are not sent, so a segment where someone talks needs its lines here
            <p className="flex items-start gap-1.5 text-caption text-fg-secondary">
              <MessageSquareQuote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-action-fg" />
              {t("原片的聲音不會送給模型：有人說話的段落，在備註寫台詞 <d>[{language}] 原文</d>，由新角色在那一段的第一鏡說出、嘴型同步；沒寫台詞的段落只有環境聲與動作聲。", {
                language: draft.dialogueLanguage.trim() || "Japanese",
              })}
            </p>
          ) : null}
          <div className="overflow-x-auto rounded-lg border border-line-subtle">
            <table className="w-full min-w-[60rem] table-fixed border-collapse text-data">
              <caption className="sr-only">{t("分段計畫：每段的原影片時間、生成長度、接縫與角色")}</caption>
              <thead className="bg-canvas text-caption text-fg-tertiary">
                <tr>
                  {/* the column holds a two-digit number: a short heading that fits, the word for assistive technology */}
                  <th scope="col" aria-label={t("段")} title={t("段")} className="w-10 px-2 py-1.5 text-left font-medium whitespace-nowrap">
                    {t("段", undefined, { context: "number-column" })}
                  </th>
                  <th scope="col" className="w-40 px-2 py-1.5 text-left font-medium">{t("畫面（段落中間）")}</th>
                  <th scope="col" className="w-44 px-2 py-1.5 text-left font-medium">{t("原影片")}</th>
                  <th scope="col" className="w-24 px-2 py-1.5 text-left font-medium">{t("生成／保留")}</th>
                  <th scope="col" className="w-48 px-2 py-1.5 text-left font-medium">{t("接下一段")}</th>
                  <th scope="col" className="w-24 px-2 py-1.5 text-left font-medium">{t("角色")}</th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("備註（畫面與 <d> 台詞，選填）")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.segments.map((segment, index) => {
                  const key = segmentKey(plan, segment);
                  const absent = new Set(draft.absent[key] ?? []);
                  // the frame in the middle of what the segment keeps, at its display midpoint
                  const middle = Math.floor(plan.start_frame + (segment.timeline_start + segment.timeline_end) / 2);
                  return (
                    <tr key={key} className="border-t border-line-subtle align-top">
                      <td className="machine px-2 py-1.5 text-fg-secondary">{String(index + 1).padStart(2, "0")}</td>
                      <td className="px-2 py-1.5">
                        <SegmentThumb url={sourceUrl} seconds={(middle + 0.5) / plan.fps} label={t("第 {index} 段的原影片畫面（{time}）", { index: index + 1, time: formatCueTime(middle, plan.fps) })} />
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="machine block text-fg">
                          {formatCueTime(plan.start_frame + segment.timeline_start)}–{formatCueTime(plan.start_frame + segment.timeline_end)}
                        </span>
                        {segment.window_cuts.length > 0 ? <span className="block text-caption text-fg-tertiary">{t("視窗內切鏡 {map}", { map: formatList(segment.window_cuts.map((cut) => formatCueTime(cut))) })}</span> : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="machine block text-fg">{t("{frames} 影格", { frames: segment.frames })}</span>
                        <span className="machine block text-caption text-fg-tertiary">{t("保留 {keep_out_frame}", { keep_out_frame: segment.keep_out_frame - segment.keep_in_frame })}</span>
                        {estimates ? <span className="block text-caption text-fg-tertiary">{segmentEtaText(estimates[index])}</span> : null}
                      </td>
                      <td className={cn("px-2 py-1.5 text-caption", segment.join_out?.kind === "mid_shot" ? "text-warning" : "text-fg-secondary")}>
                        <span className="flex items-start gap-1">
                          {segment.join_out?.kind === "mid_shot" ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : segment.join_out ? <Scissors aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
                          {joinLabel(segment.join_out)}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="flex flex-wrap gap-x-2 gap-y-1">
                          {draft.characters.map((character, at) => (
                            <label key={character.id} className="inline-flex items-center gap-1 text-caption text-fg-secondary" title={t("第 {index} 段有角色 {at}", { index: index + 1, at: at + 1 })}>
                              <input type="checkbox" checked={!absent.has(character.id)} onChange={(event) => { toggleAbsent(key, character.id, event.target.checked); }} className="size-3.5 accent-action" />
                              <span className="machine">{at + 1}</span>
                              <span className="sr-only">{t("：第 {index} 段出現角色 {at}", { index: index + 1, at: at + 1 })}</span>
                            </label>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input compact aria-label={t("第 {index} 段的備註", { index: index + 1 })} maxLength={FIELD_LIMITS.note} value={draft.notes[key] ?? ""} placeholder="a close-up of a talking girl, then a wide rooftop shot" onChange={(event) => { setNote(key, event.target.value); }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
