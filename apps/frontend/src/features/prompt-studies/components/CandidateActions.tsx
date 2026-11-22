import { isListed } from "@/lib/json";
// 候選的兩個人工動作（都要確認，都不會自動生成）：
//   接受＝記錄人工選擇（不改機器評分、不覆寫搜尋的最佳候選）；
//   套用到 Image Studio＝在選定的 Studio 專案新增一個圖片鏡頭（prompt＋生成設定），之後在 Image Studio 確認再生成。
//   Image Studio itself judges the pipeline for the text-to-image shot (an image-to-image one can never generate it).
import { useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ExternalLink, Send } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Catalog } from "@/api/generated/contracts";
import type { WirePipeline } from "@/api/types";
import { runPath } from "@/app/paths";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { buttonVariants } from "@/components/ui/variants";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deriveImageRoutes, shotRouteProblem } from "@/features/image-studio";
import { hasErrorCode } from "@/lib/errors";
import { appendImageShot, useStudioProjects } from "../api";
import { applyBlockReason, applySummary, imageShotFromCandidate, type ImageSeedMode } from "../model/applyToImage";
import { candidateOf } from "../model/compile";
import { formatLoss } from "../model/loss";
import { MAX_SEED } from "../model/seeds";
import { LIMITS } from "../model/sections";
import { evaluationLoss } from "../model/search";
import { acceptanceSource, acceptBlockReason, acceptedRef, bestEvaluation, evaluationsForCandidate, evaluationsOf, findVersion, TASK_LABELS, versionLabel } from "../model/study";
import type { CandidateRef, GenerationSettings, PromptAcceptance, PromptStudy } from "../types";
import { imageStudioShotPath } from "../paths";
import { t } from "@/i18n";

