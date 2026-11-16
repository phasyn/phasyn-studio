// 屬性「基本」分頁（一個畫面放得下）：名稱、文生圖／圖生圖、運算路由（一個下拉；還沒有可以生圖的元件組合時是建立生圖
// 引擎的入口）、prompt、負面提示詞、輸出尺寸（512／1024／1536 或自訂；規則只在輸入不合法時出現）、seed 與生成張數（1–8；
// -1＝每張隨機，實際值記在 take）、完成後自動加入素材庫（這台瀏覽器的偏好）與備註。固定的說明在欄位旁的 ⓘ，面板上只留
// 與狀態有關的提醒（尺寸不合法、快到字數上限、批次的 seed）。
import { ArrowLeftRight, ChevronDown, Dices, ImagePlus, Shuffle, Type } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Switch, Textarea } from "@/components/ui/controls";
import { Expand } from "@/components/flow/Expand";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED } from "@/components/ui/look";
import { cn } from "@/lib/cn";
import { useSetMode } from "../hooks/useShotMode";
import { useImageStudio } from "../imageStudioContext";
import { LIMITS, MODE_LABELS, RANDOM_SEED, SEED_MODE_LABELS } from "../model/constants";
import { describeSeeds, effectiveSeedMode, randomSeed } from "../model/seeds";
import { cfgEnabled } from "../model/shots";
import { aspectLabel, megapixels, presetOf, SIZE_PRESETS, sizePatch, sizeProblem, snapSide } from "../model/size";
import type { SeedMode, StudioImageShot } from "../types";
import { NumberField, Row, Segmented } from "./fields";
import { InfoTip } from "./InfoTip";
import { RouteField } from "./RouteField";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const SEED_MODES: readonly SeedMode[] = ["increment", "fixed", "random"];
/** 字數到上限的九成才顯示計數（與狀態有關的提醒）。 */
const PROMPT_WARN_AT = Math.floor(LIMITS.prompt * 0.9);

type Update = (patch: Partial<StudioImageShot>) => void;

function NegativePrompt({ shot, update }: { shot: StudioImageShot; update: Update }) {
  const id = useId();
  const cfg = cfgEnabled(shot.guidance);
  const [open, setOpen] = useState(shot.negative_prompt.length > 0 || cfg);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((value) => !value)}
          className="pressable inline-flex items-center gap-1.5 rounded-sm text-caption font-medium text-fg-secondary hover:text-fg [&_svg]:size-3.5"
        >
          <ChevronDown aria-hidden className={cn("transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", open ? "" : "-rotate-90")} />
          <T source={"負面提示詞{span}"} values={{ span: <span className={cn("font-normal", cfg ? "text-info" : "text-fg-tertiary")}>{cfg ? t("（guidance > 1：會使用）") : t("（guidance ≤ 1：不使用）")}</span> }} />
        </button>
        <InfoTip label={t("負面提示詞")}>{t("Qwen 的 CFG 只在 guidance 大於 1 時開啟：負面提示詞才會被編碼，每步 DiT 前向次數加倍。在「採樣」分頁調整 guidance。")}</InfoTip>
      </div>
      <Expand id={`${id}-panel`} open={open} innerClassName="p-0.5">
        <Textarea
          aria-label={t("負面提示詞")}
          compact
          value={shot.negative_prompt}
          maxLength={LIMITS.prompt}
          onChange={(event) => update({ negative_prompt: event.target.value })}
          placeholder={t("不希望出現在畫面中的內容")}
          className="min-h-16 leading-6"
        />
      </Expand>
    </div>
  );
}

