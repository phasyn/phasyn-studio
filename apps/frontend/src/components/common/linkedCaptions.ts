import { mediaUrl } from "@/api/http";
import { isFileRef } from "@/api/types";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";

export interface CaptionTrack {
  src: string;
  label: string;
  srcLang?: string;
}

/** Only a real, explicitly linked WebVTT caption asset belongs in the native track menu. */
export function linkedCaptions(metadata: unknown): CaptionTrack | undefined {
  if (!isRecord(metadata) || !isRecord(metadata["links"])) return undefined;
  const file = metadata["links"]["captions"];
  if (!isFileRef(file) || file.media_type.split(";")[0]?.trim().toLowerCase() !== "text/vtt") return undefined;
  const language = file.metadata["language"];
  return { src: mediaUrl(file.node_id, file.file_id), label: t("字幕"), ...(typeof language === "string" && language !== "" ? { srcLang: language } : {}) };
}
