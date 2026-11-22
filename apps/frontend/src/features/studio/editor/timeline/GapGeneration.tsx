import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { indexCatalog, useStableCatalog, type CatalogIndex } from "@/api/catalog";
import type { StudioProject } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { usePipelines } from "@/api/pipelines";
import { fetchProject, studioKeys } from "@/api/studioProjects";
import { useCreateRun, useRun } from "@/api/runs";
import type { RunRequestBody, WirePipeline, WireStep } from "@/api/types";
import { ActionButton } from "@/components/common/ActionButton";
import { Select, Textarea } from "@/components/ui/controls";
import { Disclosure } from "@/components/common/Disclosure";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { isRecord, valuesEqual } from "@/lib/json";
import { pathSegment } from "@/lib/url";
import { useStudio } from "../../studioContext";

interface GapRange {
  track: string;
  start: number;
  end: number;
  /** The submitted gap candidate finished: its run, so the dialog can offer it. */
  onCandidate?: (runId: string) => void;
}

function externalInput(pipe: WirePipeline, step: WireStep, port: unknown, type: string, transport: string): string | undefined {
  const edge = typeof port === "string" ? step.inputs[port] : undefined;
  if (!edge || !("from_input" in edge)) return undefined;
  return pipe.inputs.find((input) => input.name === edge.from_input && input.type_id === type && (input.transport === transport || input.transport === "either"))?.name;
}

function supportsGap(pipe: WirePipeline, catalog: CatalogIndex): boolean {
  const candidates = pipe.steps.flatMap((step) => {
    const facts = catalog.component(step.node_id, step.component_id)?.facts?.["studio_edit"];
    if (!isRecord(facts) || facts["version"] !== 1 || facts["timebase"] !== "frames" || facts["interval"] !== "half_open") return [];
    const ops = facts["operations"];
    const gap = isRecord(ops) ? ops["fill_gap"] : undefined;
    const selector = facts["selector"];
    if (typeof selector !== "string" || !isRecord(gap) || typeof gap["value"] !== "string" || step.parameters[selector] !== gap["value"] ||
        gap["clock"] !== "requested" || gap["output_range"] !== "between_anchors_exclusive") return [];
    return [{ step, gap, outputs: facts["outputs"], selector }];
  });
  if (candidates.length !== 1) return false;
  const entry = candidates[0];
  if (!entry || !isRecord(entry.outputs)) return false;
  const assetPort = entry.outputs["asset"];
  if (!Object.values(pipe.outputs).some((out) => out.from_step === entry.step.step_id && out.output === assetPort)) return false;
  const roles = entry.gap["inputs"];
  const params = entry.gap["parameters"];
  if (!isRecord(roles) || !isRecord(params)) return false;
  const names = [params["frames"], params["fps_num"], params["fps_den"]];
  if (!names.every((name) => typeof name === "string" && name.length > 0) || new Set([...names, entry.selector]).size !== 4) return false;
  const left = externalInput(pipe, entry.step, roles["left_frame"], "media.image.v1", "file");
  const right = externalInput(pipe, entry.step, roles["right_frame"], "media.image.v1", "file");
  return left !== undefined && right !== undefined && left !== right && externalInput(pipe, entry.step, roles["prompt"], "text.prompt.v1", "inline") !== undefined;
}

/** Autosave may replace the server revision while serializing exactly the content shown in this tab. */
function sameEdit(a: StudioProject, b: StudioProject): boolean {
  return a.project_id === b.project_id && (["timeline", "format", "library", "shots", "exports"] as const).every(
    (key) => a[key] === b[key] || valuesEqual(a[key], b[key]),
  );
}

interface PlannedGap {
  saved: StudioProject;
  request: RunRequestBody;
}

