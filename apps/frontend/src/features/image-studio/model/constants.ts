// Image Studio 的固定值：provider、型別、參數範圍與預設值。
// 純資料；畫面文字與驗證都從這裡取同一組數字。
import type { DecodeMode, PreviewMode, SeedMode, SigmaSchedule } from "../types";
import { t } from "@/i18n";

/** Qwen-Image（phasyn_qimg）的 provider。Image Studio 依 provider 判斷步驟的角色，不依步驟 id。 */
export const IMAGE_PROVIDER = {
  prepare: "qimg.prepare",
  te: "qimg.conditioning",
  venc: "qimg.vae_encode",
  dit: "qimg.dit",
  decode: "qimg.vae_decode",
  compose: "image.compose",
} as const;

export type ImageStepRole = keyof typeof IMAGE_PROVIDER;

export const ROLE_BY_PROVIDER: Readonly<Record<string, ImageStepRole>> = Object.fromEntries(
  Object.entries(IMAGE_PROVIDER).map(([role, provider]) => [provider, role as ImageStepRole]),
);

export const ROLE_LABELS: Record<ImageStepRole, string> = {
  prepare: t("前處理"),
  te: t("文字條件"),
  venc: t("參考編碼"),
  dit: t("DiT 去噪"),
  decode: t("VAE 解碼"),
  compose: t("合成輸出"),
};

export const PROMPT_TYPE = "text.prompt.v1";
export const IMAGE_ASSET_TYPE = "image.asset.v1";

/** 元件組合輸出名稱（image、image_white）；批次時加 _0、_1…。 */
export const OUTPUT_IMAGE = "image";
export const OUTPUT_WHITE = "image_white";

export const LIMITS = {
  /** qimg.prepare／qimg.dit 的寬高：256–2048、32 的倍數（Qwen-Image 2.1 一個 VLM 影像槽＝2×2 latent token）。 */
  side: { min: 256, max: 2048, multiple: 32 },
  batch: { min: 1, max: 8 },
  steps: { min: 2, max: 100 },
  guidance: { min: 0, max: 20 },
  flowShift: { min: -1, max: 3 },
  referenceResolution: { min: 256, max: 1536 },
  previewEvery: { min: 1, max: 100 },
  references: 4,
  seed: { min: -1, max: 2_147_483_647 },
  prompt: 16_384,
  shots: 500,
  takes: 200,
  library: 500,
} as const;

export const RANDOM_SEED = -1;

export const REFERENCE_RESOLUTIONS = [256, 384, 512, 768, 1024, 1280, 1536] as const;

export const DEFAULTS = {
  width: 1024,
  height: 1024,
  steps: 40,
  guidance: 1,
  seed: RANDOM_SEED,
  seedMode: "increment" as SeedMode,
  batch: 1,
  sigma: "native" as SigmaSchedule,
  referenceResolution: 1024,
  decode: "full" as DecodeMode,
  preview: { mode: "vae_thumbnail" as PreviewMode, every: 5 },
} as const;

export const MODE_LABELS = { t2i: t("文生圖"), i2i: t("圖生圖") } as const;

export const SEED_MODE_LABELS: Record<SeedMode, string> = { increment: t("依序 +1"), fixed: t("固定相同"), random: t("每張隨機") };

export const SIGMA_LABELS: Record<SigmaSchedule, string> = { native: t("原生建議"), karras: t("Karras・實驗"), exponential: t("Exponential・實驗") };

export const DECODE_LABELS: Record<DecodeMode, string> = { full: t("完整解碼"), tiled: t("分塊解碼") };

export const PREVIEW_LABELS: Record<PreviewMode, string> = {
  vae_thumbnail: t("VAE 縮圖（CPU）"),
  linear_fit: t("線性擬合"),
  off: t("關閉預覽"),
};

/**
 * 線性擬合預覽需要用我們自己的生成結果擬合的係數（runtimes/qimg/tools/fit_preview_coefficients.py）；還沒擬合前
 * qimg.dit 會回 422。擬合並部署係數後改成 null（就能選）。
 */
export const LINEAR_FIT_UNAVAILABLE: string | null = t("還沒有用我們自己的生成結果擬合係數：DiT 會回 422（擬合後才能選）");

/** qimg.prepare 的參考圖清單型別（inline：[{file: FileRef, label?}]，1–4 張，順序＝送出順序）。 */
export const REFERENCES_TYPE = "qimg.references.v1";

/** image.compose 的 metadata 參數上限（canonical JSON ≤ 64 KiB；留餘裕）。 */
export const COMPOSE_METADATA_BUDGET = 48 * 1024;

export const VARIANT_LABELS: Record<string, string> = { bf16: "BF16", gguf_q4km: "GGUF Q4_K_M" };

export function variantLabel(variant: string | null): string {
  if (!variant) return t("精度未知");
  return VARIANT_LABELS[variant] ?? variant;
}