function SizeField({ shot, update }: { shot: StudioImageShot; update: Update }) {
  const id = useId();
  const preset = presetOf(shot.width, shot.height);
  const problem = sizeProblem(shot.width, shot.height);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1">
        <span id={`${id}-size`} className="text-caption font-medium text-fg-secondary">
          {t("輸出尺寸")}
        </span>
        <InfoTip label={t("輸出尺寸")} className="-my-0.5">
          {t("寬高都必須是 {multiple} 的倍數、介於 {min}–{max}（Qwen-Image 2.1 的對齊單位）。", { multiple: LIMITS.side.multiple, min: LIMITS.side.min, max: LIMITS.side.max })}
        </InfoTip>
        <span className="machine ml-auto text-caption text-fg-tertiary">{t("{width}・{megapixels} MP", { width: aspectLabel(shot.width, shot.height), megapixels: megapixels(shot.width, shot.height) })}</span>
      </div>
      <div role="group" aria-labelledby={`${id}-size`} className="grid grid-cols-3 gap-1">
        {SIZE_PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={preset?.id === item.id}
            onClick={() => update(sizePatch(shot, item.width, item.height))}
            className={cn(
              "grid min-h-10 justify-items-center rounded-lg px-2 py-1 text-caption outline-none focus-visible:ring-2 focus-visible:ring-focus",
              CHOICE_BASE,
              preset?.id === item.id ? cn(CHOICE_SELECTED, "text-fg") : cn(CHOICE_IDLE, "text-fg-secondary"),
            )}
          >
            <span className="machine text-data">{item.label}</span>
            <span className="text-fg-tertiary">{item.hint}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-1.5">
        <Row label={t("寬度 px")} htmlFor={`${id}-width`}>
          <NumberField id={`${id}-width`} integer multiple={LIMITS.side.multiple} min={LIMITS.side.min} max={LIMITS.side.max} value={shot.width} onCommit={(value) => update(sizePatch(shot, value ?? shot.width, shot.height))} />
        </Row>
        <Button size="icon-sm" variant="quiet" aria-label={t("交換寬度與高度")} title={t("交換寬度與高度")} onClick={() => update({ width: shot.height, height: shot.width })} className="mb-px">
          <ArrowLeftRight aria-hidden />
        </Button>
        <Row label={t("高度 px")} htmlFor={`${id}-height`}>
          <NumberField id={`${id}-height`} integer multiple={LIMITS.side.multiple} min={LIMITS.side.min} max={LIMITS.side.max} value={shot.height} onCommit={(value) => update(sizePatch(shot, shot.width, value ?? shot.height))} />
        </Row>
      </div>
      {problem ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-caption text-danger animate-fade-in">
          {problem}
          <Button size="sm" variant="secondary" className="min-h-7 px-2" onClick={() => update(sizePatch(shot, snapSide(shot.width), snapSide(shot.height)))}>
            {t("改成 {width}×{height}", { width: snapSide(shot.width), height: snapSide(shot.height) })}
          </Button>
        </p>
      ) : null}
    </div>
  );
}

