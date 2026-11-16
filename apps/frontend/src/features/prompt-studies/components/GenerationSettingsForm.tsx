// 生成設定（生成比對與有界搜尋共用；建立任務時凍結）：元件組合（t2i）、尺寸、步數、guidance（Qwen 語意）、
// 負面提示詞、sigma、flow shift μ、解碼、預覽；以及「生成候選」的 seed 與候選種類。數字欄位打字時保留輸入，合法才更新。
import { Link } from "react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/controls";
import { PropertyGrid, PropertyRow } from "@/components/workbench/Inspector";
import { pipelinePath, PATHS } from "@/app/paths";
import { aspectMismatch, fitAspect, settingsProblems, type ImageRoute } from "../model/routes";
import { MAX_RENDER_IMAGES, renderSeedProblem, type RenderSeedDraft } from "../model/seeds";
import { VARIANT_LABELS } from "../model/sections";
import type { DecodeMode, GenerationSettings, PreviewMode, PromptVariant, SigmaSchedule } from "../types";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

/** 數字欄位：打字時保留原文，能解讀成範圍內的數字才回報；nullable 時空白＝null。 */
function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  step,
  integer = false,
  nullable = false,
  disabled,
  placeholder,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  nullable?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const external = value === null ? "" : String(value);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft && draft.base === external ? draft.text : external;
  const parsed = text.trim() === "" ? null : Number(text);
  const invalid = parsed === null ? !nullable : !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed));
  return (
    <Input
      id={id}
      compact
      inputMode="decimal"
      className="machine"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft({ base: external, text: raw });
        if (raw.trim() === "") {
          if (nullable) {
            setDraft({ base: "", text: raw });
            onChange(null);
          }
          return;
        }
        const next = Number(raw);
        if (Number.isFinite(next) && next >= min && next <= max && (!integer || Number.isInteger(next))) {
          setDraft({ base: String(next), text: raw });
          onChange(next);
        }
      }}
      step={step}
    />
  );
}

const SIZE_PRESETS = [512, 1024, 1536] as const;

