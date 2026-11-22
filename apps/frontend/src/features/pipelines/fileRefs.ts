// 從近期 run 的輸入／輸出收集可重用的 FileRef（例如上次的影片、final latent），供 run 表單挑選。
import type { FileRef } from "@/api/generated/contracts";
import { asAsset, asTypedValueMap, runSteps, type WireRun, type WireTypedValue } from "@/api/types";
import { runDisplayName, runDisplayNameWithId } from "@/lib/runName";
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
      if (asset?.file.media_type.startsWith(family) === true) {
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

/** Match a decoded Asset to the completed run that emitted its exact latent manifest. */
function latentProducers(runs: readonly WireRun[]): Map<string, WireRun | null> {
  const producers = new Map<string, WireRun | null>();
  for (const run of runs) {
    for (const output of Object.values(asTypedValueMap(run.outputs))) {
      if (output.type_id !== "video.final-latent.v1" || !("file" in output)) continue;
      const key = manifestKey(output.file);
      const previous = producers.get(key);
      producers.set(key, previous === undefined || previous?.run_id === run.run_id ? run : null);
    }
  }
  return producers;
}

function manifestKey(file: FileRef): string {
  return JSON.stringify([file.node_id, file.file_id, file.sha256]);
}

export interface InlineCandidate {
  key: string;
  runId: string;
  label: string;
  typed: WireTypedValue;
}

/** Keep the original typed value, including the Asset's complete settings and file references. */
export function inlineOutputs(runs: readonly WireRun[], typeId: string): InlineCandidate[] {
  const completed = runs.filter((run) => run.state === "succeeded");
  const producers = typeId === "media.asset.v1" ? latentProducers(completed) : null;
  return completed.flatMap((run) =>
    Object.entries(asTypedValueMap(run.outputs)).flatMap(([port, typed]) => {
      if (typed.type_id !== typeId || !("value" in typed)) return [];
      const asset = typeId === "media.asset.v1" ? asAsset(typed.value) : null;
      if (typeId === "media.asset.v1" && !(asset?.complete === true)) return [];
      const latent = asset?.source_latent;
      const file = latent?.manifest_file;
      const fingerprint = latent?.manifest_sha256;
      const label = [runDisplayNameWithId(run), port];
      if (file != null) {
        const producer = fingerprint === file.sha256 ? producers?.get(manifestKey(file)) : undefined;
        if (producer) label.push(t("來源 latent：{run}", { run: runDisplayNameWithId(producer) }));
      }
      return [{ key: JSON.stringify([run.run_id, port]), label: label.join(" · "), runId: run.run_id, typed }];
    }),
  );
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
  if ((family != null && family !== "") && !mediaType.startsWith(family)) return t("檔案型別 {value} 不像 {typeId}（預期 {family}*）；伺服器或元件可能拒絕", { value: mediaType || t("未知"), typeId, family });
  if (typeId.endsWith("final-latent.v1")) return t("final latent 通常應從上一次 run 的輸出挑選：手動上傳的 manifest 沒有連結原始 blob");
  return null;
}

export function defaultMode(typeId: string, transport: "inline" | "file" | "either"): "inline" | "file" {
  if (transport === "inline") return "inline";
  if (transport === "file") return "file";
  return typeId.startsWith("text.") || typeId.startsWith("caption.") ? "inline" : typeId.startsWith("media.") || typeId.includes("latent") ? "file" : "inline";
}
