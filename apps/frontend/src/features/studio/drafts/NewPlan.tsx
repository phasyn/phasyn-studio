import { useState, type SubmitEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import type { StudioDraftPlan, StudioDraftPlanRequest, StudioProject } from "@/api/generated/contracts";
import { contractJson } from "@/api/http";
import { fetchProject, studioKeys } from "@/api/studioProjects";
import { usePipelines } from "@/api/pipelines";
import type { WirePipeline } from "@/api/types";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { Choice, Count, Failure } from "./fields";

interface FormProps { project: StudioProject; root: string; onSave: (d: StudioDraftPlan) => void; flush: () => Promise<void> }
const options = (ids: string[]) => ids.map((id) => ({ id, title: id }));
function bindings(pipe: WirePipeline | undefined) {
  return (pipe?.inputs ?? []).filter((port) => ["media.image.v1", "media.video.v1", "media.audio.v1"].includes(port.type_id));
}
function BindForm({ project, root, onSave, flush, pipelines }: { pipelines: WirePipeline[] } & FormProps) {
  const cache = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [genId, setGenId] = useState("");
  const [qcId, setQcId] = useState("");
  const [seedSid, setSeedSid] = useState("");
  const [promptPort, setPromptPort] = useState("");
  const [out, setOut] = useState("");
  const [qcPort, setQcPort] = useState("");
  const [probeOut, setProbeOut] = useState("");
  const [variants, setVariants] = useState("2");
  const [seed, setSeed] = useState("42");
  const [runs, setRuns] = useState("");
  const [attempts, setAttempts] = useState("");
  const [seconds, setSeconds] = useState("7200");
  const [gpuSeconds, setGpuSeconds] = useState("");
  const [externalMicros, setExternalMicros] = useState("");
  const [refs, setRefs] = useState<Record<string, Record<string, string>>>({});
  const [planId] = useState(() => crypto.randomUUID());
  const generators = pipelines.filter((p) => p.inputs.some((i) => i.type_id === "text.prompt.v1"));
  const checks = pipelines.filter((p) => p.inputs.some((i) => i.type_id === "media.video.v1"));
  const gen =
    generators.find((p) => p.pipeline_id === genId) ??
    generators.find((p) => p.pipeline_id === "t2va-draft-local") ??
    generators[0];
  const qc = checks.find((p) => p.pipeline_id === qcId) ?? checks.find((p) => p.pipeline_id === "review-take-local") ?? checks[0];
  const prompts = gen?.inputs.filter((i) => i.type_id === "text.prompt.v1").map((i) => i.name) ?? [];
  const videos = qc?.inputs.filter((i) => i.type_id === "media.video.v1").map((i) => i.name) ?? [];
  const outputs = Object.keys(gen?.outputs ?? {}),
    reports = Object.keys(qc?.outputs ?? {});
  const source = prompts.includes(promptPort) ? promptPort : (prompts[0] ?? "");
  const video = videos.includes(qcPort) ? qcPort : (videos[0] ?? "");
  const seedStep =
    gen?.steps.find((s) => s.step_id === seedSid) ??
    gen?.steps.find((s) => s.step_id === "dit" || Object.hasOwn(s.parameters, "seed")) ??
    gen?.steps[0];
  const asset = outputs.includes(out) ? out : outputs.includes("final") ? "final" : (outputs[0] ?? "");
  const report = reports.includes(probeOut) ? probeOut : reports.includes("report") ? "report" : (reports[0] ?? "");
  const items = chosen.length * Number(variants);
  const expectedRuns = items * 2,
    expectedSteps = items * ((gen?.steps.length ?? 0) + (qc?.steps.length ?? 0));
  const runLimit = runs === "" ? expectedRuns : Number(runs),
    attemptLimit = attempts === "" ? expectedSteps : Number(attempts);
  const bound = bindings(gen);
  const submit = useMutation({
    mutationFn: async (spec: StudioDraftPlanRequest) => {
      await flush();
      const saved = cache.getQueryData<StudioProject>(studioKeys.project(project.project_id)) ?? await fetchProject(project.project_id);
      if (JSON.stringify([saved.shots, saved.library]) !== JSON.stringify([project.shots, project.library])) {
        throw new Error(t("草稿內容已變更，請重新選擇鏡頭。"));
      }
      return contractJson("StudioDraftPlan", root + "/" + planId, { method: "PUT", json: { ...spec, project_revision: saved.revision } });
    },
    onSuccess: onSave,
    retry: false,
  });
  function save(e: SubmitEvent) {
    e.preventDefault();
    if (!gen || !qc || !seedStep || submit.isPending) return;
    submit.mutate({
      project_revision: project.revision,
      pipeline_id: gen.pipeline_id,
      prompt_input: source,
      seed_step: seedStep.step_id,
      output_key: asset,
      qc_pipeline_id: qc.pipeline_id,
      qc_input: video,
      qc_output: report,
      shots: project.shots
        .filter((s) => chosen.includes(s.shot_id))
        .map((s) => ({
          shot_id: s.shot_id,
          library_inputs: Object.fromEntries(
            bound.flatMap((port) => {
              const id = refs[s.shot_id]?.[port.name];
              return (id != null && id !== "") ? [[port.name, id]] : [];
            }),
          ),
        })),
      variants: Number(variants),
      seed: Number(seed),
      budget: {
        max_runs: runLimit, max_step_attempts: attemptLimit, timeout_seconds: Number(seconds),
        ...(gpuSeconds === "" ? {} : { max_gpu_seconds: Number(gpuSeconds) }),
        ...(externalMicros === "" ? {} : { max_external_cost_usd_micros: Number(externalMicros) }),
      },
    });
  }
  function pickShot(id: string) {
    setChosen(chosen.includes(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);
  }
  const valid =
    chosen.length > 0 &&
    chosen.length <= 16 &&
    items <= 32 &&
    !!gen &&
    !!qc &&
    asset !== "" &&
    report !== "" &&
    seedStep !== undefined &&
    source !== "" &&
    video !== "" &&
    runLimit >= expectedRuns &&
    attemptLimit >= expectedSteps &&
    [gpuSeconds, externalMicros].every((amount) => amount === "" || (Number.isSafeInteger(Number(amount)) && Number(amount) >= 0));
  return (
    <form onSubmit={save} className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-body font-semibold">{t("選擇草稿鏡頭")}</legend>
        {!project.shots.length && <p className="text-caption">{t("專案尚無鏡頭")}</p>}
        {project.shots.map((s) => (
          <div key={s.shot_id} className="grid gap-2 rounded-lg border border-line-subtle px-3 py-2">
            <label aria-label={[s.title, s.prompt].filter(Boolean).join(" ")} className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={chosen.includes(s.shot_id)}
                disabled={!s.prompt.trim() || (!chosen.includes(s.shot_id) && chosen.length >= 16)}
                onChange={() => { pickShot(s.shot_id); }}
                className="mt-1 accent-brand-cyan"
              />
              <span className="min-w-0">
                <strong className="block text-data">{s.title}</strong>
                <span className="line-clamp-2 break-words text-caption text-fg-secondary">{s.prompt || t("請先輸入提示詞")}</span>
              </span>
            </label>
            {chosen.includes(s.shot_id) &&
              bound.map((port) => (
                <Choice
                  key={port.name}
                  label={t("素材輸入 {name}", { name: port.name })}
                  optional={!port.required}
                  value={refs[s.shot_id]?.[port.name] ?? ""}
                  items={[
                    ...(port.required ? [{ id: "", title: t("請選擇素材") }] : []),
                    ...(project.library ?? [])
                      .filter((i) => port.type_id === "media." + i.kind + ".v1")
                      .map((i) => ({ id: i.item_id, title: i.name })),
                  ]}
                  onChange={(val) => { setRefs({ ...refs, [s.shot_id]: { ...refs[s.shot_id], [port.name]: val } }); }}
                />
              ))}
          </div>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice
          label={t("草稿元件組合")}
          value={gen?.pipeline_id ?? ""}
          items={generators.map((p) => ({ id: p.pipeline_id, title: p.label || p.pipeline_id }))}
          onChange={(v) => {
            setGenId(v);
            setSeedSid("");
            setPromptPort("");
            setOut("");
            setRefs({});
          }}
        />
        <Choice
          label={t("品質檢查元件組合")}
          value={qc?.pipeline_id ?? ""}
          items={checks.map((p) => ({ id: p.pipeline_id, title: p.label || p.pipeline_id }))}
          onChange={(v) => {
            setQcId(v);
            setQcPort("");
            setProbeOut("");
          }}
        />
      </div>
      <details className="rounded-lg border border-line-subtle p-2">
        <summary className="cursor-pointer text-caption">{t("檢視或調整輸入與輸出接線")}</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Choice label={t("提示詞輸入埠")} value={source} items={options(prompts)} onChange={setPromptPort} />
          <Choice
            label={t("設定 seed 的步驟")}
            value={seedStep?.step_id ?? ""}
            items={options(gen?.steps.map((s) => s.step_id) ?? [])}
            onChange={setSeedSid}
          />
          <Choice label={t("草稿影片輸出")} value={asset} items={options(outputs)} onChange={setOut} />
          <Choice label={t("品檢影片輸入")} value={video} items={options(videos)} onChange={setQcPort} />
          <Choice label={t("技術報告輸出")} value={report} items={options(reports)} onChange={setProbeOut} />
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Count label={t("每鏡候選數")} value={variants} onChange={setVariants} max={8} />
        <Count label={t("起始 seed")} value={seed} onChange={setSeed} min={0} max={Number.MAX_SAFE_INTEGER - items + 1} />
        <Count label={t("任務上限")} value={runs} onChange={setRuns} max={64} placeholder={String(expectedRuns)} />
        <Count label={t("步驟嘗試上限")} value={attempts} onChange={setAttempts} max={512} placeholder={String(expectedSteps)} />
        <Count label={t("期限（秒）")} value={seconds} onChange={setSeconds} max={86400} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Count label={t("GPU 秒數上限")} value={gpuSeconds} onChange={setGpuSeconds} min={0} max={Number.MAX_SAFE_INTEGER} placeholder={t("不設上限")} />
        <Count label={t("外部費用上限（微美元）")} value={externalMicros} onChange={setExternalMicros} min={0} max={Number.MAX_SAFE_INTEGER} placeholder={t("不設上限")} />
      </div>
      <p className="text-caption text-fg-secondary">{t("GPU 秒數按各步驟的派送期限乘以可見 CUDA 裝置數預留。1 美元等於 1,000,000 微美元，設定費用上限時，每個步驟都須有可核對的收費上界。")}</p>
      <p className="text-caption text-fg-secondary">
        {t("預估 {n} 個候選、{runs} 個任務、{steps} 次步驟嘗試；每一步最多派送一次。", {
          n: items,
          runs: expectedRuns,
          steps: expectedSteps,
        })}
      </p>
      <Failure error={submit.error} />
      <Button
        type="submit"
        variant="primary"
        className="justify-self-start"
        icon={<FileSearch aria-hidden />}
        disabled={!valid || submit.isPending}
      >
        {t("建立計畫預覽")}
      </Button>
    </form>
  );
}
export function NewPlan(props: FormProps) {
  const pipelines = usePipelines();
  return pipelines.data ? (
    <BindForm {...props} pipelines={pipelines.data.items} />
  ) : pipelines.isError ? (
    <Failure error={pipelines.error} />
  ) : (
    <p role="status">{t("讀取中…")}</p>
  );
}
