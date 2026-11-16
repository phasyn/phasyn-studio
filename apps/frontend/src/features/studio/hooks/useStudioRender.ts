// Submitting Video Studio runs: render shots (several shots = one batch run), render variants of one shot (its seed,
// a reference's file and its route varied, model/variants.ts; every variant a take of the shot), render the variants
// of several shots in one batch run (model/variantBatch.ts) and export the sequence. With lanes chosen for the project
// (model/lanes.ts), every render is spread over them first — the variants of one shot together, on the lane fastest
// for that shot — except variants that pick their own routes: the route is what they compare. A run holds at most
// MAX_RUN_STEPS steps (the contract's limit), checked before it is sent. Take ids are decided before sending (a
// continuation inside the batch refers to the previous branch's take). Nothing is sent when the engine cannot tell
// yet, the route is missing or not ready, or a reference has a problem — and nothing falls back to t2va. Every run is
// POSTed once; a failure is reported, never resent.
import { useCallback, useRef, useState } from "react";
import type { Catalog, StudioProject, StudioShot, StudioTimeline, TimelineSource } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { useCreateRun } from "@/api/runs";
import type { NoticeInput } from "@/features/studio-shell";
import { exportTarget, prepareTimelineExport, sequenceExport } from "../editor/export";
import { proxyRequest } from "../editor/proxy";
import type { SegmentEtaEstimator } from "../model/eta";
import { useProjectLanes } from "../model/lanePrefs";
import { laneSummary, MIN_LANES, splitLanes } from "../model/lanes";
import type { ExportOptions } from "../model/pipelines";
import { localId, type ProjectAction } from "../model/project";
import { planRender, renderTakes } from "../model/renderPlan";
import { engineUnavailable, type Engine } from "../model/routes";
import { drawSeeds, MAX_VARIANT_TAKES, MIN_VARIANT_TAKES, type ShotVariant, type ShotVariants } from "../model/variants";
import { errorText } from "../swap/errors";
import { MAX_RUN_STEPS } from "../swap/limits";
import { t } from "@/i18n";

export type StudioBusy = "render" | "export" | null;

/** The shot rendered as each variant: its seed, route and references; everything else is the shot's. */
const variantBranches = (shot: StudioShot, variants: readonly ShotVariant[]): StudioShot[] =>
  variants.map((variant) => ({ ...shot, seed: variant.seed, route: variant.route, ...(variant.references ? { references: variant.references } : {}) }));

export interface StudioRenderInput {
  project: StudioProject;
  dispatch: (action: ProjectAction) => void;
  engine: Engine;
  catalog: Catalog | undefined;
  notify: (notice: NoticeInput) => void;
  /** Render-time estimates (cost profiles): a render with lanes asks it for each shot's DiT time. */
  estimator: SegmentEtaEstimator;
}

