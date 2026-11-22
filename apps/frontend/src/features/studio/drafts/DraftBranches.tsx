import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";
import { findComponent } from "@/api/catalog";
import type { Catalog, StudioDraftCandidateResult, StudioDraftPlan, StudioFrozenDraft, StudioShot } from "@/api/generated/contracts";
import { contractJson, mediaUrl } from "@/api/http";
import { usePipelines } from "@/api/pipelines";
import { useCreateRun, useRunList } from "@/api/runs";
import type { WirePipeline, WireRun } from "@/api/types";
import { runPath } from "@/app/paths";
import { AssetVideo } from "@/components/common/AssetMedia";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { publishedMedia } from "../model/runMedia";
import { useStudio } from "../studioContext";
import { Choice, Failure } from "./fields";

function branchRoute(pipe: WirePipeline, catalog: Catalog | undefined) {
  if (!catalog) return false;
  const hasSource = pipe.inputs.some(port => port.type_id === "media.video.v1" || port.type_id === "media.asset.v1") ||
    pipe.steps.some(step => {
      const facts = findComponent(catalog, step.node_id, step.component_id)?.descriptor.facts?.["draft_refinement"];
      if (!isRecord(facts) || facts["version"] !== 1 || typeof facts["latent_input"] !== "string") return false;
      const edge = step.inputs[facts["latent_input"]];
      return edge !== undefined && "from_input" in edge && pipe.inputs.some(port => port.name === edge.from_input);
    });
  if (!hasSource) return false;
  return Object.values(pipe.outputs).some(edge => {
    const step = pipe.steps.find(item => item.step_id === edge.from_step);
    return step !== undefined && findComponent(catalog, step.node_id, step.component_id)?.descriptor.outputs.some(
      port => port.name === edge.output && port.type_id === "media.asset.v1",
    ) === true;
  });
}

function branchOrigin(run: WireRun, plan: StudioDraftPlan, candidate: StudioFrozenDraft, sourceRun: string) {
  try {
    const note: unknown = JSON.parse(run.request.origin?.note ?? "");
    const origin = isRecord(note) ? note["draft_branch"] : undefined;
    if (isRecord(origin) && origin["project_id"] === plan.project_id && origin["plan_id"] === plan.plan_id &&
      origin["candidate_id"] === candidate.candidate_id && origin["shot_id"] === candidate.shot_id &&
      origin["source_run_id"] === sourceRun && (origin["parent_take_id"] === null || typeof origin["parent_take_id"] === "string")) {
      return { parent: origin["parent_take_id"] };
    }
  } catch { /* Other run origins are unrelated to this candidate. */ }
  return null;
}

function BranchRun({ run, shot, parent }: { run: WireRun; shot: StudioShot; parent: string | null }) {
  const { adoptMedia } = useStudio();
  const adopt = useMutation({ mutationFn: (port: string) => adoptMedia(shot.shot_id, run.run_id, port, parent), retry: false });
  const outputs = publishedMedia(run).filter(item => item.kind === "video" && item.timed);
  return <article className="grid min-w-0 gap-2 border-t border-line-subtle pt-2">
    <div className="flex flex-wrap items-center gap-2">
      <Link className="break-all text-caption text-action-fg underline" to={runPath(run.run_id)}>{run.request.pipeline.label} · {run.run_id.slice(0, 8)}</Link>
      <StatusBadge kind="run" value={run.state} />
    </div>
    {outputs.map(item => {
      const attached = shot.takes.some(take => take.run_id === run.run_id && take.output_key === item.port);
      return <div key={item.port} className="grid min-w-0 gap-1">
        <details className="text-caption"><summary className="cursor-pointer">{t("來源影片預覽：{name}", { name: item.port })}</summary>
          <AssetVideo controls preload="none" className="mt-1 max-h-48 w-full rounded-md bg-stage object-contain"
            src={mediaUrl(item.file.node_id, item.file.file_id)} aria-label={t("來源影片預覽：{name}", { name: item.port })} /></details>
        {attached ? <span role="status" className="text-caption">{t("已附加至這個鏡頭")}</span> :
          <Button className="justify-self-start" size="sm" variant="secondary" pending={adopt.isPending}
            onClick={() => { adopt.mutate(item.port); }}>{t("採用為候選 Take")}</Button>}
      </div>;
    })}
    <Failure error={adopt.error} />
  </article>;
}

