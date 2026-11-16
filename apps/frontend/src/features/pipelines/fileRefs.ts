// 從近期 run 的輸入／輸出收集可重用的 FileRef（例如上次的影片、final latent），供 run 表單挑選。
import type { FileRef } from "@/api/generated/contracts";
import { asAsset, asTypedValueMap, runSteps, type WireRun, type WireTypedValue } from "@/api/types";
import { runDisplayName } from "@/lib/runName";
import { t } from "@/i18n";

export interface FileCandidate {
  key: string;
  value: { type_id: string; file: FileRef };
  runId: string;
  runLabel: string;
  where: string;
  createdAt: string;
  note: string | null;
}

/** 依 type_id 收集；media.video.v1／media.audio.v1 也接受 Asset 內的檔（明確標示來源是 Asset）。 */
export function collectFileCandidates(runs: readonly WireRun[], typeId: string): FileCandidate[] {
  const seen = new Set<string>();
  const out: FileCandidate[] = [];
  const add = (run: WireRun, where: string, typed: WireTypedValue) => {
    let file: FileRef | null = null;
    let note: string | null = null;
    if (typed.type_id === typeId && "file" in typed) file = typed.file;
    else if (typed.type_id === "media.asset.v1" && "value" in typed && (typeId === "media.video.v1" || typeId === "media.audio.v1")) {
      const asset = asAsset(typed.value);
      const family = typeId === "media.video.v1" ? "video/" : "audio/";
      if (asset && asset.file.media_type.startsWith(family)) {
        file = asset.file;
        note = t("來自 Asset（{kind}{value}）的檔案", { kind: asset.kind, value: asset.complete ? "" : t("，未完成") });
      }
    }
    if (!file) return;
    const key = `${file.node_id}/${file.file_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, value: { type_id: typeId, file }, runId: run.run_id, runLabel: runDisplayName(run), where, createdAt: run.created_at, note });
  };
  for (const run of runs) {
    for (const [name, typed] of Object.entries(asTypedValueMap(run.outputs))) add(run, t("輸出 {name}", { name }), typed);
    for (const step of runSteps(run)) {
      for (const [port, typed] of Object.entries(step.outputs)) add(run, `${step.step_id}.${port}`, typed);
    }
    for (const [name, typed] of Object.entries(asTypedValueMap(run.request.inputs))) add(run, t("輸入 {name}", { name }), typed);
  }
  return out;
}

/** 上傳時 <input accept>；不限制時回傳 undefined。 */
export function acceptFor(typeId: string): string | undefined {
  if (typeId === "media.video.v1") return "video/*";
  if (typeId === "media.image.v1") return "image/*";
  if (typeId === "media.audio.v1") return "audio/*";
  if (typeId === "video.scene.v1" || typeId.endsWith("final-latent.v1") || typeId === "dataset.manifest.v1") return "application/json,.json";
  return undefined;
}

/** 檔案 MIME 與 type_id 家族不符時的提醒（不阻擋）。 */
export function mediaMismatch(typeId: string, mediaType: string): string | null {
  const families: Record<string, string> = { "media.video.v1": "video/", "media.image.v1": "image/", "media.audio.v1": "audio/" };
  const family = families[typeId];
  if (family && !mediaType.startsWith(family)) return t("檔案型別 {value} 不像 {typeId}（預期 {family}*）；伺服器或元件可能拒絕", { value: mediaType || t("未知"), typeId, family });
  if (typeId.endsWith("final-latent.v1")) return t("final latent 通常應從上一次 run 的輸出挑選：手動上傳的 manifest 沒有連結原始 blob");
  return null;
}

export function defaultMode(typeId: string, transport: "inline" | "file" | "either"): "inline" | "file" {
  if (transport === "inline") return "inline";
  if (transport === "file") return "file";
  return typeId.startsWith("text.") || typeId.startsWith("caption.") ? "inline" : typeId.startsWith("media.") || typeId.includes("latent") ? "file" : "inline";
}