const renderLink = (projectId: string, runId?: string) => `/studio/render?project=${encodeURIComponent(projectId)}${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;

export function useStudioRender({ project, dispatch, engine, catalog, notify, estimator }: StudioRenderInput) {
  const { mutateAsync: postRun } = useCreateRun();
  // The lanes chosen for this project in this browser (model/lanePrefs.ts): every render below uses them
  const storedLanes = useProjectLanes(project.project_id);
  const [busy, setBusy] = useState<StudioBusy>(null);
  /** Read synchronously so a second click during a submission sends nothing. */
  const busyRef = useRef<StudioBusy>(null);

  const begin = (kind: Exclude<StudioBusy, null>) => {
    busyRef.current = kind;
    setBusy(kind);
  };
  const end = () => {
    busyRef.current = null;
    setBusy(null);
  };

  const submitRender = useCallback(
    async (requested: StudioShot[], label: string | undefined, noticeTitle: string): Promise<boolean> => {
      const unavailable = engineUnavailable(engine);
      if (unavailable) {
        notify({ tone: "warning", title: t("渲染引擎還不能判斷"), detail: unavailable, link: { label: t("開啟渲染引擎"), to: "#engine" } });
        return false;
      }
      begin("render");
      try {
        // Lanes: each shot's route is decided here, before the run is planned, and written into the shot once the run
        // exists. The variants of one shot stay together on the lane that is fastest for that shot (the first of them
        // stands for the shot); variants that pick their routes (another one than the shot's, or several) keep them and
        // leave the shot's route alone.
        const routeOf = new Map(project.shots.map((shot) => [shot.shot_id, shot.route]));
        const pickedRoutes = requested.some((shot) => routeOf.has(shot.shot_id) && routeOf.get(shot.shot_id) !== shot.route);
        const lanes = storedLanes.length >= MIN_LANES && !pickedRoutes ? storedLanes : [];
        const firsts = requested.filter((shot, index) => requested.findIndex((item) => item.shot_id === shot.shot_id) === index);
        const split = lanes.length > 0 ? await splitLanes(project, firsts, engine.routes, lanes, estimator) : null;
        if (split && split.problem !== null) {
          notify({ tone: "warning", title: t("無法分流"), detail: split.problem, link: { label: t("開啟渲染引擎"), to: "#engine" } });
          return false;
        }
        const laneOf = new Map((split?.shots ?? []).map((shot) => [shot.shot_id, shot.route]));
        const branches = split ? requested.map((shot) => ({ ...shot, route: laneOf.get(shot.shot_id) ?? shot.route })) : requested;
        const takeIds = branches.map(() => localId("t"));
        const { plan, problem } = planRender(project, branches, takeIds, { routes: engine.routes, catalog }, { label });
        if (!plan) {
          notify({ tone: "warning", title: t("無法渲染"), detail: problem, link: { label: t("開啟渲染引擎"), to: "#engine" } });
          return false;
        }
        const steps = plan.body.pipeline.steps.length;
        if (steps > MAX_RUN_STEPS) {
          notify({ tone: "warning", title: t("無法渲染"), detail: t("這個 run 有 {steps} 個步驟，超過一個 run 的上限 {max}：少選幾個鏡頭、seed、檔案或路線", { steps, max: MAX_RUN_STEPS }) });
          return false;
        }
        const run = await postRun(plan.body);
        for (const move of split?.moves ?? []) dispatch({ type: "updateShot", shotId: move.shotId, patch: { route: move.to } });
        dispatch({ type: "addTakes", takes: renderTakes(project, branches, plan, takeIds, run) });
        const unsplit = pickedRoutes && storedLanes.length >= MIN_LANES ? t("變體各自指定路線，這次不分流。") : undefined;
        notify({
          tone: "info",
          title: noticeTitle,
          detail: split ? laneSummary(split) : unsplit,
          link: { label: t("查看渲染進度"), to: renderLink(project.project_id, run.run_id) },
        });
        return true;
      } catch (error) {
        const active = isApiError(error) && error.code === "RUN_ACTIVE";
        notify({
          tone: "danger",
          title: active ? t("目前有其他 run 正在執行") : t("無法開始渲染"),
          detail: active ? t("主控的同時執行數已滿；等其中一個 run 結束，或在「渲染」取消一個後再試。") : errorText(error),
          link: active ? { label: t("查看執行中的 run"), to: renderLink(project.project_id) } : undefined,
        });
        return false;
      } finally {
        end();
      }
    },
    [catalog, dispatch, engine, estimator, notify, postRun, project, storedLanes],
  );

  const renderShots = useCallback(
    async (shotIds: string[]) => {
      if (busyRef.current) return;
      const shots = shotIds.flatMap((id) => project.shots.filter((shot) => shot.shot_id === id));
      if (shots.length === 0) return;
      const empty = shots.find((shot) => !shot.prompt.trim());
      if (empty) {
        notify({ tone: "warning", title: t("「{title}」還沒有 prompt", { title: empty.title }), detail: t("在右側屬性面板的「Prompt」分頁輸入要生成的內容後再渲染。") });
        return;
      }
      const title = shots.length === 1 ? t("開始渲染「{value}」", { value: shots[0]?.title ?? "" }) : t("開始批次渲染 {shotsCount} 個鏡頭", { shotsCount: shots.length });
      await submitRender(shots, undefined, title);
    },
    [notify, project, submitRender],
  );

  /**
   * One shot rendered as 2–8 variants in one run, each the shot with its own seed, reference files and route
   * (model/variants.ts); every variant becomes a take that records them. The shot's own settings stay as they are.
   */
  const renderVariants = useCallback(
    async (shotId: string, variants: readonly ShotVariant[]) => {
      if (busyRef.current) return;
      const shot = project.shots.find((item) => item.shot_id === shotId);
      if (!shot || variants.length < MIN_VARIANT_TAKES || variants.length > MAX_VARIANT_TAKES) return;
      if (!shot.prompt.trim()) {
        notify({ tone: "warning", title: t("「{title}」還沒有 prompt", { title: shot.title }) });
        return;
      }
      const branches = variantBranches(shot, variants);
      await submitRender(
        branches,
        t("Studio：{title}・{title2}・{branchesCount} 個變體", { title: project.title, title2: shot.title, branchesCount: branches.length }),
        t("開始渲染「{title}」的 {branchesCount} 個變體", { title: shot.title, branchesCount: branches.length }),
      );
    },
    [notify, project, submitRender],
  );

  /**
   * The variants of several shots in one batch run (2–8 per shot, model/variantBatch.ts), in the order given; every
   * variant becomes a take of its own shot. Resolves true once the run was sent (false: nothing was sent, and the
   * notice says why), so the dialog keeps its choices when the Controller refuses.
   */
  const renderVariantBatch = useCallback(
    async (groups: readonly ShotVariants[]): Promise<boolean> => {
      if (busyRef.current || groups.length === 0) return false;
      const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
      const branches: StudioShot[] = [];
      for (const group of groups) {
        const shot = byId.get(group.shotId);
        if (!shot || group.variants.length < MIN_VARIANT_TAKES || group.variants.length > MAX_VARIANT_TAKES) return false;
        if (!shot.prompt.trim()) {
          notify({ tone: "warning", title: t("「{title}」還沒有 prompt", { title: shot.title }) });
          return false;
        }
        branches.push(...variantBranches(shot, group.variants));
      }
      return submitRender(
        branches,
        t("Studio：{title}・{shotsCount} 個鏡頭・{branchesCount} 個變體", { title: project.title, shotsCount: groups.length, branchesCount: branches.length }),
        t("開始渲染 {shotsCount} 個鏡頭的 {branchesCount} 個變體", { shotsCount: groups.length, branchesCount: branches.length }),
      );
    },
    [notify, project, submitRender],
  );

  /** One shot rendered with `count` different random seeds (2–8, one run); each becomes a take. */
  const renderVariations = useCallback(
    async (shotId: string, count: number) => {
      const shot = project.shots.find((item) => item.shot_id === shotId);
      if (!shot) return;
      const seeds = drawSeeds(Array.from({ length: Math.max(MIN_VARIANT_TAKES, Math.min(MAX_VARIANT_TAKES, count)) }, () => ({ kind: "random" as const })));
      await renderVariants(shotId, seeds.map((seed) => ({ seed, route: shot.route, references: shot.references })));
    },
    [project, renderVariants],
  );

  const exportSequence = useCallback(
    async (options: ExportOptions = {}) => {
      if (busyRef.current) return;
      const component = engine.concat.component;
      if (!engine.concat.usable || !component) {
        notify({ tone: "warning", title: t("序列匯出元件無法使用"), detail: engine.concat.reason ?? undefined, link: { label: t("開啟渲染引擎"), to: "#engine" } });
        return;
      }
      // The same request as the character-swap panel's export: the project's one timeline
      begin("export");
      try {
        const captured = await prepareTimelineExport(project);
        const result = sequenceExport(captured, exportTarget(component), options);
        if (!result.body) {
          notify({ tone: "warning", title: t("序列還不能匯出"), detail: result.problems.join(t("；")) });
          return;
        }
        const run = await postRun(result.body);
        dispatch({
          type: "addExport",
          record: { export_id: localId("x"), run_id: run.run_id, created_at: run.created_at, state: "rendering", shot_ids: result.shotIds, asset: null, error: null, frames: null },
        });
        notify({
          tone: "info",
          title: t("開始匯出序列（{clipsCount} 個片段）", { clipsCount: result.clips }),
          link: { label: t("查看匯出進度"), to: renderLink(project.project_id, run.run_id) },
        });
      } catch (error) {
        notify({ tone: "danger", title: t("無法開始匯出"), detail: errorText(error) });
      } finally {
        end();
      }
    },
    [dispatch, engine.concat, notify, postRun, project],
  );

  const createProxy = useCallback(async (timeline: StudioTimeline, source: TimelineSource) => {
    if (busyRef.current) return;
    const component = engine.concat.component;
    if (!engine.concat.usable || !component) {
      notify({ tone: "warning", title: t("序列匯出元件無法使用"), detail: engine.concat.reason ?? undefined });
      return;
    }
    begin("export");
    try {
      const body = proxyRequest(timeline, source, { node_id: component.node_id, component_id: component.component_id });
      const run = await postRun(body);
      dispatch({ type: "patchTimelineSource", sourceId: source.source_id, patch: { proxy_run_id: run.run_id, proxy_source_sha256: source.file?.sha256, proxy_error: undefined, proxy: undefined } });
      notify({ tone: "info", title: t("已開始建立代理媒體"), link: { label: t("查看渲染進度"), to: renderLink(project.project_id, run.run_id) } });
    } catch (error) {
      notify({ tone: "danger", title: t("無法建立代理媒體"), detail: errorText(error) });
    } finally { end(); }
  }, [dispatch, engine.concat, notify, postRun, project.project_id]);

  return { busy, renderShots, renderVariants, renderVariantBatch, renderVariations, exportSequence, createProxy };
}
