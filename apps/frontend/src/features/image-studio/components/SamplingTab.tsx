// 屬性「採樣」分頁：步數、guidance（Qwen 的語意：≤ 1 不用 CFG；> 1 開啟負面提示詞、每步前向加倍）、sigma 排程、
// flow shift μ、解碼方式（完整／分塊，分塊可能有接縫）、中間預覽（VAE 縮圖／線性擬合／關閉）與間隔。
// 每個選擇都是明確的參數，元件不支援時由元件回 422，這裡不自動改值。固定的說明在欄位與區段標題旁的 ⓘ；面板上只留與
// 狀態有關的提醒（CFG 開啟的計算量、解碼方式在這個尺寸的風險、會擋下生成的預覽設定與改法）。
import { Gauge, ImageDown, Info, ScanEye, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { SectionTitle } from "@/features/studio-shell";
import { useImageStudio } from "../imageStudioContext";
import { DECODE_LABELS, LIMITS, LINEAR_FIT_UNAVAILABLE, PREVIEW_LABELS, SIGMA_LABELS } from "../model/constants";
import { findImageRoute } from "../model/routes";
import { cfgEnabled, forwardsPerStep } from "../model/shots";
import { DECODE_INFO, decodeWarning, fullDecodeTooLarge } from "../model/size";
import type { PreviewMode, SigmaSchedule, StudioImageShot } from "../types";
import { Hint, NumberField, Row, Segmented } from "./fields";
import { InfoTip } from "./InfoTip";
import { t } from "@/i18n";

const SIGMAS: readonly SigmaSchedule[] = ["native", "karras", "exponential"];
const PREVIEWS: readonly PreviewMode[] = ["vae_thumbnail", "linear_fit", "off"];

/** 提示裡的幾段說明，一段一行。 */
const lines = (items: readonly string[]) =>
  items.map((line) => (
    <span key={line} className="block">
      {line}
    </span>
  ));

export function SamplingTab({ shot }: { shot: StudioImageShot }) {
  const { dispatch, engine } = useImageStudio();
  const id = useId();
  const update = (patch: Partial<StudioImageShot>) => dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch });
  const route = findImageRoute(engine.routes, shot.route);
  const decode = decodeWarning(shot.width, shot.height, shot.decode);
  const previewInfo = [
    t("預覽只在生成中顯示、標示「預覽（非最終結果）」；最終圖片一律由完整的 VAE 解碼與合成輸出。"),
    LINEAR_FIT_UNAVAILABLE ? t("線性擬合：{linearFitUnavailable}", { linearFitUnavailable: LINEAR_FIT_UNAVAILABLE }) : null,
  ].filter((line): line is string => line !== null);
  return (
    <div className="grid gap-4 p-3">
      <div className="grid gap-2.5">
        <SectionTitle icon={Gauge}>{t("採樣")}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Row label={t("採樣步數")} htmlFor={`${id}-steps`} info={t("Qwen 至少 {min} 步", { min: LIMITS.steps.min })}>
            <NumberField id={`${id}-steps`} integer min={LIMITS.steps.min} max={LIMITS.steps.max} value={shot.steps} onCommit={(value) => update({ steps: value ?? shot.steps })} />
          </Row>
          <Row
            label="Guidance"
            htmlFor={`${id}-guidance`}
            info={t("範圍 {min}–{max}。1 以下不用 CFG（不使用負面提示詞，每步 DiT 前向 1 次；Qwen-Image 2.1 原生就是不用 guidance 採樣）；大於 1 開啟 CFG，每步前向 2 次。", {
              min: LIMITS.guidance.min,
              max: LIMITS.guidance.max,
            })}
          >
            <NumberField id={`${id}-guidance`} min={LIMITS.guidance.min} max={LIMITS.guidance.max} value={shot.guidance} onCommit={(value) => update({ guidance: value ?? shot.guidance })} />
          </Row>
        </div>
        {/* CFG 開啟時每步的計算量加倍：與狀態有關，留在面板上 */}
        {cfgEnabled(shot.guidance) ? (
          <Hint tone="info" icon={<Info aria-hidden />}>
            {t("CFG 開啟：負面提示詞會被編碼，每步 DiT 前向 {guidance} 次（計算量約加倍）。", { guidance: forwardsPerStep(shot.guidance) })}
          </Hint>
        ) : null}
        <Row label={t("Sigma 排程")} htmlFor={`${id}-sigma`} info={t("原生排程是模型建議；實驗排程不保證提升畫質。")}>
          <Select id={`${id}-sigma`} compact value={shot.sigma_schedule} onChange={(event) => update({ sigma_schedule: event.target.value as SigmaSchedule })}>
            {SIGMAS.map((sigma) => (
              <option key={sigma} value={sigma}>
                {SIGMA_LABELS[sigma]}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t("Flow shift μ（{min}～{max}）", { min: LIMITS.flowShift.min, max: LIMITS.flowShift.max })} htmlFor={`${id}-mu`} info={t("空白＝依解析度自動（模型原生位移）；手動值會記在 take。")}>
          <NumberField id={`${id}-mu`} allowEmpty placeholder={t("自動")} min={LIMITS.flowShift.min} max={LIMITS.flowShift.max} value={shot.flow_shift_mu} onCommit={(value) => update({ flow_shift_mu: value })} />
        </Row>
      </div>

      <div className="grid gap-2">
        <SectionTitle icon={ImageDown} actions={<InfoTip label={t("VAE 解碼")}>{lines(DECODE_INFO)}</InfoTip>}>
          {t("VAE 解碼")}
        </SectionTitle>
        <Segmented
          name={`${id}-decode`}
          label={t("解碼方式")}
          value={shot.decode}
          onChange={(value) => update({ decode: value })}
          options={[
            { value: "full", label: DECODE_LABELS.full },
            { value: "tiled", label: DECODE_LABELS.tiled },
          ]}
        />
        {decode ? (
          <div className="grid gap-1.5">
            <Hint tone="warning" icon={<TriangleAlert aria-hidden />}>
              {decode}
            </Hint>
            {shot.decode === "full" && fullDecodeTooLarge(shot.width, shot.height) ? (
              <Button size="sm" variant="secondary" className="justify-self-start" onClick={() => update({ decode: "tiled" })}>
                {t("改成分塊解碼")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-2">
        <SectionTitle icon={ScanEye} actions={<InfoTip label={t("中間預覽")}>{lines(previewInfo)}</InfoTip>}>
          {t("中間預覽")}
        </SectionTitle>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
          <Row label={t("預覽方式")} htmlFor={`${id}-preview`}>
            <Select id={`${id}-preview`} compact value={shot.preview.mode} onChange={(event) => update({ preview: { ...shot.preview, mode: event.target.value as PreviewMode } })}>
              {PREVIEWS.map((mode) => (
                <option key={mode} value={mode} disabled={mode === "linear_fit" && LINEAR_FIT_UNAVAILABLE !== null && shot.preview.mode !== "linear_fit"}>
                  {`${PREVIEW_LABELS[mode]}${mode === "linear_fit" && LINEAR_FIT_UNAVAILABLE ? t("（不可用）") : ""}`}
                </option>
              ))}
            </Select>
          </Row>
          <Row label={t("每 N 步")} htmlFor={`${id}-every`}>
            <NumberField
              id={`${id}-every`}
              integer
              disabled={shot.preview.mode === "off"}
              min={LIMITS.previewEvery.min}
              max={LIMITS.previewEvery.max}
              value={shot.preview.every}
              onCommit={(value) => update({ preview: { ...shot.preview, every: value ?? shot.preview.every } })}
            />
          </Row>
        </div>
        {shot.preview.mode === "vae_thumbnail" && route?.previewVae === false ? (
          <div className="grid gap-1.5 animate-fade-in">
            <Hint tone="warning" icon={<TriangleAlert aria-hidden />}>
              {t("這個 DiT（{value}）沒有載入預覽 VAE（preview_vae）：生成時不會有中間預覽（最終圖片不受影響）。", { value: route.ditComponent?.component_id ?? "?" })}
            </Hint>
            <Button size="sm" variant="secondary" className="justify-self-start" onClick={() => update({ preview: { ...shot.preview, mode: "off" } })}>
              {t("改成關閉預覽")}
            </Button>
          </div>
        ) : null}
        {shot.preview.mode === "linear_fit" && LINEAR_FIT_UNAVAILABLE ? (
          <div className="grid gap-1.5 animate-fade-in">
            <Hint tone="warning" icon={<TriangleAlert aria-hidden />}>
              {t("這張圖片的預覽設成線性擬合（例如載入了舊的參數），目前不能用，生成會被擋下。")}
            </Hint>
            <Button size="sm" variant="secondary" className="justify-self-start" onClick={() => update({ preview: { ...shot.preview, mode: route?.previewVae === false ? "off" : "vae_thumbnail" } })}>
              {route?.previewVae === false ? t("改成關閉預覽") : t("改成 VAE 縮圖")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
