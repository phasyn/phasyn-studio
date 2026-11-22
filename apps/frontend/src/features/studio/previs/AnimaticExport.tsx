import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { uploadBlob } from "@/api/files";
import type { StudioPrevis, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import { fetchProject } from "@/api/studioProjects";
import type { RunRequestBody } from "@/api/types";
import { runPath } from "@/app/paths";
import { AssetVideo } from "@/components/common/AssetMedia";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { publishedMedia } from "../model/runMedia";
import { useStudio } from "../studioContext";
import { captureFrames, audioOffsetIssue, rangeIssue, sourceHeader } from "./animaticBundle";
import { animaticRoutes } from "./animaticRoutes";
import { animaticJob, type AnimaticJob } from "./animaticHistory";
import type { PrevisPainter } from "./spacePainter";

interface Props {
  shot: StudioShot;
  scene: StudioPrevis;
  images: Map<string, HTMLImageElement>;
  painter: PrevisPainter;
  depth: boolean;
  blocked: boolean;
}

export function AnimaticExport({ shot, scene, painter, depth, images, blocked }: Props) {
  const { project, catalog, flush, runTimelineCommands, runBlockedReason } = useStudio();
  const graphs = usePipelines();
  const create = useCreateRun();
  const routes = animaticRoutes(graphs.data?.items ?? [], catalog);
  const [pipeline, setPipeline] = useState("");
  const route = routes.find(r => r.pipe.pipeline_id === pipeline) ?? routes[0];
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(String(shot.frames));
  const [audioId, setAudioId] = useState("");
  const [offset, setOffset] = useState("0");
  const tracks = (project.library ?? []).filter(item => item.kind === "audio");
  const track = route?.audio ? tracks.find(i => i.item_id === audioId) : undefined;
  const first = start.trim() === "" ? NaN : Number(start);
  const last = end.trim() === "" ? NaN : Number(end);
  const sample = offset.trim() === "" ? NaN : Number(offset);
  const issue = rangeIssue(first, last, shot, project.format) ?? audioOffsetIssue(track, sample) ??
    (route?.audio?.required === true && !track ? t("此流程需要臨時音軌。") : null);
  const records = useRunList(25, "include", { project_id: project.project_id, shot_id: shot.shot_id, operation_kind: "animatic" }, "summary");
  const history = records.data?.pages.flatMap(page => page.items.flatMap(item => {
    const match = animaticJob(item, project.project_id, shot.shot_id);
    return match ? [match] : [];
  })) ?? [];
  const [selectedJob, setSelectedJob] = useState<AnimaticJob | null>(null);
  const job = history.find(item => item.id === selectedJob?.id) ?? selectedJob ?? history[0];
  const run = useRun(job?.id ?? null);
  const result = run.data ? publishedMedia(run.data).find(m => m.port === job?.port && m.kind === "video") : undefined;
  const collected = (project.library ?? []).some(item => item.file.sha256 === result?.file.sha256);
  const [pending, setPending] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef<AbortController | null>(null);
  useEffect(() => () => { activeRef.current?.abort(); }, []);

  async function render() {
    if (!route || activeRef.current || issue !== null || blocked) return;
    const ctl = new AbortController();
    activeRef.current = ctl;
    setError("");
    setPending(t("正在準備預演…"));
    try {
      await flush();
      const saved = await fetchProject(project.project_id, ctl.signal);
      const header = sourceHeader(project, saved, shot, scene, first, last, depth, track, sample);
      const capture = await captureFrames(painter, header, images, ctl.signal, n => {
        setPending(t("正在繪製預演 {done}/{total}", { done: n, total: last - first }));
      });
      const inputs: RunRequestBody["inputs"] = {};
      try {
        setPending(t("正在上傳預演影格…"));
        const file = await uploadBlob(capture.blob, "application/octet-stream", ctl.signal);
        inputs[route.frames] = { type_id: "media.previs-frames.v1", file };
      } finally { await capture.dispose(); }
      ctl.signal.throwIfAborted();
      if (route.audio && track) inputs[route.audio.name] = { type_id: "media.audio.v1", file: track.file };
      const label = t("{shot} · 預演 [{start}, {end})", { shot: shot.title.slice(0, 110), start: first, end: last });
      setPending(t("正在送出預演編碼…"));
      const created = await create.mutateAsync({ pipeline: route.pipe, inputs, label, origin: {
        studio_work: { project_id: saved.project_id, shot_id: shot.shot_id, operation_kind: "animatic" },
        note: JSON.stringify({ project_id: saved.project_id, revision: saved.revision, shot_id: shot.shot_id, start: first, end: last, output: route.port }),
      } });
      setSelectedJob({ id: created.run_id, port: route.port, label });
    } catch (cause) {
      if (!ctl.signal.aborted) setError(errorText(cause));
    } finally { activeRef.current = null; setPending(null); }
  }
  async function collect() {
    if (!job || !result || collecting || collected) return;
    setCollecting(true);
    try { await runTimelineCommands([{ op: "collect_output", name: job.label, run_id: job.id, output_key: result.port,
      expected_source_sha256: result.file.sha256 }]); }
    catch (cause) { setError(errorText(cause)); }
    finally { setCollecting(false); }
  }
  return <section className="grid gap-2 rounded-md border border-line-subtle p-3">
    <h3 className="text-data font-semibold">{t("動態預演")}</h3>
    <div className="flex flex-wrap gap-2 text-caption">
      <label>{t("起始影格")}<Input compact type="number" min={0} max={shot.frames - 1} value={start} onChange={e => { setStart(e.target.value); }} /></label>
      <label>{t("結束影格（不含）")}<Input compact type="number" min={1} max={shot.frames} value={end} onChange={e => { setEnd(e.target.value); }} /></label>
      <span className="self-end">{project.format.fps.num}/{project.format.fps.den} fps</span>
    </div>
    {routes.length > 1 && <label>{t("預演編碼流程")}<Select compact value={route?.pipe.pipeline_id ?? ""} onChange={e => { setPipeline(e.target.value); }}>
      {routes.map(r => <option key={r.pipe.pipeline_id} value={r.pipe.pipeline_id}>{r.pipe.label}</option>)}</Select></label>}
    {route?.audio && <label className="text-caption">{t("臨時音軌")}<Select compact value={audioId} onChange={e => { setAudioId(e.target.value); }}>
      <option value="">{t("無音軌")}</option>{tracks.map(item => <option key={item.item_id} value={item.item_id}>{item.name}</option>)}</Select></label>}
    {track && <label className="text-caption">{t("來源音訊起始取樣（48 kHz，尾段不足時補靜音）")}
      <Input compact type="number" min={0} step={1} value={offset} onChange={e => { setOffset(e.target.value); }} /></label>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={blocked || !route || issue !== null || pending !== null || runBlockedReason !== null}
        onClick={() => { void render(); }}>{t("產生預演影片")}</Button>
      {pending !== null && !create.isPending && <Button size="sm" onClick={() => { activeRef.current?.abort(); }}>{t("取消")}</Button>}
    </div>
    {pending !== null && <p role="status">{pending}</p>}
    {!route && <p role="status">{t("請啟動預演編碼元件並匯入 previs-animatic 流程。")}</p>}
    {issue !== null && <p role="status">{issue}</p>}
    {runBlockedReason !== null && <p role="status">{runBlockedReason}</p>}
    {history.length > 0 && <label className="text-caption">{t("此鏡頭的預演紀錄")}
      <Select compact value={job?.id ?? ""} onChange={event => { setSelectedJob(history.find(item => item.id === event.target.value) ?? null); }}>
        {selectedJob && !history.some(item => item.id === selectedJob.id) && <option value={selectedJob.id}>{selectedJob.label}</option>}
        {history.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id.slice(0, 8)}</option>)}
      </Select></label>}
    {records.hasNextPage && <Button size="sm" variant="quiet" disabled={records.isFetchingNextPage} onClick={() => { void records.fetchNextPage(); }}>
      {t("讀取較早的執行紀錄")}</Button>}
    {records.isError && <p role="alert">{errorText(records.error)}</p>}
    {job && <div className="flex flex-wrap items-center gap-2"><Link className="text-action-fg underline" to={runPath(job.id)}>{job.label}</Link>
      {run.data && <StatusBadge kind="run" value={run.data.state} />}</div>}
    {result && <><AssetVideo controls preload="metadata" className="max-h-60 w-full" src={mediaUrl(result.file.node_id, result.file.file_id)} />
      <Button size="sm" disabled={collected || collecting} onClick={() => { void collect(); }}>{collected ? t("已加入素材庫") : t("將預演影片加入素材庫")}</Button></>}
    {(error !== "" || run.isError) && <p role="alert" className="text-warning">{error || errorText(run.error)}</p>}
  </section>;
}