export function GenerationSettingsForm({
  idPrefix,
  settings,
  onChange,
  routes,
  sourceSize,
  readOnly = false,
  routesLoading = false,
}: {
  idPrefix: string;
  settings: GenerationSettings;
  onChange: (next: GenerationSettings) => void;
  routes: readonly ImageRoute[];
  sourceSize: { width: number; height: number } | null;
  readOnly?: boolean;
  /** 元件組合或元件目錄還在讀取。 */
  routesLoading?: boolean;
}) {
  const set = <K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]) => onChange({ ...settings, [key]: value });
  const route = routes.find((item) => item.id === settings.route) ?? null;
  const problems = settingsProblems(settings);
  const fitted = sourceSize ? fitAspect(sourceSize.width, sourceSize.height) : null;
  const mismatch = aspectMismatch(sourceSize?.width ?? null, sourceSize?.height ?? null, settings);
  return (
    <div className="grid gap-2">
      <PropertyGrid>
        <PropertyRow label={t("元件組合")} htmlFor={`${idPrefix}-route`}>
          {routes.length === 0 && routesLoading ? (
            <span role="status" className="text-caption text-fg-secondary">
              {t("讀取元件組合…")}
            </span>
          ) : routes.length === 0 ? (
            <span className="text-caption text-warning">
              <T source={"沒有 qimg 文生圖元件組合（qimg.conditioning → qimg.dit → qimg.vae_decode → image.compose）：<0>到「元件組合」建立</0>"} slots={[<Link to={PATHS.pipelines} className="text-caption" />]} />
            </span>
          ) : (
            <>
              <Select id={`${idPrefix}-route`} compact value={settings.route} disabled={readOnly} onChange={(event) => set("route", event.target.value)}>
                {route === null ? <option value="">{t("選擇元件組合")}</option> : null}
                {routes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t("{label}（{id}）{value}", { label: item.label, id: item.id, value: item.ready ? "" : t(" · 不能用") })}
                  </option>
                ))}
              </Select>
              {route && !route.ready ? (
                <span className="text-caption text-warning">
                  {route.problems.join(t("；"))}{" "}
                  <Link to={pipelinePath(route.id)} className="text-caption">
                    {t("開啟元件組合")}
                  </Link>
                </span>
              ) : route?.ditComponentId ? (
                <span className="machine text-caption text-fg-tertiary">{t("DiT：{ditComponentId}", { ditComponentId: route.ditComponentId })}</span>
              ) : null}
            </>
          )}
        </PropertyRow>
        <PropertyRow label={t("尺寸")} htmlFor={`${idPrefix}-width`} hint={t("32 的倍數（qimg.dit），256–2048")}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
            <NumberField id={`${idPrefix}-width`} value={settings.width} onChange={(next) => next !== null && set("width", next)} min={256} max={2048} step={32} integer disabled={readOnly} />
            <span aria-hidden className="text-caption text-fg-tertiary">
              ×
            </span>
            <NumberField id={`${idPrefix}-height`} value={settings.height} onChange={(next) => next !== null && set("height", next)} min={256} max={2048} step={32} integer disabled={readOnly} />
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-1">
              {SIZE_PRESETS.map((size) => (
                <Button
                  key={size}
                  size="sm"
                  variant="quiet"
                  className="min-h-7 rounded-full px-2.5 aria-pressed:border-brand-blue/50 aria-pressed:bg-brand-gradient-soft aria-pressed:text-fg"
                  aria-pressed={settings.width === size && settings.height === size}
                  onClick={() => onChange({ ...settings, width: size, height: size })}
                >
                  {`${size}²`}
                </Button>
              ))}
              {fitted ? (
                <Button size="sm" variant="quiet" className="min-h-7 rounded-full px-2.5" title={t("依來源比例 {width}×{height}", { width: sourceSize?.width, height: sourceSize?.height })} onClick={() => onChange({ ...settings, ...fitted })}>
                  {t("依來源比例（{width}×{height}）", { width: fitted.width, height: fitted.height })}
                </Button>
              ) : null}
            </div>
          )}
          {mismatch ? <span className="text-caption text-warning">{t("來源比例 {width}×{height} 與輸出不同：構圖與裁切的比較會受限。", { width: sourceSize?.width, height: sourceSize?.height })}</span> : null}
        </PropertyRow>
        <PropertyRow label={t("步數")} htmlFor={`${idPrefix}-steps`}>
          <NumberField id={`${idPrefix}-steps`} value={settings.steps} onChange={(next) => next !== null && set("steps", next)} min={2} max={100} step={1} integer disabled={readOnly} />
        </PropertyRow>
        <PropertyRow label="guidance" htmlFor={`${idPrefix}-guidance`} hint={settings.guidance > 1 ? t("> 1：啟用負面提示詞，每步去噪 forward 加倍") : t("≤ 1：不用 CFG，負面提示詞不會使用")}>
          <NumberField id={`${idPrefix}-guidance`} value={settings.guidance} onChange={(next) => next !== null && set("guidance", next)} min={0} max={20} step={0.1} disabled={readOnly} />
        </PropertyRow>
        <PropertyRow label={t("負面提示詞")} htmlFor={`${idPrefix}-negative`}>
          <Textarea id={`${idPrefix}-negative`} compact rows={2} readOnly={readOnly} value={settings.negative_prompt} onChange={(event) => set("negative_prompt", event.target.value)} />
          {settings.negative_prompt.trim() && settings.guidance <= 1 ? <span className="text-caption text-fg-tertiary">{t("guidance ≤ 1：不會送出這段文字。")}</span> : null}
        </PropertyRow>
        <PropertyRow label={t("sigma 排程")} htmlFor={`${idPrefix}-sigma`}>
          <Select id={`${idPrefix}-sigma`} compact value={settings.sigma_schedule} disabled={readOnly} onChange={(event) => set("sigma_schedule", event.target.value as SigmaSchedule)}>
            <option value="native">native</option>
            <option value="karras">karras</option>
            <option value="exponential">exponential</option>
          </Select>
        </PropertyRow>
        <PropertyRow label="flow shift μ" htmlFor={`${idPrefix}-mu`} hint={t("留空＝依解析度自動")}>
          <NumberField id={`${idPrefix}-mu`} value={settings.flow_shift_mu} onChange={(next) => set("flow_shift_mu", next)} min={-1} max={3} step={0.05} nullable placeholder={t("自動")} disabled={readOnly} />
        </PropertyRow>
        <PropertyRow
          label={t("解碼")}
          htmlFor={`${idPrefix}-decode`}
          hint={settings.decode === "tiled" ? t("tiled 可能出現接縫；比較時接縫也會被判成差異") : t("full：整張一次解碼；解析度越高、峰值顯存越大，不夠時改用 tiled")}
        >
          <Select id={`${idPrefix}-decode`} compact value={settings.decode} disabled={readOnly} onChange={(event) => set("decode", event.target.value as DecodeMode)}>
            <option value="full">{t("full（整張）")}</option>
            <option value="tiled">{t("tiled（分塊）")}</option>
          </Select>
        </PropertyRow>
        <PropertyRow label={t("預覽")} htmlFor={`${idPrefix}-preview`} hint={settings.preview.mode === "linear_fit" ? t("需要先用自己的資料擬合係數；沒有時元件回 422") : t("預覽只用來看進度，不參與比較")}>
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-1.5">
            <Select id={`${idPrefix}-preview`} compact value={settings.preview.mode} disabled={readOnly} onChange={(event) => set("preview", { ...settings.preview, mode: event.target.value as PreviewMode })}>
              <option value="off">{t("關閉", undefined, { context: "toggle-off" })}</option>
              <option value="vae_thumbnail">vae_thumbnail</option>
              <option value="linear_fit">linear_fit</option>
            </Select>
            <NumberField
              id={`${idPrefix}-preview-every`}
              value={settings.preview.every}
              onChange={(next) => next !== null && set("preview", { ...settings.preview, every: next })}
              min={1}
              max={100}
              step={1}
              integer
              disabled={readOnly || settings.preview.mode === "off"}
            />
          </div>
        </PropertyRow>
      </PropertyGrid>
      {problems.length > 0 ? (
        <ul className="grid gap-0.5 text-caption text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function RenderSeedsForm({
  idPrefix,
  seeds,
  onSeeds,
  variants,
  onVariants,
  disabled,
}: {
  idPrefix: string;
  seeds: RenderSeedDraft;
  onSeeds: (next: RenderSeedDraft) => void;
  variants: readonly PromptVariant[];
  onVariants: (next: PromptVariant[]) => void;
  disabled?: boolean;
}) {
  const problem = renderSeedProblem(seeds);
  const toggleVariant = (variant: PromptVariant, on: boolean) => onVariants((["core", "detailed"] as const).filter((item) => (item === variant ? on : variants.includes(item))));
  return (
    <div className="grid gap-2">
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="mb-1 text-caption text-fg-secondary">{t("生成哪些候選（兩者用同一組 seed）")}</legend>
        {(["core", "detailed"] as const).map((variant) => (
          <Checkbox key={variant} id={`${idPrefix}-variant-${variant}`} label={VARIANT_LABELS[variant]} checked={variants.includes(variant)} disabled={disabled} onChange={(event) => toggleVariant(variant, event.target.checked)} className="min-h-8 py-1 text-data" />
        ))}
      </fieldset>
      <PropertyGrid>
        <PropertyRow label={t("seed 方式")} htmlFor={`${idPrefix}-seed-mode`}>
          <Select id={`${idPrefix}-seed-mode`} compact value={seeds.mode} disabled={disabled} onChange={(event) => onSeeds({ ...seeds, mode: event.target.value === "explicit" ? "explicit" : "batch" })}>
            <option value="batch">{t("起始 seed＋張數")}</option>
            <option value="explicit">{t("明確清單（可重複）")}</option>
          </Select>
        </PropertyRow>
        {seeds.mode === "batch" ? (
          <>
            <PropertyRow label={t("起始 seed")} htmlFor={`${idPrefix}-seed`} hint={t("-1＝隨機（實際值會記錄）")}>
              <Input id={`${idPrefix}-seed`} compact className="machine" inputMode="numeric" value={seeds.seed} disabled={disabled} onChange={(event) => onSeeds({ ...seeds, seed: event.target.value })} />
            </PropertyRow>
            <PropertyRow label={t("每個候選張數")} htmlFor={`${idPrefix}-count`} hint={`1–${MAX_RENDER_IMAGES}`}>
              <Input id={`${idPrefix}-count`} compact className="machine" inputMode="numeric" value={seeds.count} disabled={disabled} onChange={(event) => onSeeds({ ...seeds, count: event.target.value })} />
            </PropertyRow>
            <PropertyRow label={t("seed 變化")} htmlFor={`${idPrefix}-seed-change`}>
              <Select id={`${idPrefix}-seed-change`} compact value={seeds.seedMode} disabled={disabled} onChange={(event) => onSeeds({ ...seeds, seedMode: event.target.value as RenderSeedDraft["seedMode"] })}>
                <option value="increment">{t("遞增（每張 +1）")}</option>
                <option value="fixed">{t("固定（同一個 seed）")}</option>
                <option value="random">{t("每張隨機")}</option>
              </Select>
            </PropertyRow>
          </>
        ) : (
          <PropertyRow label={t("seed 清單")} htmlFor={`${idPrefix}-explicit`} hint={t("1–{maxRenderImages} 個，以逗號分隔", { maxRenderImages: MAX_RENDER_IMAGES })}>
            <Input id={`${idPrefix}-explicit`} compact className="machine" value={seeds.explicit} disabled={disabled} onChange={(event) => onSeeds({ ...seeds, explicit: event.target.value })} />
          </PropertyRow>
        )}
      </PropertyGrid>
      {problem ? <p className="text-caption text-danger">{problem}</p> : null}
      {variants.length === 0 ? <p className="text-caption text-danger">{t("至少選一種候選")}</p> : null}
    </div>
  );
}
