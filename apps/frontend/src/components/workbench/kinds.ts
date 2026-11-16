// 元件類型與資料型別的圖示／色調：同一種類型在資源樹、表格、Inspector、節點圖與紀錄來源都用同一組。
// 色調只標「類型」這個事實：文字／條件（TE、caption、scene、prompt）＝info、模型內部（latent、DiT、H3／Qwen-Image bundle）＝entity、
// 媒體檔案（影片、聲音、圖片）＝file、測試＝中性。
import {
  AudioLines,
  Blend,
  Box,
  Captions,
  Combine,
  Database,
  Eye,
  FileAudio,
  FileVideo,
  Film,
  FlaskConical,
  Image,
  ListChecks,
  ListVideo,
  NotebookPen,
  ScanEye,
  ScanLine,
  ScanSearch,
  Type,
  Waves,
  type LucideIcon,
} from "lucide-react";
import kindAudioDecode from "@/assets/icons/kind-audio-decode-v1.png";
import kindDitDenoise from "@/assets/icons/kind-dit-denoise-v1.png";
import kindMediaMux from "@/assets/icons/kind-media-mux-v1.png";
import kindTextCondition from "@/assets/icons/kind-text-condition-v1.png";
import kindVideoDecode from "@/assets/icons/kind-video-decode-v1.png";
import type { Tone } from "./tones";
import { t } from "@/i18n";

export interface KindSpec {
  icon: LucideIcon;
  tone: Tone;
  /** 類型的中文名稱（說明用，不取代 provider_id）。 */
  label: string;
  /** 客製圖示（透明 PNG）：只用在 28–40 px 的圖示磚；16 px 處一律用 icon。 */
  art?: string;
}

const PROVIDERS: Record<string, KindSpec> = {
  "h3.conditioning": { icon: Type, tone: "info", label: t("文字條件（TE）"), art: kindTextCondition },
  "h3.reference": { icon: Image, tone: "info", label: t("參考影像編碼") },
  "h3.video_encode": { icon: FileVideo, tone: "file", label: t("影片 VAE 編碼") },
  "h3.audio_encode": { icon: FileAudio, tone: "file", label: t("音訊 VAE 編碼") },
  "h3.dit": { icon: Waves, tone: "entity", label: t("DiT 去噪"), art: kindDitDenoise },
  "h3.video_decode": { icon: Film, tone: "file", label: t("影片 VAE 解碼"), art: kindVideoDecode },
  "h3.audio_decode": { icon: AudioLines, tone: "file", label: t("音訊 VAE 解碼"), art: kindAudioDecode },
  "media.mux": { icon: Combine, tone: "file", label: t("影音封裝"), art: kindMediaMux },
  "media.concat": { icon: ListVideo, tone: "file", label: t("序列接合"), art: kindMediaMux },
  "media.probe": { icon: ScanSearch, tone: "file", label: t("媒體探測") },
  "media.frame": { icon: Image, tone: "file", label: t("影格擷取") },
  "qwen_vl.describe": { icon: Eye, tone: "info", label: t("影片反推描述") },
  "caption.compile": { icon: Captions, tone: "info", label: t("caption 編譯") },
  "dataset.export": { icon: Database, tone: "file", label: t("資料集匯出") },
  // Qwen-Image（圖片生成、圖片反推）
  "qimg.prepare": { icon: ScanLine, tone: "file", label: t("圖片前處理") },
  "qimg.conditioning": { icon: Type, tone: "info", label: t("文字條件（Qwen-Image TE）"), art: kindTextCondition },
  "qimg.vae_encode": { icon: Blend, tone: "file", label: t("參考圖 VAE 編碼") },
  "qimg.dit": { icon: Waves, tone: "entity", label: t("DiT 去噪（Qwen-Image）"), art: kindDitDenoise },
  "qimg.vae_decode": { icon: Image, tone: "file", label: t("圖片 VAE 解碼") },
  "image.compose": { icon: Combine, tone: "file", label: t("圖片合成輸出") },
  "qimg.vision": { icon: ScanEye, tone: "info", label: t("圖片反推與評估（Qwen3-VL）") },
  "prompt.scene_compile": { icon: NotebookPen, tone: "info", label: t("Scene → prompt 編譯") },
  "prompt.scene_score": { icon: ListChecks, tone: "info", label: t("Scene 評分") },
};

const FALLBACK: KindSpec = { icon: Box, tone: "neutral", label: t("元件") };
const TEST: KindSpec = { icon: FlaskConical, tone: "neutral", label: t("測試／合成元件") };

/** 依 provider_id 取類型；`test.*` 一律是測試／合成元件。 */
export function providerKind(providerId: string | null | undefined): KindSpec {
  if (!providerId) return FALLBACK;
  if (providerId.startsWith("test.")) return TEST;
  return PROVIDERS[providerId] ?? FALLBACK;
}

/** 資料型別（type_id）的色調：接點、連線、型別標籤共用。 */
export function typeTone(typeId: string | null | undefined): Tone {
  if (!typeId) return "neutral";
  if (typeId.startsWith("test.")) return "neutral";
  if (typeId.startsWith("text.") || typeId.startsWith("caption.") || typeId.startsWith("video.scene") || typeId.startsWith("prompt.")) return "info";
  if (typeId.includes("final-latent") || typeId.startsWith("h3.") || typeId.startsWith("qimg.")) return "entity";
  if (typeId.startsWith("media.") || typeId.startsWith("dataset.") || typeId.startsWith("image.asset")) return "file";
  return "neutral";
}