function GapForm({ track, start, end, onCandidate }: GapRange) {
  const { project, flush } = useStudio();
  const client = useQueryClient();
  const pipelines = usePipelines();
  const catalog = useStableCatalog();
  const eligible = useMemo(() => {
    const index = indexCatalog(catalog.data);
    return pipelines.data?.items.filter((pipe) => supportsGap(pipe, index)) ?? [];
  }, [pipelines.data, catalog.data]);
  const id = useId();
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [planned, setPlanned] = useState<PlannedGap | null>(null);
  const activeRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const create = useCreateRun();
  const submitted = useRun(create.data?.run_id ?? null);
  useEffect(() => () => { activeRef.current?.abort(); }, []);
  const finished = submitted.data?.state === "succeeded" ? submitted.data.run_id : null;
  useEffect(() => { if (finished !== null) onCandidate?.(finished); }, [finished, onCandidate]);
  const pipeline = eligible.find((candidate) => candidate.pipeline_id === (selected || eligible[0]?.pipeline_id));
  const validPlan = planned !== null && project.revision === planned.saved.revision && sameEdit(project, planned.saved);
  const rangeIssue = !track || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end <= start
    ? t("請選取同軌兩個片段之間的完整空檔") : null;
  const queryIssue = pipelines.isError || catalog.isError ? errorText(pipelines.error ?? catalog.error) : null;
  const loading = pipelines.isPending || catalog.isPending;
  const reason = rangeIssue ?? queryIssue ?? (loading ? t("正在讀取流程與元件狀態…") : !pipeline ? t("請先匯入含補空檔插件的元件組合。") : !prompt.trim() ? t("請輸入空檔的畫面描述。") : null);

  async function prepare() {
    if (!pipeline || reason !== null || activeRef.current !== null) return;
    const controller = new AbortController();
    activeRef.current = controller;
    setError("");
    setPlanned(null);
    create.reset();
    setPending(true);
    try {
      await flush();
      controller.signal.throwIfAborted();
      // This is the revision acknowledged by this tab's save. A concurrent server write will cause a conflict.
      const key = studioKeys.project(project.project_id);
      const saved = client.getQueryData<StudioProject>(key) ?? await fetchProject(project.project_id, controller.signal);
      if (!sameEdit(project, saved)) throw new Error(t("剪輯版本已變更，請重新選取空檔。"));
      const request = await contractJson("WireRunRequest", `/api/studio/projects/${pathSegment(project.project_id)}/timeline/gap-plan`, {
        method: "POST", signal: controller.signal,
        json: { revision: saved.revision, pipeline_id: pipeline.pipeline_id, track_id: track, start_frame: start, end_frame: end, prompt: prompt.trim() },
      });
      if (!controller.signal.aborted) setPlanned({ saved, request });
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (!controller.signal.aborted) setPending(false);
      activeRef.current = null;
    }
  }
  function submit() {
    if (!planned || !validPlan || submittingRef.current || create.isPending || create.isSuccess || create.isError) return;
    submittingRef.current = true;
    create.mutate(planned.request, { onSettled: () => { submittingRef.current = false; } });
  }
  const edit = () => { setPlanned(null); setError(""); create.reset(); };
  const runState = submitted.data?.state;
  return (
    <section aria-label={t("生成空檔候選片段")} className="grid content-start gap-3">
      {eligible.length > 1 && <div className="grid gap-1.5">
        <label htmlFor={`${id}-pipeline`} className="text-caption text-fg-tertiary">{t("補空檔元件組合")}</label>
        <Select id={`${id}-pipeline`} compact value={pipeline?.pipeline_id ?? ""} disabled={pending || loading}
          onChange={(event) => { setSelected(event.target.value); edit(); }}>
          {eligible.map((item) => <option key={item.pipeline_id} value={item.pipeline_id}>{item.label || item.pipeline_id}</option>)}
        </Select>
      </div>}
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-prompt`} className="text-caption text-fg-tertiary">{t("空檔的畫面描述")}</label>
        <Textarea id={`${id}-prompt`} className="min-h-40" disabled={pending || create.isPending} maxLength={32000} value={prompt}
          onChange={(event) => { setPrompt(event.target.value); edit(); }} />
      </div>
      {planned !== null && validPlan ? <Disclosure summary={t("進階")}>
        <details className="min-w-0 text-caption"><summary className="cursor-pointer">{t("已凍結的參數與來源")}</summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(planned.request, null, 2)}</pre>
        </details>
      </Disclosure> : null}
      {reason !== null ? <p role="status" className="text-caption text-fg-secondary">{reason}</p> : null}
      {error ? <p role="alert" className="text-caption text-warning">{error}</p> : null}
      {planned !== null && !validPlan ? <p role="status" className="text-caption text-warning">{t("剪輯版本已變更，請重新選取空檔。")}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton size="sm" variant={validPlan ? "quiet" : "secondary"} pending={pending} disabledReason={reason} onClick={() => { void prepare(); }}>{t("檢視補空檔任務")}</ActionButton>
        {validPlan && !create.isSuccess ? <ActionButton size="sm" variant="primary" pending={create.isPending} disabled={create.isError} onClick={submit}>{t("生成空檔候選")}</ActionButton> : null}
      </div>
      {create.isSuccess ? <p role="status" className="text-caption text-fg-secondary">
        {runState === "succeeded" ? t("空檔候選已完成，已放到「候選與套用」。")
          : runState === "failed" || runState === "interrupted" || runState === "cancelled" ? t("空檔候選沒有完成。")
          : t("空檔候選生成中，完成後會出現在「候選與套用」。")}</p> : null}
      {create.isError ? <p role="alert" className="text-caption text-warning">{errorText(create.error)}</p> : null}
      {submitted.data?.error ? <p role="alert" className="text-caption text-warning">{errorText(submitted.data.error)}</p> : null}
    </section>
  );
}

export function GapGeneration(range: GapRange) {
  const { project, documentGeneration } = useStudio();
  return <GapForm key={JSON.stringify([project.project_id, documentGeneration, range.track, range.start, range.end])} {...range} />;
}
