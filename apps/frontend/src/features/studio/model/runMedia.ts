import type { FileRef } from "@/api/generated/contracts";
import { asAsset, asTypedValueMap, isFileRef, type WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";

interface PublishedMedium {
  port: string;
  file: FileRef;
  kind: "image" | "audio" | "video";
  timed: boolean;
}

/** Outputs the Controller can verify against the producing step's receipt. */
export function publishedMedia(run: WireRun): PublishedMedium[] {
  if (run.state !== "succeeded") return [];
  return Object.entries(asTypedValueMap(run.outputs)).flatMap<PublishedMedium>(([port, typed]) => {
    const payload = "value" in typed && isRecord(typed.value) ? typed.value : null;
    const file = "file" in typed ? typed.file : payload?.["file"];
    if (!isFileRef(file)) return [];
    const kind = file.media_type.split("/")[0];
    if (kind !== "audio" && kind !== "image" && kind !== "video") return [];
    let timed = false;
    if (typed.type_id === "media.asset.v1") {
      const asset = asAsset(payload);
      if (asset?.complete !== true) return [];
      timed = kind === "video" && (asset.kind === "video" || asset.kind === "final") && asset.fps !== null && asset.frame_count > 0;
    } else if (typed.type_id === "media.audio.v1" && kind === "audio") {
      const count = file.metadata["sample_count"];
      const rate = file.metadata["sample_rate"];
      timed = typeof count === "number" && Number.isSafeInteger(count) && count > 0 && typeof rate === "number" && Number.isSafeInteger(rate) && rate > 0 && rate <= 768000 && count <= rate * 86400;
    } else if (typed.type_id !== `media.${kind}.v1` && typed.type_id !== "file.attachment.v1" && !(typed.type_id === "image.asset.v1" && kind === "image")) return [];
    return [{ port, kind, file, timed }];
  });
}
