import { Headphones } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { StudioProject } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { useRun } from "@/api/runs";
import { asAsset, type RunRequestBody } from "@/api/types";
import { AssetAudio } from "@/components/common/AssetMedia";
import { linkedCaptions } from "@/components/common/linkedCaptions";
import { Button } from "@/components/ui/button";
import { t, tServer } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { AudioMixAudition } from "./AudioMixAudition";
import { exportDigest, exportSignature, readExportNote } from "./exportSnapshot";

interface AuditionProps {
  project: StudioProject;
  expected: RunRequestBody | null;
  blocked: string | null;
  submitting: boolean;
  render: () => Promise<void>;
  audioOnly: boolean;
}

function useSnapshotDigest(signature: string | null): string | null {
  const [result, setResult] = useState<{ signature: string | null; digest: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    void exportDigest(signature).then((digest) => {
      if (current) setResult({ signature, digest });
    });
    return () => { current = false; };
  }, [signature]);
  return result?.signature === signature ? result.digest : null;
}

export function ExportAudition({ project, expected, blocked, submitting, render, audioOnly }: AuditionProps) {
  const id = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [failedFile, setFailedFile] = useState("");
  const records = project.exports;
  const active = records.find((entry) => entry.run_id === picked) ?? records.at(-1);
  const query = useRun(active?.run_id ?? null);
  const run = query.data;
  const signature = exportSignature(expected);
  const digest = useSnapshotDigest(signature);
  const note = readExportNote(run?.request.origin?.note, project.project_id);
  const captured = run ? exportSignature(run.request) : null;
  const value = run?.request.inputs["sequence"];
  const sequence = value && "value" in value && isRecord(value.value) ? value.value : null;
  const full = sequence !== null && sequence["render_range"] == null;
  const same = full && signature !== null && (signature === captured || (digest !== null && digest === note?.digest));
  const output = run?.outputs["final"];
  const asset = run?.state === "succeeded" && isRecord(output) && output["type_id"] === "media.asset.v1" ? asAsset(output["value"]) : null;
  const concat = asset?.actual_settings["concat"];
  const measured = isRecord(concat) && concat["timeline"] === true ? (concat["audio_meter"] ?? concat["loudness"]) : null;
  const loudness = isRecord(measured) ? measured["output_lufs"] : null;
  const peak = isRecord(measured) ? measured["output_true_peak_dbtp"] : null;
  const parameters = run?.request.pipeline.steps[0]?.parameters;
  const target = parameters?.["loudness_lufs"];
  const bitrate = parameters?.["audio_bitrate"];
  const url = full && captured !== null && asset?.complete === true && isRecord(concat) && concat["timeline"] === true ? mediaUrl(asset.file.node_id, asset.file.file_id) : null;
  const currentRun = same && (run?.state === "running" || (url !== null && failedFile !== url));

  return <section className="grid gap-2 rounded-lg border border-line-subtle p-3" aria-labelledby={id}>
    <h3 id={id} className="flex items-center gap-2 text-data font-medium"><Headphones aria-hidden className="size-4" />{t("最終混音試聽")}</h3>
    <p className="text-caption text-fg-secondary">{t("播放完整序列匯出檔的 AAC 音軌。響度與真峰值量自成品。")}</p>
    {audioOnly && <AudioMixAudition expected={expected} blocked={blocked} projectId={project.project_id} />}
    {active ? <label className="grid gap-1 text-caption text-fg-secondary">
      {t("試聽的匯出紀錄")}
      <select className="min-h-10 w-full min-w-0 rounded-md border border-line-subtle bg-surface px-2 text-data text-fg" value={active.run_id} onChange={(event) => { setPicked(event.target.value); }}>
        {[...records].reverse().map((entry) => <option key={entry.run_id} value={entry.run_id}>{formatDateTime(entry.created_at)} · {entry.run_id.slice(0, 8)}</option>)}
      </select>
    </label> : null}
    {run ? <div role="status" className="grid gap-1 text-caption text-fg-secondary">
      <p>{note ? t("匯出時的專案版本 {revision}", { revision: note.revision }) : t("這筆匯出未記錄專案版本")}</p>
      <p>{full ? (same ? t("已核對，與目前完整序列及匯出設定相符。") : t("這是先前的匯出，尚未核對為目前的完整混音。")) : t("這筆匯出僅供區段使用，請建立完整序列試聽。")}</p>
      {full && parameters ? <p>{typeof target === "number" && target !== 0 ? t("響度目標 {lufs} LUFS", { lufs: target }) : t("不處理")}{typeof bitrate === "number" ? ` · ${String(bitrate / 1000)} kb/s AAC` : ""}</p> : null}
      {run.state === "running" ? <p>{t("正在產生匯出音軌…")}</p> : null}
      {run.error ? <p className="text-danger">{tServer(run.error.message)}</p> : null}
    </div> : null}
    {query.isError ? <p role="alert" className="text-caption text-danger">{errorText(query.error)}</p> : null}
    {url !== null ? <>
      <AssetAudio key={url} captions={linkedCaptions(asset?.file.metadata)} controls preload="none" className="w-full" src={url} aria-label={t("最終混音試聽")} onError={() => { setFailedFile(url); }} />
      {failedFile === url ? <p role="alert" className="text-caption text-danger">{t("無法播放這筆匯出的音軌。")}</p> : null}
      <p className="text-caption text-fg-secondary">{typeof loudness === "number" || typeof peak === "number"
        ? t("成品實測 {lufs} LUFS · {peak} dBTP", { lufs: typeof loudness === "number" ? loudness : "—", peak: typeof peak === "number" ? peak : "—" })
        : t("此匯出沒有可用的成品響度量測。")}</p>
    </> : null}
    {currentRun ? null : <Button type="button" variant="secondary" size="sm" className="justify-self-start" disabled={blocked !== null || submitting || expected === null} title={blocked ?? undefined} onClick={() => { setPicked(null); void render(); }}>
      {t("建立完整序列試聽")}
    </Button>}
  </section>;
}
