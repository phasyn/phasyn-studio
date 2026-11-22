import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { indexCatalog, useStableCatalog, type CatalogIndex } from "@/api/catalog";
import type { StudioLibraryItem, StudioProject } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import { fetchProject, studioKeys } from "@/api/studioProjects";
import type { RunRequestBody, WirePipeline, WireRun } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { Disclosure } from "@/components/common/Disclosure";
import { Select, Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/errors";
import { isRecord, valuesEqual } from "@/lib/json";
import { pathSegment } from "@/lib/url";
import { useStudio } from "../../studioContext";
import { clipEnd } from "../model";
import { RetakeMaskEditor } from "./RetakeMaskEditor";

interface Range {
  track: string;
  start: number;
  end: number;
  /**
   * Which part to show (the range dialog puts them on tabs; both stay mounted so the marks and the text survive a tab
   * switch); "hidden" shows neither; absent = both, one under the other.
   */
  panel?: "prompt" | "mask" | "hidden";
  /** Whether the chosen route takes a mask (the dialog shows its 遮罩 tab only then). */
  onMasksAvailable?: (available: boolean) => void;
  /** The submitted retake finished: its run, so the dialog can offer it as the candidate. */
  onCandidate?: (runId: string) => void;
}

/** Library items that are masks: mattes made for this source, or items named as a mask. */
function isMask(item: StudioLibraryItem, sourceSha: string | undefined): boolean {
  // i18n-ignore: matching names the owner gave to mask files, not display text
  return (sourceSha !== undefined && item.file.metadata["source_sha256"] === sourceSha) || /mask|matte|遮罩|蒙版/iu.test(item.name);
}

interface RetakePipeline {
  pipe: WirePipeline;
  masks: Set<string>;
  requiresMask: boolean;
}

function declaredRetake(pipe: WirePipeline, catalog: CatalogIndex): RetakePipeline | null {
  const matches: RetakePipeline[] = [];
  for (const step of pipe.steps) {
    const definition = catalog.component(step.node_id, step.component_id)?.facts?.["studio_edit"];
    if (!isRecord(definition) || definition["version"] !== 1 ||
        definition["timebase"] !== "frames" || definition["interval"] !== "half_open") continue;
    const operations = definition["operations"];
    const operation = isRecord(operations) ? operations["native_retake"] : undefined;
    const selector = definition["selector"];
    if (!isRecord(operation) || typeof selector !== "string" || typeof operation["value"] !== "string" ||
        step.parameters[selector] !== operation["value"] || operation["clock"] !== "source" ||
        operation["output_range"] !== "selection_only") continue;
    const outputs = definition["outputs"];
    if (!isRecord(outputs) || !Object.values(pipe.outputs).some((edge) => edge.from_step === step.step_id && edge.output === outputs["asset"])) continue;
    const inputs = operation["inputs"];
    const fields = operation["parameters"];
    if (!isRecord(inputs) || !isRecord(fields)) continue;
    const external = (role: string, type: string, transport: "file" | "inline") => {
      const port = inputs[role];
      const edge = typeof port === "string" ? step.inputs[port] : undefined;
      return edge !== undefined && "from_input" in edge && pipe.inputs.some((item) =>
        item.name === edge.from_input && item.type_id === type && (item.transport === transport || item.transport === "either"));
    };
    if (!external("source_video", "media.video.v1", "file") || !external("prompt", "text.prompt.v1", "inline") ||
        typeof fields["start_frame"] !== "string" || typeof fields["end_frame"] !== "string") continue;
    const masks = new Set(["image", "video"].filter((kind) => external(`mask_${kind}`, `media.${kind}.v1`, "file")));
    const required = fields["mask_required"];
    matches.push({ pipe, masks, requiresMask: typeof required === "string" && step.parameters[required] === true });
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

function measurements(runs: WireRun[], hash: string | undefined, size: number | undefined) {
  if (hash === undefined || hash.length === 0) return [];
  return runs.flatMap((run) => run.state !== "succeeded" ? [] : Object.entries(run.outputs).flatMap(([key, raw]) => {
    if (!isRecord(raw) || raw["type_id"] !== "media.probe.v1" || !isRecord(raw["value"])) return [];
    const clock = raw["value"]["frame_clock"];
    if (!isRecord(clock) || clock["kind"] !== "cfr" || clock["source_sha256"] !== hash || clock["source_size_bytes"] !== size) return [];
    return [{ run: run.run_id, key, made: run.created_at, token: JSON.stringify([run.run_id, key]) }];
  }));
}

function sameProject(a: StudioProject, b: StudioProject) {
  return a.project_id === b.project_id && (["timeline", "format", "library", "shots"] as const)
    .every((key) => a[key] === b[key] || valuesEqual(a[key], b[key]));
}


function RetakeForm({ track, start, end, panel, onMasksAvailable, onCandidate }: Range) {
  const { project, flush } = useStudio();
  const timeline = project.timeline;
  const fps = timeline ? timeline.fps.num / timeline.fps.den : project.format.fps.num / project.format.fps.den;
  const overlapping = timeline?.clips.filter((clip) => clip.track_id === track && clip.start_frame < end && clipEnd(clip) > start) ?? [];
  const clip = overlapping.length === 1 ? overlapping[0] : undefined;
  const source = clip && timeline?.sources.find((item) => item.source_id === clip.source_id);
  const origin = source?.candidate_origin ?? source;
  const shot = project.shots.find((item) => item.shot_id === origin?.shot_id);
  const parent = shot?.takes.find((item) => item.take_id === origin?.take_id);
  const client = useQueryClient();
  const pipelines = usePipelines();
  const catalog = useStableCatalog();
  const runs = useRunList(25, "include", undefined, "summary");
  const create = useCreateRun();
  const submitted = useRun(create.data?.run_id ?? null);
  const routes = useMemo(() => {
    const index = indexCatalog(catalog.data);
    return (pipelines.data?.items ?? []).flatMap((pipe) => {
      const entry = declaredRetake(pipe, index);
      return entry ? [entry] : [];
    });
  }, [pipelines.data, catalog.data]);
  const id = useId();
  const [routeId, setRouteId] = useState("");
  const [prompt, setPrompt] = useState(parent?.prompt ?? shot?.prompt ?? "");
  const [maskId, setMaskId] = useState("");
  const [probeChoice, setProbeChoice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<{ request: RunRequestBody; saved: StudioProject } | null>(null);
  const activeRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  useEffect(() => () => { activeRef.current?.abort(); }, []);
  const selected = routes.find(({ pipe }) => pipe.pipeline_id === (routeId || routes[0]?.pipe.pipeline_id));
  const maskKinds = selected?.masks;
  const masks = (project.library ?? []).filter((i) => maskKinds?.has(i.kind) === true && (i.item_id === maskId || isMask(i, source?.file?.sha256)));
  const mask = masks.find((item) => item.item_id === maskId);
  const clocks = measurements(runs.data?.pages.flatMap((page) => page.items) ?? [], source?.file?.sha256, source?.file?.size_bytes);
  const clock = clocks.find((row) => row.token === probeChoice);
  const knownSource = !!parent?.asset?.fps || (source?.candidate_origin?.run_id ?? "").length > 0;
  const valid = prepared !== null && prepared.saved.revision === project.revision && sameProject(project, prepared.saved);
  const busy = pending || create.isPending;
  const maskable = selected !== undefined && selected.masks.size > 0;
  const reason = !clip || clip.start_frame > start || clipEnd(clip) < end || start < 0 || end <= start || source?.kind !== "video" || !source.file
    ? t("請在同一個影片片段內選取重製範圍。") : !selected ? t("請先匯入含原生局部重製插件的元件組合。")
      : !prompt.trim() ? t("請填寫選區的新畫面描述。")
      : selected.requiresMask && !mask ? t("此流程需要選取遮罩素材。")
      : !clock && !knownSource ? t("請先對原始影片執行「影片影格時鐘」，再選取該探測輸出。") : null;

  useEffect(() => { onMasksAvailable?.(maskable); }, [maskable, onMasksAvailable]);
  const finished = submitted.data?.state === "succeeded" ? submitted.data.run_id : null;
  useEffect(() => { if (finished !== null) onCandidate?.(finished); }, [finished, onCandidate]);

  function changed() {
    setPrepared(null);
    setError("");
    create.reset();
  }

  async function prepare() {
    if (reason !== null || !selected || activeRef.current) return;
    const controller = new AbortController();
    activeRef.current = controller;
    setPending(true);
    changed();
    try {
      await flush();
      controller.signal.throwIfAborted();
      const saved = client.getQueryData<StudioProject>(studioKeys.project(project.project_id)) ?? await fetchProject(project.project_id, controller.signal);
      if (!sameProject(saved, project)) throw new Error(t("剪輯版本已變更，請重新檢視重製範圍。"));
      const request = await contractJson("WireRunRequest", `/api/studio/projects/${pathSegment(project.project_id)}/timeline/retake-plan`, {
        method: "POST", signal: controller.signal, json: {
          revision: saved.revision, pipeline_id: selected.pipe.pipeline_id, track_id: track,
          start_frame: start, end_frame: end, prompt: prompt.trim(),
          ...(mask ? { mask_item_id: mask.item_id } : {}),
          ...(clock ? { probe_run_id: clock.run, probe_output_key: clock.key } : {}),
        },
      });
      if (!controller.signal.aborted) setPrepared({ request, saved });
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (!controller.signal.aborted) setPending(false);
      activeRef.current = null;
    }
  }

  function submit() {
    if (!prepared || !valid || submittingRef.current || create.isPending || create.isSuccess || create.isError) return;
    submittingRef.current = true;
    create.mutate(prepared.request, { onSettled: () => { submittingRef.current = false; } });
  }

  const runState = submitted.data?.state;
  const maskPicker = (suffix: string) => maskable && <div className="grid gap-1.5">
    <label htmlFor={`${id}-mask${suffix}`} className="text-caption text-fg-tertiary">{t("區域遮罩")}</label>
    <Select id={`${id}-mask${suffix}`} compact value={mask?.item_id ?? ""} disabled={busy} onChange={(e) => { setMaskId(e.target.value); changed(); }}>
      <option value="">{selected.requiresMask ? t("請選擇遮罩") : t("不使用遮罩（整個畫面）")}</option>
      {masks.map((item) => <option key={item.item_id} value={item.item_id}>{item.name}</option>)}
    </Select>
  </div>;
  const promptPart = <div className="grid content-start gap-3">
    {routes.length > 1 && <div className="grid gap-1.5">
      <label htmlFor={`${id}-flow`} className="text-caption text-fg-tertiary">{t("局部重製元件組合")}</label>
      <Select id={`${id}-flow`} compact disabled={busy} value={selected?.pipe.pipeline_id ?? ""}
        onChange={(e) => { setRouteId(e.target.value); setMaskId(""); changed(); }}>
        {routes.map(({ pipe }) => <option key={pipe.pipeline_id} value={pipe.pipeline_id}>{pipe.label || pipe.pipeline_id}</option>)}
      </Select>
    </div>}
    <div className="grid gap-1.5">
      <label htmlFor={`${id}-prompt`} className="text-caption text-fg-tertiary">{t("選區的新畫面描述")}</label>
      <Textarea id={`${id}-prompt`} className="min-h-40" maxLength={32000} value={prompt} disabled={busy}
        onChange={(e) => { setPrompt(e.target.value); changed(); }} />
    </div>
    {maskPicker("")}
    <p className="text-caption text-fg-tertiary">{t("候選只包含所選畫面。採用時只替換影像軌，原聲保留在音軌。")}</p>
    <Disclosure summary={t("進階")}>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-clock`} className="text-caption text-fg-tertiary">{t("原始影片影格時鐘")}</label>
        <Select id={`${id}-clock`} compact value={clock?.token ?? ""} disabled={busy} onChange={(e) => { setProbeChoice(e.target.value); changed(); }}>
          <option value="">{t("使用已發布 Take 的影格率")}</option>
          {clocks.map((row) => <option key={row.token} value={row.token}>{t("影格時鐘量測 · {time}", { time: formatDateTime(row.made) })}</option>)}
        </Select>
        {runs.hasNextPage && <ActionButton size="sm" variant="quiet" disabled={busy || runs.isFetchingNextPage} onClick={() => { void runs.fetchNextPage(); }}>{t("載入更多執行紀錄")}</ActionButton>}
        {prepared && valid && <details className="min-w-0 text-caption"><summary className="cursor-pointer">{t("已凍結的參數與來源")}</summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(prepared.request, null, 2)}</pre>
        </details>}
      </div>
    </Disclosure>
    {reason !== null && <p role="status" className="text-caption text-fg-secondary">{reason}</p>}
    {error && <p role="alert" className="text-caption text-warning">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <ActionButton size="sm" variant={prepared && valid ? "quiet" : "secondary"} disabledReason={reason} disabled={busy} pending={pending} onClick={() => { void prepare(); }}>{t("檢視局部重製任務")}</ActionButton>
      {prepared && valid && !create.isSuccess && <ActionButton size="sm" variant="primary" pending={create.isPending} disabled={create.isError} onClick={submit}>{t("生成局部候選")}</ActionButton>}
    </div>
    {prepared && !valid && <p role="status" className="text-caption text-warning">{t("剪輯版本已變更，請重新檢視重製範圍。")}</p>}
    {create.isSuccess && <p role="status" className="text-caption text-fg-secondary">
      {runState === "succeeded" ? t("局部候選已完成，已放到「候選與套用」。")
        : runState === "failed" || runState === "interrupted" || runState === "cancelled" ? t("局部候選沒有完成。")
        : t("局部候選生成中，完成後會出現在「候選與套用」。")}</p>}
    {create.isError && <p role="alert" className="text-caption text-warning">{errorText(create.error)}</p>}
    {submitted.data?.error && <p role="alert" className="text-caption text-warning">{errorText(submitted.data.error)}</p>}
    {pipelines.isError || catalog.isError || runs.isError ? <p role="alert" className="text-caption text-warning">{errorText(pipelines.error ?? catalog.error ?? runs.error)}</p> : null}
  </div>;
  const maskPart = maskable && source?.file && selected.masks.has("video")
    ? <div className="grid gap-3">
      <RetakeMaskEditor key={source.file.sha256} source={source.file} fps={fps} onAdopt={(item) => { setMaskId(item); changed(); }}
        extra={panel !== undefined && maskPicker("-tab")} />
    </div>
    : maskable ? <div className="grid gap-3"><p className="text-caption text-fg-secondary">{t("這個流程使用單張遮罩圖片，請從素材庫選擇。")}</p>{panel !== undefined && maskPicker("-tab")}</div> : null;

  const id2 = `${id}-title`;
  if (panel !== undefined) return <>
    <section aria-label={t("原生局部重製")} hidden={panel !== "prompt"}>{promptPart}</section>
    <section aria-label={t("區域遮罩")} hidden={panel !== "mask"}>{maskPart}</section>
  </>;
  return <section aria-labelledby={id2} className="grid gap-3 rounded-md border border-line-subtle p-3">
    <h3 id={id2} className="text-data font-semibold text-fg">{t("原生局部重製")}</h3>
    {maskPart}
    {promptPart}
  </section>;
}

/** The native retake of a range: describe the new picture (and mark a mask), plan it, generate the candidate. */
export function RetakeGeneration(range: Range) {
  const { project, documentGeneration } = useStudio();
  return <RetakeForm key={JSON.stringify([project.project_id, documentGeneration, range.track, range.start, range.end])} {...range} />;
}
