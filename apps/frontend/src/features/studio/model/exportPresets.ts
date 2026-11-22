import { toJsonObject as record } from "@/lib/json";
// 序列匯出的設定選項（media.concat：libx264＋aac 重新編碼成 MP4）。數值直接對應元件的 invoke 參數：
// crf（0–51，越小畫質越好、檔案越大）、preset（x264 速度）、audio_bitrate（bps，不是 kbps）。
import type { ExportOptions } from "./pipelines";
import { t } from "@/i18n";

export type QualityId = "high" | "standard" | "small";
export type SpeedId = "medium" | "veryfast";

export const QUALITY_PRESETS: readonly { id: QualityId; label: string; crf: number; hint: string }[] = [
  { id: "high", label: t("高畫質"), crf: 18, hint: t("crf 18（元件預設）：畫質最好，檔案最大") },
  { id: "standard", label: t("標準"), crf: 23, hint: t("crf 23：畫質與檔案大小平衡") },
  { id: "small", label: t("小檔"), crf: 28, hint: t("crf 28：檔案最小，細節與暗部較糊") },
];

export const SPEED_PRESETS: readonly { id: SpeedId; label: string; preset: NonNullable<ExportOptions["preset"]>; hint: string }[] = [
  { id: "medium", label: t("標準速度"), preset: "medium", hint: t("preset medium（元件預設）：同畫質下檔案較小") },
  { id: "veryfast", label: t("快速"), preset: "veryfast", hint: t("preset veryfast：編碼較快，同畫質下檔案較大") },
];

/** 音訊位元率（bps）；192000 是元件預設。 */
export const AUDIO_BITRATES: readonly number[] = [128_000, 192_000, 256_000];

export const DEFAULT_EXPORT_CHOICE = { quality: "high" as QualityId, speed: "medium" as SpeedId, audioBitrate: 192_000, loudness: 0 };

/** 響度正規化目標（LUFS；0＝不處理，照混音原樣輸出）。兩階段 loudnorm、線性增益、真峰值 −1.5 dBTP。 */
export const LOUDNESS_TARGETS: readonly { lufs: number; label: string; hint: string }[] = [
  { lufs: 0, label: t("不處理"), hint: t("照混音原樣輸出（預設）") },
  { lufs: -14, label: "−14 LUFS", hint: t("影片母帶、串流平台") },
  { lufs: -16, label: "−16 LUFS", hint: t("網頁影片") },
  { lufs: -18, label: "−18 LUFS", hint: t("較安靜、保留更多動態") },
];

export function formatBitrate(bps: number): string {
  return `${String(Math.round(bps / 1000))} kbps`;
}

/** 選項 → media.concat 參數。一律明確送出，run 的請求本身就記錄了這次用的設定。 */
export function exportOptionsFor(quality: QualityId, speed: SpeedId, audioBitrate: number, loudness = 0): ExportOptions {
  return {
    crf: QUALITY_PRESETS.find((item) => item.id === quality)?.crf ?? 18,
    preset: SPEED_PRESETS.find((item) => item.id === speed)?.preset ?? "medium",
    audioBitrate,
    ...(loudness ? { loudnessLufs: loudness } : {}),
  };
}


function numberAt(object: Record<string, unknown> | null, key: string): number | null {
  const value = object?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 依元件回報的 parameters_schema 檢查選項；元件不接受的值會被主控以 422 拒絕，這裡先說明原因。
 * 拿不到 schema（例如元件不存在）時不判斷，由「匯出元件無法使用」的原因說明。
 */
export function exportOptionIssues(options: ExportOptions, schema: unknown): string[] {
  const root = record(schema);
  const properties = record(root?.["properties"]);
  if (!root || !properties) return [];
  const strict = root["additionalProperties"] === false;
  const issues: string[] = [];
  const checkRange = (key: string, label: string, value: number | undefined, show: (n: number) => string) => {
    if (value === undefined) return;
    const spec = record(properties[key]);
    if (!spec) {
      if (strict) issues.push(t("匯出元件不接受「{label}」參數", { label }));
      return;
    }
    const min = numberAt(spec, "minimum");
    const max = numberAt(spec, "maximum");
    if ((min !== null && value < min) || (max !== null && value > max)) {
      issues.push(t("匯出元件的{label}只接受 {value}–{value2}（目前 {show}）", { label, value: min !== null ? show(min) : "—", value2: max !== null ? show(max) : "—", show: show(value) }));
    }
  };
  checkRange("crf", t("畫質（crf）"), options.crf, String);
  checkRange("audio_bitrate", t("音訊位元率"), options.audioBitrate, formatBitrate);
  // An older Node's media.concat has no loudness_lufs: say so instead of sending a run it would refuse
  if (Boolean(options.loudnessLufs) && !record(properties["loudness_lufs"])) issues.push(t("這個節點的匯出元件還不支援響度正規化；請先更新節點，或選「不處理」"));
  if (options.preset !== undefined) {
    const spec = record(properties["preset"]);
    const values: unknown = spec?.["enum"];
    const allowed = Array.isArray(values) ? (values as unknown[]) : null;
    if (!spec && strict) issues.push(t("匯出元件不接受「編碼速度（preset）」參數"));
    else if (allowed && !allowed.includes(options.preset)) issues.push(t("匯出元件不接受編碼速度 {preset}", { preset: options.preset }));
  }
  return issues;
}
