import { AssetVideo } from "@/components/common/AssetMedia";
import { planStatus } from "./status";
import { DraftBranches } from "./DraftBranches";
import { useState } from "react";
import { Check, Play, ScanSearch, Square } from "lucide-react";
import { Link } from "react-router";
import { runPath } from "@/app/paths";
import { mediaUrl } from "@/api/http";
import type { StudioDraftPlan, StudioDraftCandidateResult, StudioFrozenDraft, StudioProject } from "@/api/generated/contracts";
import { ProgressTrack } from "@/components/flow/ProgressTrack";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export type Operation = "start" | "cancel" | "reconcile" | "select";
function display(value: unknown, fallback = "—"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}
function candidateStatus(s: StudioDraftCandidateResult["state"]) {
  return {
    queued: t("排隊中"),
    dispatched: t("已派送"),
    ready: t("可選取"),
    review: t("需要檢視"),
    failed: t("失敗"),
    skipped: t("已略過"),
  }[s];
}
function Candidate({
  c,
  r,
  title,
  plan,
  chosen,
  busy,
  select,
}: {
  c: StudioFrozenDraft;
  r: StudioDraftCandidateResult;
  title: string;
  plan: StudioDraftPlan;
  chosen: boolean;
  busy: boolean;
  select: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const quality = r.quality;
  const ev = quality?.evidence;
  const file = r.asset?.file;
  const prompt = Object.values(c.draft.inputs).find((i) => i?.type_id === "text.prompt.v1");
  return (
    <div className="min-w-0 rounded-lg border border-line-subtle bg-raised/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-data font-semibold">
          {title} · {t("候選 {n}", { n: c.variant })}
        </h4>
        <span className="text-caption text-brand-cyan">{candidateStatus(r.state)}</span>
      </div>
      <p className="mt-1 text-caption text-fg-secondary">
        {c.candidate_id} · seed {c.seed}
      </p>
      {prompt && "value" in prompt && typeof prompt.value === "string" && (
        <p className="my-1 line-clamp-2 break-words text-caption text-fg">{prompt.value}</p>
      )}
      {ev && (
        <p className="mt-2 break-words font-mono text-caption">
          {display(ev["video_codec"])} · {display(ev["width"])} × {display(ev["height"])} · {t("{n} 格", { n: display(ev["frame_count"]) })} ·{" "}
          {display(ev["duration_seconds"])} s
        </p>
      )}
      {quality !== undefined && quality.issues.length > 0 && <p className="break-words text-caption text-warning">{quality.issues.join(" · ")}</p>}
      {r.error && (
        <p className="break-words text-caption text-danger">
          {display(r.error["code"], "")} {display(r.error["message"], "")}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); }}>
          {expanded ? t("收起詳情") : t("查看請求與證據")}
        </Button>
        {file && ["ready", "review"].includes(r.state) && (
          <Button
            size="sm"
            variant={chosen ? "secondary" : "primary"}
            icon={<Check aria-hidden />}
            disabled={busy || chosen}
            onClick={select}
          >
            {chosen ? t("已選為候選") : t("選為此鏡候選")}
          </Button>
        )}
      </div>
      {file && (chosen || expanded) && ["ready", "review"].includes(r.state) && (
        <DraftBranches plan={plan} candidate={c} result={r} selected={chosen} />
      )}
      {expanded && (
        <div className="mt-3 grid min-w-0 gap-2 border-t border-line-subtle pt-2">
          {file && (
            <AssetVideo
              aria-label={t("草稿影片 {id}", { id: c.candidate_id })}
              controls
              preload="metadata"
              className="max-h-48 w-full rounded-sm bg-black"
              src={mediaUrl(file.node_id, file.file_id)}
            />
          )}
          {Object.entries(r.runs).map(
            ([k, v]) =>
              (
                <Link key={k} className="break-all text-caption text-action-fg underline" to={runPath(v.run_id)}>
                  {k} · {v.run_id}
                </Link>
              ),
          )}
          {ev && <pre className="max-h-44 overflow-auto text-caption">{JSON.stringify(ev, null, 2)}</pre>}
          {Object.entries(quality?.output_files ?? {}).map(
            ([name, ref]) =>
              ref && (
                <a
                  key={name}
                  className="break-all text-caption text-action-fg underline"
                  href={mediaUrl(ref.node_id, ref.file_id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {name}
                </a>
              ),
          )}
          <details>
            <summary className="cursor-pointer text-caption">{t("凍結的生成請求")}</summary>
            <pre className="max-h-48 overflow-auto text-caption">{JSON.stringify(c.draft, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
export function PlanDetail({
  doc,
  project,
  busy,
  act,
}: {
  doc: StudioDraftPlan;
  project: StudioProject;
  busy: boolean;
  act: (op: Operation, cid?: string) => void;
}) {
  const { plan, results } = doc;
  const completed = results.filter((r) => ["ready", "review", "failed", "skipped"].includes(r.state)).length;
  return (
    <section className="grid min-w-0 gap-3">
      <header className="rounded-lg border border-line-subtle bg-raised/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-body font-semibold" role="status">
            {planStatus(doc.status)}
          </h3>
          <span className="text-caption">{t("完成 {n}／{total} 個候選", { n: completed, total: results.length })}</span>
        </div>
        <ProgressTrack
          label={t("候選進度")}
          className="my-2"
          tone={doc.status === "completed" ? "done" : doc.status === "running" ? "running" : "idle"}
          max={results.length}
          value={completed}
        />
        <p className="text-caption text-fg-secondary">
          {t("預估 {runs} 個任務、{steps} 次步驟嘗試", { runs: plan.planned_runs, steps: plan.planned_step_attempts })} ·{" "}
          {t("期限 {n} 秒", { n: plan.budget.timeout_seconds })}
        </p>
        {plan.reserved_gpu_seconds !== undefined && plan.budget.max_gpu_seconds !== undefined ? (
          <p className="text-caption text-fg-secondary">{t("全部候選預留 {reserved} GPU 秒，上限 {limit} 秒。", { reserved: plan.reserved_gpu_seconds, limit: plan.budget.max_gpu_seconds })}</p>
        ) : null}
        {plan.reserved_external_cost_usd_micros !== undefined && plan.budget.max_external_cost_usd_micros !== undefined ? (
          <p className="text-caption text-fg-secondary">{t("全部候選預留 {reserved} 微美元，上限 {limit} 微美元。", { reserved: plan.reserved_external_cost_usd_micros, limit: plan.budget.max_external_cost_usd_micros })}</p>
        ) : null}
        {plan.reserved_gpu_seconds !== undefined || plan.reserved_external_cost_usd_micros !== undefined ? (
          <p className="text-caption text-fg-tertiary">{t("預留涵蓋所有草稿與品檢各派送一次。實際 GPU 忙碌時間及最終帳單由設備與服務端計量。")}</p>
        ) : null}
        <p className="text-caption text-fg-secondary">
          {t("已保留 {n}／{total} 個任務，{a}／{b} 次步驟嘗試", {
            n: doc.reserved_runs,
            total: plan.budget.max_runs,
            a: doc.reserved_step_attempts,
            b: plan.budget.max_step_attempts,
          })}
          {doc.deadline !== null && " · " + new Date(doc.deadline * 1000).toLocaleString()}
        </p>
        {(doc.stop_reason != null && doc.stop_reason !== "") && <p className="break-all text-caption">{doc.stop_reason}</p>}
        <details className="mt-2">
          <summary className="cursor-pointer text-caption">{t("計畫識別與品質檢查接線")}</summary>
          <p className="break-all font-mono text-caption">
            {doc.plan_id}
            <br />
            {doc.digest}
          </p>
          <pre className="max-h-40 overflow-auto text-caption">
            {JSON.stringify(
              {
                revision: plan.project_revision,
                qc_pipeline: plan.qc_pipeline,
                input: plan.qc_input,
                output: plan.qc_output,
                components: plan.components,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </header>
      <div className="flex flex-wrap gap-2">
        {doc.status === "planned" && (
          <Button variant="primary" icon={<Play aria-hidden />} disabled={busy} onClick={() => { act("start"); }}>
            {t("核准並開始")}
          </Button>
        )}
        {doc.status === "uncertain" && (
          <Button variant="secondary" icon={<ScanSearch aria-hidden />} disabled={busy} onClick={() => { act("reconcile"); }}>
            {t("重新查證既有任務")}
          </Button>
        )}
        {["planned", "running", "uncertain"].includes(doc.status) && (
          <Button variant="secondary" icon={<Square aria-hidden />} disabled={busy} onClick={() => { act("cancel"); }}>
            {t("停止此計畫")}
          </Button>
        )}
      </div>
      <p className="text-caption text-fg-secondary">{t("人工選取會保存在這份計畫，鏡頭目前使用的 Take 與時間軸保持原狀。")}</p>
      <div className="grid min-w-0 items-start gap-2 sm:grid-cols-2">
        {plan.candidates.map((c) => {
          const r = results.find((v) => v.candidate_id === c.candidate_id);
          return r ? (
            <Candidate
              key={doc.plan_id + "/" + c.candidate_id}
              plan={doc}
              c={c}
              r={r}
              title={project.shots.find((s) => s.shot_id === c.shot_id)?.title ?? c.shot_id}
              chosen={doc.selected[c.shot_id] === c.candidate_id}
              busy={busy}
              select={() => { act("select", c.candidate_id); }}
            />
          ) : null;
        })}
      </div>
    </section>
  );
}