export function DraftBranches({ plan, candidate, result, selected }: {
  plan: StudioDraftPlan; candidate: StudioFrozenDraft; result: StudioDraftCandidateResult; selected: boolean;
}) {
  const { catalog, project, adoptMedia, flush, runBlockedReason } = useStudio();
  const graphs = usePipelines();
  const records = useRunList(25, "include", { project_id: plan.project_id, shot_id: candidate.shot_id, operation_kind: "draft_branch" }, "summary");
  const create = useCreateRun();
  const [pipeline, setPipeline] = useState("");
  const source = result.runs.draft?.run_id ?? "";
  const shot = project.shots.find(item => item.shot_id === candidate.shot_id);
  const parent = shot?.takes.find(item => item.run_id === source && item.output_key === plan.plan.draft_output);
  const adopt = useMutation({ mutationFn: () => adoptMedia(candidate.shot_id, source, plan.plan.draft_output, null), retry: false });
  const routes = (graphs.data?.items ?? []).filter(pipe => branchRoute(pipe, catalog));
  const route = routes.find(pipe => pipe.pipeline_id === pipeline) ?? routes[0];
  const submit = useMutation({
    mutationFn: async (id: string) => {
      await flush();
      const path = "/api/studio/projects/" + encodeURIComponent(plan.project_id) + "/draft-plans/" + encodeURIComponent(plan.plan_id) + "/branch-plan";
      const request = await contractJson("RunRequest", path, { method: "POST", json: { digest: plan.digest, candidate_id: candidate.candidate_id, pipeline_id: id } });
      return create.mutateAsync(request);
    },
    retry: false,
  });
  if (!shot || !source) return null;
  const history = (records.data?.pages.flatMap(page => page.items) ?? []).flatMap(run => {
    const origin = branchOrigin(run, plan, candidate, source);
    return origin ? [{ run, ...origin }] : [];
  });
  return <section className="mt-2 grid min-w-0 gap-2 border-t border-line-subtle pt-2">
    <h5 className="text-caption font-semibold">{t("草稿精修分支")}</h5>
    {selected && <>
      {!parent && <Button className="justify-self-start" size="sm" variant="secondary" pending={adopt.isPending} disabled={submit.isPending}
        onClick={() => { adopt.mutate(); }}>{t("將草稿附加為父 Take")}</Button>}
      <Choice label={t("精修流程")} value={route?.pipeline_id ?? ""} onChange={setPipeline}
        items={routes.map(pipe => ({ id: pipe.pipeline_id, title: pipe.label || pipe.pipeline_id }))} />
      <Button className="justify-self-start" size="sm" variant="secondary" pending={submit.isPending}
        disabled={!route || runBlockedReason !== null || adopt.isPending} onClick={() => { if (route) submit.mutate(route.pipeline_id); }}>{t("另開精修任務")}</Button>
      {runBlockedReason !== null && <p className="text-caption" role="status">{runBlockedReason}</p>}
    </>}
    <Failure error={adopt.error ?? submit.error ?? graphs.error ?? records.error} />
    {history.map(({run, parent: parentId}) => <BranchRun key={run.run_id} run={run} shot={shot} parent={parentId} />)}
    {records.hasNextPage && <Button className="justify-self-start" size="sm" variant="quiet" pending={records.isFetchingNextPage}
      onClick={() => { void records.fetchNextPage(); }}>{t("讀取較早的執行紀錄")}</Button>}
  </section>;
}