export function AcceptDialog({
  study,
  candidate,
  taskId,
  open,
  onOpenChange,
  onAccept,
}: {
  study: PromptStudy;
  candidate: CandidateRef | null;
  /** 優先作為依據的任務（例如從搜尋結果按「接受」）。 */
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: (versionId: string, acceptance: PromptAcceptance) => Promise<void>;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const version = findVersion(study, candidate?.version_id);
  const prompt = candidate ? (candidateOf(version, candidate.variant)?.prompt ?? "") : "";
  const source = candidate ? acceptanceSource(study, candidate, taskId) : null;
  const blockReason = acceptBlockReason(study, candidate);
  const sourceEvaluation = source ? (evaluationsOf(source.task).find((item) => item.render_run_id === source.render.run_id) ?? null) : null;
  const previous = acceptedRef(study);
  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  };
  const accept = async () => {
    if (!candidate || !source || pending) return;
    setPending(true);
    setError(null);
    try {
      await onAccept(candidate.version_id, { variant: candidate.variant, task_id: source.task.task_id, run_id: source.render.run_id, note: note.trim(), accepted_at: new Date().toISOString() });
      close(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{candidate ? t("接受 {versionLabel} 的 {variant}？", { versionLabel: versionLabel(study, candidate.version_id), variant: candidate.variant }) : t("接受候選？")}</DialogTitle>
          <DialogDescription>{t("只記錄人工選擇；不改機器評分、不覆寫搜尋找到的最佳候選，也不會生成圖片。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          <pre className="max-h-40 overflow-auto rounded-lg border border-line-subtle bg-sunken px-3 py-2 font-mono text-caption whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{prompt || t("（空白）")}</pre>
          {source ? (
            <p className="flex flex-wrap items-center gap-1 text-caption text-fg-secondary">
              <span>
                {sourceEvaluation
                  ? t("依據：「{kind}」任務中生成成功的圖（seed {seed}，誤差 {sourceEvaluation}）", { kind: TASK_LABELS[source.task.kind], seed: source.render.seed, sourceEvaluation: formatLoss(evaluationLoss(sourceEvaluation)) })
                  : t("依據：「{kind}」任務中生成成功的圖（seed {seed}，沒有比較結果）", { kind: TASK_LABELS[source.task.kind], seed: source.render.seed })}
              </span>
              <Link to={runPath(source.render.run_id)} className="machine text-caption">
                {source.render.run_id.slice(0, 8)}
              </Link>
            </p>
          ) : (
            <Callout tone="warning" title={t("還不能接受")}>
              <p>{blockReason ?? t("找不到這個候選生成成功的圖")}</p>
            </Callout>
          )}
          {previous && study.acceptance ? (
            <Callout tone="warning" title={t("會取代目前的接受紀錄")}>
              <p>{t("目前接受的是 {versionLabel} {variant}{value}。", { versionLabel: versionLabel(study, previous.version_id), variant: previous.variant, value: study.acceptance.note ? t("（備註：{note}）", { note: study.acceptance.note }) : "" })}</p>
            </Callout>
          ) : null}
          <div className="grid gap-1">
            <label htmlFor={`${id}-note`} className="text-caption text-fg-secondary">
              {t("人工接受備註")}
            </label>
            <Textarea id={`${id}-note`} compact rows={2} maxLength={LIMITS.acceptNote} value={note} onChange={(event) => { setNote(event.target.value); }} />
          </div>
          {(error != null) ? <ErrorCallout error={error} write title={t("接受紀錄沒有保存")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => { close(false); }} disabled={pending}>
            {t("取消")}
          </Button>
          <ActionButton variant="primary" icon={<BadgeCheck aria-hidden />} pending={pending} disabledReason={pending ? null : source ? null : (blockReason ?? t("還不能接受"))} onClick={() => void accept()}>
            {t("接受")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApplyDialog({
  study,
  candidate,
  settings,
  pipelines,
  catalog,
  routesLoading,
  open,
  onOpenChange,
}: {
  study: PromptStudy;
  candidate: CandidateRef | null;
  /** 套用的生成設定（目前的設定，或搜尋任務凍結的設定）。 */
  settings: GenerationSettings;
  /** The saved pipelines and the component catalog, from which Image Studio derives its own routes. */
  pipelines: readonly WirePipeline[] | undefined;
  catalog: Catalog | undefined;
  /** Pipelines or the catalog are still loading (no route can be judged yet). */
  routesLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const projects = useStudioProjects();
  const imageRoutes = useMemo(() => deriveImageRoutes(pipelines, catalog), [pipelines, catalog]);
  const [projectId, setProjectId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [seedText, setSeedText] = useState<string | null>(null);
  const [seedMode, setSeedMode] = useState<ImageSeedMode>("fixed");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ projectId: string; shotId: string; title: string } | null>(null);
  const version = findVersion(study, candidate?.version_id);
  const prompt = candidate ? candidateOf(version, candidate.variant) : null;
  const best = candidate ? bestEvaluation(evaluationsForCandidate(study, candidate)) : null;
  const defaultSeed = best ? String(best.seed) : "-1";
  const seedValue = Number((seedText ?? defaultSeed).trim());
  const seedValid = Number.isSafeInteger(seedValue) && seedValue >= -1 && seedValue <= MAX_SEED;
  const project = (projects.data?.items ?? []).find((item) => item.project_id === projectId) ?? null;
  const label = candidate ? versionLabel(study, candidate.version_id) : "";
  const shot =
    candidate && prompt
      ? imageShotFromCandidate({ studyTitle: study.title || t("未命名研究"), versionLabel: label, variant: candidate.variant, candidate: prompt, settings, seed: seedValid ? seedValue : -1, seedMode, title })
      : null;
  // Image Studio's own check before generating, for the shot as written: a pipeline that is not one of its image
  // pipelines, or is for image-to-image, can never generate it. Components that are not ready are started in Image
  // Studio, so readiness is not checked. Nothing is judged before the pipelines are read.
  const routeUnjudged = !(shot?.route != null && shot.route !== "") ? null : routesLoading ? t("還在讀取元件組合與元件目錄") : pipelines ? null : t("無法讀取元件組合");
  const routeProblem = (shot?.route != null && shot.route !== "") && !(routeUnjudged != null && routeUnjudged !== "") ? shotRouteProblem(imageRoutes, shot.route, shot.mode) : null;
  const blockReason = !shot
    ? t("這個版本沒有這個候選")
    : !seedValid
      ? t("seed 必須是 -1（隨機）或 0–{maxSeed}", { maxSeed: MAX_SEED })
      : (routeUnjudged ?? routeProblem ?? applyBlockReason(project, shot));

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setError(null);
      setDone(null);
      setSeedText(null);
      setTitle("");
    }
    onOpenChange(next);
  };
  const apply = async () => {
    if (!shot || (blockReason != null && blockReason !== "") || pending || !projectId) return;
    setPending(true);
    setError(null);
    try {
      await appendImageShot(client, projectId, shot);
      setDone({ projectId, shotId: shot.image_shot_id, title: shot.title });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("套用到 Image Studio")}</DialogTitle>
          <DialogDescription>{t("在選定的 Studio 專案新增一個圖片鏡頭（文生圖）。只寫入設定，不會自動生成；原有鏡頭不受影響。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {done ? (
            <Callout tone="success" title={t("已新增圖片鏡頭「{title}」", { title: done.title })}>
              <p>{t("到 Image Studio 確認設定後再按生成。")}</p>
              <Link to={imageStudioShotPath(done.projectId, done.shotId)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <ExternalLink aria-hidden />{t("在 Image Studio 開啟")}
              </Link>
            </Callout>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1">
                  <label htmlFor={`${id}-project`} className="text-caption text-fg-secondary">
                    {t("Studio 專案（Image Studio 與 Video Studio 共用）")}
                  </label>
                  {projects.isError ? (
                    <ErrorCallout error={projects.error} title={t("無法讀取 Studio 專案列表")} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />
                  ) : (
                    <Select id={`${id}-project`} compact value={projectId} disabled={projects.isPending} onChange={(event) => { setProjectId(event.target.value); }}>
                      <option value="">{projects.isPending ? t("讀取中…") : projects.data.items.length === 0 ? t("沒有專案：先在 Studio 建立") : t("選擇專案")}</option>
                      {(projects.data?.items ?? []).map((item) => (
                        <option key={item.project_id} value={item.project_id}>
                          {item.title}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`${id}-title`} className="text-caption text-fg-secondary">
                    {t("圖片鏡頭名稱")}
                  </label>
                  <Input id={`${id}-title`} compact value={title} maxLength={120} placeholder={t("{value}・{label} {value2}", { value: study.title || t("未命名研究"), label, value2: candidate?.variant ?? "" })} onChange={(event) => { setTitle(event.target.value); }} />
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`${id}-seed`} className="text-caption text-fg-secondary">
                    {t("seed（-1＝每次隨機）")}
                  </label>
                  <Input id={`${id}-seed`} compact className="machine" inputMode="numeric" value={seedText ?? defaultSeed} aria-invalid={!seedValid || undefined} onChange={(event) => { setSeedText(event.target.value); }} />
                  <span className="text-caption text-fg-tertiary">{best ? t("預設為誤差最低的那張（seed {seed}，誤差 {best}）", { seed: best.seed, best: formatLoss(evaluationLoss(best)) }) : t("這個候選沒有已評分的圖，預設隨機")}</span>
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`${id}-seed-mode`} className="text-caption text-fg-secondary">
                    {t("seed 模式")}
                  </label>
                  <Select id={`${id}-seed-mode`} compact value={seedMode} onChange={(event) => { const value = event.target.value; if (isListed(value, ["fixed", "increment", "random"] as const)) setSeedMode(value); }}>
                    <option value="fixed">{t("固定")}</option>
                    <option value="increment">{t("遞增")}</option>
                    <option value="random">{t("每次隨機")}</option>
                  </Select>
                </div>
              </div>
              {(routeProblem != null && routeProblem !== "") ? (
                <Callout tone="warning" title={t("Image Studio 不能用這個元件組合生成")}>
                  <p>{routeProblem}</p>
                </Callout>
              ) : null}
              {shot && project ? (
                <section className="grid gap-1" aria-label={t("將寫入的內容")}>
                  <h3 className="text-data font-semibold text-fg">{t("將寫入")}</h3>
                  <ul className="grid list-disc gap-0.5 pl-5 text-caption text-fg-secondary">
                    {applySummary(shot, project.title).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <p className="text-caption text-fg-tertiary">{t("Image Studio 若正開著這個專案，它下一次保存會出現版本衝突並要求重新載入（與刪除 run 後的行為相同）。")}</p>
              {(error != null) ? (
                <ErrorCallout error={error} write title={hasErrorCode(error, "REVISION_CONFLICT") ? t("專案剛被其他地方更新：這次沒有寫入（再按一次會以最新版本寫入）") : t("沒有寫入專案")} />
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {done ? (
            <Button variant="secondary" onClick={() => { close(false); }}>
              {t("關閉")}
            </Button>
          ) : (
            <>
              <Button variant="quiet" onClick={() => { close(false); }} disabled={pending}>
                {t("取消")}
              </Button>
              <ActionButton variant="primary" icon={<Send aria-hidden />} pending={pending} disabledReason={pending ? null : blockReason} onClick={() => void apply()}>
                {t("確認套用")}
              </ActionButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