function SeedField({ shot, update }: { shot: StudioImageShot; update: Update }) {
  const id = useId();
  const seedMode = effectiveSeedMode(shot.seed, shot.seed_mode);
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
        <Row label="Seed" htmlFor={`${id}-seed`} info={t("-1＝每張隨機，實際的 seed 記在各個 take。")}>
          <NumberField id={`${id}-seed`} integer min={LIMITS.seed.min} max={LIMITS.seed.max} value={shot.seed} onCommit={(value) => update({ seed: value ?? RANDOM_SEED })} />
        </Row>
        <span className="flex gap-1 pb-px">
          <Button size="icon-sm" variant="quiet" aria-label={t("產生新的隨機 seed（固定）")} title={t("產生新的隨機 seed（固定）")} onClick={() => update({ seed: randomSeed() })}>
            <Dices aria-hidden />
          </Button>
          <Button size="icon-sm" variant={shot.seed === RANDOM_SEED ? "secondary" : "quiet"} aria-pressed={shot.seed === RANDOM_SEED} aria-label={t("每張隨機（seed -1）")} title={t("每張隨機（seed -1）")} onClick={() => update({ seed: RANDOM_SEED })}>
            <Shuffle aria-hidden />
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t("生成張數")} htmlFor={`${id}-batch`} info={t("同一個 run：文字條件只編碼一次，DiT、解碼與合成每張各跑一次（同一張卡依序執行）。")}>
          <Select id={`${id}-batch`} compact value={shot.batch} onChange={(event) => update({ batch: Number(event.target.value) })}>
            {Array.from({ length: LIMITS.batch.max }, (_, index) => index + 1).map((count) => (
              <option key={count} value={count}>
                {t("{count} 張", { count })}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t("每張的 seed")} htmlFor={`${id}-seed-mode`}>
          <Select id={`${id}-seed-mode`} compact value={seedMode} disabled={shot.seed === RANDOM_SEED} title={shot.seed === RANDOM_SEED ? t("seed 是 -1：每張隨機") : undefined} onChange={(event) => update({ seed_mode: event.target.value as SeedMode })}>
            {SEED_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SEED_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        </Row>
      </div>
      {/* 批次時每張用哪個 seed（與狀態有關）；一張時欄位本身就說明了 */}
      {shot.batch > 1 ? <p className="machine text-caption text-fg-secondary [overflow-wrap:anywhere] animate-fade-in">{describeSeeds(shot.seed, shot.seed_mode, shot.batch)}</p> : null}
    </div>
  );
}

export function BasicTab({ shot }: { shot: StudioImageShot }) {
  const { dispatch, autoLibrary, setAutoLibrary } = useImageStudio();
  const id = useId();
  const setMode = useSetMode(shot);
  const update: Update = (patch) => dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch });
  return (
    <div className="grid gap-3 p-3">
      <Row label={t("名稱")} htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} compact value={shot.title} maxLength={200} onChange={(event) => update({ title: event.target.value })} />
      </Row>

      <div className="grid gap-1">
        <span id={`${id}-mode`} className="text-caption font-medium text-fg-secondary">
          {t("生成模式")}
        </span>
        <Segmented
          name={`${id}-mode`}
          labelledBy={`${id}-mode`}
          value={shot.mode}
          onChange={setMode}
          options={[
            { value: "t2i", label: MODE_LABELS.t2i, icon: <Type aria-hidden />, title: t("只用文字生成") },
            { value: "i2i", label: MODE_LABELS.i2i, icon: <ImagePlus aria-hidden />, title: t("加上 1–4 張參考圖（可加遮罩）") },
          ]}
        />
      </div>

      <RouteField shot={shot} />

      <Row
        label="Prompt"
        htmlFor={`${id}-prompt`}
        info={t("在設定面板按 Ctrl+Enter 生成；最多 {prompt} 字。", { prompt: LIMITS.prompt.toLocaleString("en-US") })}
        hint={
          shot.prompt.length >= PROMPT_WARN_AT ? (
            <span className="machine text-warning">{t("{promptCount}／{prompt} 字", { promptCount: shot.prompt.length.toLocaleString("en-US"), prompt: LIMITS.prompt.toLocaleString("en-US") })}</span>
          ) : null
        }
      >
        <Textarea
          id={`${id}-prompt`}
          compact
          value={shot.prompt}
          maxLength={LIMITS.prompt}
          onChange={(event) => update({ prompt: event.target.value })}
          placeholder={shot.mode === "i2i" ? t("描述想要如何修改參考畫面…") : t("描述主體、光線、構圖與風格…")}
          className="min-h-28 leading-6"
        />
      </Row>

      <NegativePrompt shot={shot} update={update} />
      <SizeField shot={shot} update={update} />
      <SeedField shot={shot} update={update} />

      <div className="flex items-center gap-1">
        <Switch id={`${id}-auto-library`} label={t("完成後自動加入專案素材庫")} checked={autoLibrary} onChange={(event) => setAutoLibrary(event.target.checked)} className="min-h-8 py-0 text-data [&_.text-fg]:text-data" />
        <InfoTip label={t("完成後自動加入專案素材庫")}>{t("加入的是白底版（Video Studio 的 H3 以白底讀取參考圖）；記在這台瀏覽器。")}</InfoTip>
      </div>

      <Row label={t("備註")} htmlFor={`${id}-note`}>
        <Textarea id={`${id}-note`} compact value={shot.note} maxLength={LIMITS.prompt} onChange={(event) => update({ note: event.target.value })} className="min-h-12 leading-6" />
      </Row>
    </div>
  );
}
