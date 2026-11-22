// The final mix audition: every audio track of the whole sequence mixed by the export component into one AAC file
// (audio_only), without encoding the picture. It says whether the file it plays still matches the current mix, lets the
// owner make a new one, and keeps earlier auditions of this project to compare with.
import { Headphones, RefreshCw } from "lucide-react";
import { use, useState } from "react";
import { mediaUrl } from "@/api/http";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import { asAsset, type RunRequestBody } from "@/api/types";
import { AssetAudio } from "@/components/common/AssetMedia";
import { ActionButton } from "@/components/common/ActionButton";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/controls";
import { t, tServer } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { wireDefinitions } from "@/lib/contractSchemas";
import { audioMixSignature } from "./exportSnapshot";

function measured(settings: Record<string, unknown> | undefined): { lufs: number | null; peak: number | null } {
  const concat = settings?.["concat"];
  const meter = isRecord(concat) ? (concat["audio_meter"] ?? concat["loudness"]) : null;
  const read = (key: string) => (isRecord(meter) && typeof meter[key] === "number" ? meter[key] : null);
  return { lufs: read("output_lufs"), peak: read("output_true_peak_dbtp") };
}

export function AudioMixAudition({ expected, blocked, projectId }: {
  expected: RunRequestBody | null;
  blocked: string | null;
  projectId: string;
}) {
  const create = useCreateRun();
  const definitions = use(wireDefinitions());
  const history = useRunList(25, "include", { project_id: projectId, operation_kind: "audio_mix" }, "summary");
  const jobs = history.data?.pages.flatMap(page => page.items) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? jobs[0]?.run_id ?? null;
  const signature = audioMixSignature(expected, definitions);
  const query = useRun(id);
  const run = query.data;
  const output = run?.outputs["final"];
  const asset = run?.state === "succeeded" && isRecord(output) && output["type_id"] === "media.asset.v1" ? asAsset(output["value"]) : null;
  const audio = asset?.complete === true && asset.kind === "audio" && asset.file.media_type === "audio/mp4" ? asset.file : null;
  const current = signature !== null && run !== undefined && audioMixSignature(run.request, definitions) === signature;
  const running = run?.state === "running" || create.isPending;
  const meter = measured(asset?.actual_settings);
  function submit() {
    if (!expected || signature === null || blocked !== null || running) return;
    const request = { ...expected, pipeline: { ...expected.pipeline, pipeline_id: "studio-audio-mix",
      steps: expected.pipeline.steps.map(step => ({ ...step, parameters: { ...step.parameters, audio_only: true } })) },
      origin: { studio_work: { project_id: projectId, operation_kind: "audio_mix" as const }, note: JSON.stringify({ type: "studio.audio-mix.v1", project_id: projectId }) }, label: t("純音訊混音試聽") };
    create.mutate(request, { onSuccess: created => { setPicked(created.run_id); } });
  }
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <ActionButton variant={current && audio ? "secondary" : "primary"} icon={audio ? <RefreshCw aria-hidden /> : <Headphones aria-hidden />}
        pending={running} disabledReason={blocked ?? (expected === null ? t("目前的序列還不能混音") : null)} onClick={submit}>
        {running ? t("正在混音…") : audio ? t("重新產生混音試聽") : t("產生混音試聽")}
      </ActionButton>
      {run && audio ? (current
        ? <Badge tone="success">{t("與目前混音相符")}</Badge>
        : <Badge tone="warning">{t("混音已變更，這是較早的版本")}</Badge>) : null}
    </div>
    {audio ? <div className="grid gap-1.5">
      <AssetAudio key={audio.file_id} controls preload="metadata" aria-label={t("最終混音試聽")} src={mediaUrl(audio.node_id, audio.file_id)} className="w-full" />
      {meter.lufs !== null || meter.peak !== null ? <p className="text-caption text-fg-secondary">
        {t("成品實測 {lufs} LUFS・真峰值 {peak} dBTP", { lufs: meter.lufs ?? "—", peak: meter.peak ?? "—" })}
      </p> : null}
    </div> : null}
    {jobs.length > 1 ? <label className="grid gap-1 text-caption text-fg-secondary">
      {t("較早的試聽")}
      <Select compact value={id ?? ""} onChange={event => { setPicked(event.target.value); }}>
        {jobs.map(item => <option key={item.run_id} value={item.run_id}>{formatDateTime(item.created_at)}{item.state === "running" ? t("（混音中）") : item.state === "succeeded" ? "" : t("（未完成）")}</option>)}
      </Select>
    </label> : null}
    {history.hasNextPage ? <ActionButton size="sm" variant="quiet" className="justify-self-start" pending={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{t("載入更早的試聽")}</ActionButton> : null}
    {history.error ? <p role="alert" className="text-data text-danger">{errorText(history.error)}</p> : null}
    {run?.error ? <p role="alert" className="text-data text-danger">{tServer(run.error.message)}</p> : null}
    {create.isError || query.isError ? <p role="alert" className="text-data text-danger">{errorText(create.error ?? query.error)}</p> : null}
  </div>;
}
