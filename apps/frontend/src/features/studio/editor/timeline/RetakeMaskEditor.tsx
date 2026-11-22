import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import { fetchProject } from "@/api/studioProjects";
import { asTypedValueMap, type WirePipeline, type WireTypedValue } from "@/api/types";
import type { FileRef } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/errors";
import { isRecord } from "@/lib/json";
import { publishedMedia } from "../../model/runMedia";
import { MaskMarker } from "../../retake/MaskMarker";
import { useStudio } from "../../studioContext";
import { RetakeMaskOverlay } from "./RetakeMaskOverlay";

function route(pipe: WirePipeline) {
  const files = pipe.inputs.filter(i => i.type_id === "media.video.v1" && i.transport !== "inline");
  const marks = pipe.inputs.filter(i => i.type_id === "media.mask-annotations.v1" && i.transport !== "file");
  const file = files[0], hints = marks[0];
  if (files.length !== 1 || marks.length !== 1 || !file || !hints || pipe.inputs.some(i => i.required && i !== file && i !== hints)) return [];
  return [{ pipe, file: file.name, hints: hints.name }];
}

function stateText(state: string): string {
  switch (state) {
    case "succeeded": return t("遮罩已完成");
    case "failed": case "interrupted": return t("遮罩產生失敗");
    case "cancelled": return t("已取消");
    default: return t("遮罩產生中…");
  }
}

/**
 * Making a per-frame mask for a retake: mark the object on the source picture, generate the matte, check it frame by
 * frame and use it. `fps` is the sequence rate the monitor counts in (the project's when absent).
 */
export function RetakeMaskEditor({ source, onAdopt, fps, extra }: { source: FileRef; onAdopt: (id: string) => void; fps?: number; extra?: ReactNode }) {
  const { project, runTimelineCommands } = useStudio();
  const rate = fps ?? project.format.fps.num / project.format.fps.den;
  const pipes = usePipelines();
  const routes = (pipes.data?.items ?? []).flatMap(route);
  const [id, setId] = useState("");
  const selected = routes.find(i => i.pipe.pipeline_id === id) ?? routes[0];
  const [hints, setHints] = useState<WireTypedValue | null>(null);
  const [parent, setParent] = useState("");
  const history = useRunList(30, "include", { project_id: project.project_id, operation_kind: "mask", source_digest: source.sha256 }, "summary");
  const previous = (history.data?.pages ?? []).flatMap(page => page.items.flatMap(run => {
    const inputs = asTypedValueMap(run.request.inputs);
    const note = Object.values(inputs).find(i => i.type_id === "media.mask-annotations.v1" && "value" in i && isRecord(i.value) && i.value["source_sha256"] === source.sha256);
    return note && Object.values(inputs).some(i => "file" in i && i.file.sha256 === source.sha256) ? [{ run, note }] : [];
  }));
  const submission = useCreateRun();
  const [runId, setRunId] = useState("");
  const result = useRun(runId || null);
  const mask = result.data?.run_id === runId ? publishedMedia(result.data).find(item => item.kind === "video" && item.file.metadata["source_sha256"] === source.sha256) : undefined;
  const [error, setError] = useState("");
  const [collecting, setCollecting] = useState(false);
  const [adopted, setAdopted] = useState("");
  async function generate() {
    if (!selected || !hints) return;
    setError("");
    try {
      const created = await submission.mutateAsync({ pipeline: selected.pipe, inputs: {
        [selected.file]: { type_id: "media.video.v1", file: source }, [selected.hints]: hints,
      }, label: t("重製遮罩修訂"), origin: { studio_work: { project_id: project.project_id, operation_kind: "mask", source_digest: source.sha256 }, note: JSON.stringify({ project_id: project.project_id, source_sha256: source.sha256, parent_mask_run_id: parent || null }) } });
      setRunId(created.run_id); setParent(created.run_id);
    } catch (cause) { setError(errorText(cause)); }
  }
  async function adopt() {
    if (!mask) return;
    setCollecting(true); setError("");
    try {
      await runTimelineCommands([{ op: "collect_output", name: t("局部重製遮罩"), run_id: runId, output_key: mask.port, expected_source_sha256: mask.file.sha256 }]);
      const saved = await fetchProject(project.project_id);
      const item = saved.library?.find(i => i.file.sha256 === mask.file.sha256);
      if (item) { onAdopt(item.item_id); setAdopted(runId); }
    } catch (cause) { setError(errorText(cause)); } finally { setCollecting(false); }
  }
  const busy = collecting || submission.isPending;
  const state = result.data?.state;
  const noRoute = pipes.isSuccess && routes.length === 0 ? t("尚無相容遮罩流程") : null;
  return <MaskMarker source={source} value={hints} onChange={setHints} disabled={busy} fps={rate}>
    <div className="grid gap-2 border-t border-line-subtle pt-3">
      {routes.length > 1 && <label className="grid gap-1 text-caption text-fg-tertiary">{t("遮罩流程")}
        <Select compact value={selected?.pipe.pipeline_id ?? ""} onChange={e => { setId(e.target.value); }}>
          {routes.map(r => <option key={r.pipe.pipeline_id} value={r.pipe.pipeline_id}>{r.pipe.label || r.pipe.pipeline_id}</option>)}
        </Select></label>}
      {previous.length > 0 && <label className="grid gap-1 text-caption text-fg-tertiary">{t("遮罩修訂紀錄")}
        <Select compact disabled={busy} value={parent} onChange={e => {
          const entry = previous.find(p => p.run.run_id === e.target.value); setParent(entry?.run.run_id ?? ""); setRunId(entry?.run.run_id ?? ""); setHints(entry?.note ?? null);
        }}><option value="">{t("新遮罩")}</option>{previous.map((p, i) => <option key={p.run.run_id} value={p.run.run_id}>{t("版本 {n}", { n: previous.length - i })} · {formatDateTime(p.run.created_at)}</option>)}</Select></label>}
      {history.hasNextPage && <Button size="sm" variant="quiet" onClick={() => void history.fetchNextPage()}>{t("載入更早的遮罩版本")}</Button>}
      <ActionButton size="sm" variant="secondary" icon={<Sparkles aria-hidden />} pending={submission.isPending} disabled={busy}
        disabledReason={noRoute ?? (!hints ? t("請先在畫面上標記物件。") : null)} onClick={() => void generate()}>{t("產生遮罩")}</ActionButton>
      {state !== undefined && <span role="status" className="text-caption text-fg-secondary">{stateText(state)}</span>}
      {mask && <>
        <RetakeMaskOverlay key={[source.sha256, mask.file.sha256, runId].join("/")} source={source} mask={mask.file} revision={runId} />
        <ActionButton size="sm" variant="primary" pending={collecting} disabled={busy || adopted === runId} onClick={() => void adopt()}>
          {adopted === runId ? t("已用於局部重製") : t("將這個版本用於局部重製")}</ActionButton>
      </>}
      {(error || result.data?.error) && <p role="alert" className="text-caption text-warning">{error || errorText(result.data?.error)}</p>}
      {extra}
    </div>
  </MaskMarker>;
}
