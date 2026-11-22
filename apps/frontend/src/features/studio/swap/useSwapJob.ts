// 換角專案的工作：由專案推導進度（重新整理後一樣），全部段落完成後自動匯出一次（嘗試過就寫回工作設定，之後只能手動），
// 手動匯出（與時間軸的「匯出序列…」同一個請求）、繼續渲染剩下的段落（一次最多一個 run 放得下的段數）、單段重新渲染
// （既有的 renderShots）。取消渲染中的 run 由共用的確認對話框（CancelRunDialog）處理。每個按鈕不能用時都有原因。
// 讀取 run 的進度由 Studio 的 render tracker 負責（它輪詢專案中所有 rendering 的 take 與匯出）；這個 hook 掛在工具列（一直掛載），
// 對話框關著也會自動匯出。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { useCreateRun } from "@/api/runs";
import { useStudioShell } from "@/features/studio-shell";
import { exportTarget, prepareTimelineExport, sequenceExport, type SequenceExport } from "../editor/export";
import { localId } from "../model/project";
import { planRender } from "../model/renderPlan";
import { engineUnavailable, findRoute } from "../model/routes";
import { useStudio } from "../studioContext";
import { errorText } from "./errors";
import { libraryWithJob, shouldAutoExport, swapProgress, type SwapProgress, type SwapProjectInfo } from "./job";
import { nextBatch, swapBatchSize, type BatchSize } from "./batchSize";
import { segmentsPerRun } from "./limits";
import { t } from "@/i18n";

export interface SwapJobApi {
  progress: SwapProgress | null;
  /** 下一批「渲染剩下的段落」會送出的鏡頭（每批段數與一個 run 的步驟上限內）。 */
  batch: string[];
  /** 每批段數（這個瀏覽器記住；null＝一個 run 放得下的全部）。 */
  batchSize: BatchSize;
  setBatchSize: (size: BatchSize) => void;
  /** 不能「渲染剩下的段落」的原因；可以時為 null。 */
  renderReason: string | null;
  /** The finished segments whose settings changed since their take, in film order (「重新渲染設定已改的段落」 lists them to choose from). */
  stale: string[];
  /** Why the changed segments cannot be rendered now (their first batch); null when they can. */
  staleReason: string | null;
  /** The batch some of them make (the batch size of 「渲染下一批」 and what one run holds for their routes). */
  staleBatchOf: (ids: string[]) => string[];
  /** Why a batch cannot be sent now (the same checks as sending it); null when it can. */
  batchReason: (ids: string[]) => string | null;
  /** 不能匯出的原因；可以時為 null。 */
  exportReason: string | null;
  /** 匯出請求的預覽（幀數、提醒）；不是換角專案時 null。 */
  exportPreview: SequenceExport | null;
  exporting: boolean;
  /** 單段重新渲染不能用的原因；可以時為 null。 */
  retryReason: (shot: StudioShot) => string | null;
  exportNow: () => void;
  renderRemaining: () => void;
  /** Renders the given changed segments as one run (a batch from staleBatchOf). */
  renderStale: (ids: string[]) => void;
  retrySegment: (shotId: string) => void;
}

export function useSwapJob(info: SwapProjectInfo | null): SwapJobApi {
  const { project, engine, catalog, plugins, dispatch, renderShots, runBlockedReason, notify, busy } = useStudio();
  const { doc } = useStudioShell();
  const { mutateAsync: postRun } = useCreateRun();
  const progress = useMemo(() => (info ? swapProgress(project, info) : null), [info, project]);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  /** 這個分頁已經嘗試過自動匯出的專案（工作設定寫回之前，避免同一個畫面重複送出）。 */
  const autoTriedRef = useRef<string | null>(null);
  const busyReason = busy === "render" ? t("正在送出渲染請求") : busy === "export" ? t("正在送出匯出請求") : null;
  const unavailable = engineUnavailable(engine);

  const concat = engine.concat.component;
  const exportPreview = useMemo(
    () => (info && concat ? sequenceExport(project, exportTarget(concat)) : null),
    [info, project, concat],
  );

  // 一個 run 最多放幾段取決於段落的元件組合（每段複製一份步驟）：上限由要分批的那些段落決定，步驟最多的為準
  const perRunByShot = useMemo(() => new Map(project.shots.map((shot) => [shot.shot_id, segmentsPerRun(findRoute(engine.routes, shot.route))])), [engine.routes, project.shots]);
  const batchSize = swapBatchSize.use();
  const batchOf = useCallback(
    (ids: readonly string[]) => {
      const known = ids.flatMap((id) => perRunByShot.get(id) ?? []);
      return nextBatch(ids, known.length > 0 ? Math.min(...known) : null, batchSize);
    },
    [batchSize, perRunByShot],
  );
  const batch = useMemo(() => batchOf(progress?.remaining ?? []), [batchOf, progress]);

  // Segments rendered before their prompt, references or settings changed: 「重新渲染設定已改的段落」 batches the chosen ones
  const stale = useMemo(() => (progress?.segments ?? []).filter((segment) => segment.state === "stale").map((segment) => segment.shot.shot_id), [progress]);

  // 送出前與實際送出同一套檢查（planRender，不抽 seed、不送出）
  const batchReason = useCallback(
    (ids: string[]): string | null => {
      if (!progress) return t("這個專案不是一鍵換角建立的");
      if (progress.counts.rendering > 0) return t("還有段落在渲染：等它完成或取消後再送");
      if (ids.length === 0) return t("沒有要渲染的段落");
      const block = runBlockedReason ?? busyReason ?? unavailable;
      if (block != null && block !== "") return block;
      const shots = ids.flatMap((id) => project.shots.filter((shot) => shot.shot_id === id));
      const empty = shots.find((shot) => !shot.prompt.trim());
      if (empty) return t("「{title}」沒有 prompt", { title: empty.title });
      return planRender(project, shots, shots.map(() => "preflight"), { routes: engine.routes, catalog, plugins, randomSeed: () => 0 }).problem;
    },
    [busyReason, catalog, engine.routes, plugins, progress, project, runBlockedReason, unavailable],
  );
  const renderReason = useMemo(() => batchReason(batch), [batch, batchReason]);
  const staleReason = useMemo(() => batchReason(batchOf(stale)), [batchOf, batchReason, stale]);

  const exportReason = useMemo(() => {
    if (!progress || !info) return t("這個專案不是一鍵換角建立的");
    if (progress.counts.rendering > 0) return t("還有段落在渲染：全部完成後才能匯出");
    const missing = progress.segments.length - progress.playable;
    if (missing > 0) return t("還有 {missing} 段沒有可用的 take：先渲染完成", { missing });
    if (progress.phase === "exporting") return t("正在匯出");
    const block = runBlockedReason ?? busyReason ?? (exporting ? t("正在送出匯出請求") : null);
    if (block != null && block !== "") return block;
    if (!engine.concat.usable || !concat) return engine.concat.reason ?? t("序列匯出元件（media.concat）無法使用");
    if (exportPreview && exportPreview.problems.length > 0) return exportPreview.problems.join(t("；"));
    return null;
  }, [busyReason, concat, engine.concat, exportPreview, exporting, info, progress, runBlockedReason]);

  const exportNow = useCallback(
    async (auto: boolean) => {
      if (!info || exportingRef.current) return;
      const component = engine.concat.component;
      if (!engine.concat.usable || !component) {
        notify({ tone: "warning", title: t("序列匯出元件無法使用"), ...(engine.concat.reason == null ? {} : { detail: engine.concat.reason }), link: { label: t("開啟渲染引擎"), to: "#engine" } });
        return;
      }
      exportingRef.current = true;
      setExporting(true);
      try {
        // The same request as the export dialog's (one timeline, one path, one result)
        const captured = await prepareTimelineExport(project);
        const result = sequenceExport(captured, exportTarget(component));
        if (!result.body) {
          notify({ tone: "warning", title: t("還不能匯出"), detail: result.problems.join(t("；")) });
          return;
        }
        const run = await postRun(result.body);
        dispatch({
          type: "addExport",
          record: { export_id: localId("x"), run_id: run.run_id, created_at: run.created_at, state: "rendering", shot_ids: result.shotIds, asset: null, error: null, frames: null },
        });
        notify({
          tone: "info",
          title: auto ? t("全部段落完成，開始匯出") : t("已開始匯出"),
          detail: t("{clips} 個片段・{value}", { clips: result.clips, value: info.job.audio === "original" ? t("原影片音軌") : t("生成的聲音") }),
          link: { label: t("查看匯出進度"), to: `/studio/render?project=${encodeURIComponent(project.project_id)}&run=${encodeURIComponent(run.run_id)}` },
        });
      } catch (error) {
        notify({ tone: "danger", title: auto ? t("自動匯出沒有開始") : t("無法開始匯出"), detail: `${errorText(error)}${auto ? t("；不會自動重試，在「一鍵換角」按「匯出」") : ""}` });
      } finally {
        exportingRef.current = false;
        setExporting(false);
      }
    },
    [dispatch, engine.concat, info, notify, postRun, project],
  );

  // 全部段落完成 → 自動匯出一次。先把「已嘗試」寫回工作設定（隨自動保存），不論成敗都不會再自動送出。
  useEffect(() => {
    if (!info || !progress || !shouldAutoExport(project, info, progress)) return;
    if ((runBlockedReason ?? "") || busy || exportingRef.current || doc.status === "conflict" || doc.status === "error" || !engine.concat.usable) return;
    if (autoTriedRef.current === project.project_id) return;
    autoTriedRef.current = project.project_id;
    dispatch({ type: "setLibrary", library: libraryWithJob(project.library ?? [], info.source.item_id, { auto_export: false }) });
    void exportNow(true);
  }, [busy, dispatch, doc.status, engine.concat.usable, exportNow, info, progress, project, runBlockedReason]);

  const retryReason = useCallback(
    (shot: StudioShot): string | null => {
      if (shot.takes.some((take) => take.state === "rendering")) return t("這段正在渲染");
      const block = runBlockedReason ?? busyReason ?? unavailable;
      if (block != null && block !== "") return block;
      if (!shot.prompt.trim()) return t("這段沒有 prompt");
      return planRender(project, [shot], ["preflight"], { routes: engine.routes, catalog, plugins, randomSeed: () => 0 }).problem;
    },
    [busyReason, catalog, engine.routes, plugins, project, runBlockedReason, unavailable],
  );

  return {
    progress,
    batch,
    batchSize,
    setBatchSize: (size: BatchSize) => { swapBatchSize.set(size); },
    renderReason,
    stale,
    staleReason,
    exportReason,
    exportPreview,
    exporting,
    retryReason,
    exportNow: () => void exportNow(false),
    renderRemaining: () => void renderShots(batch),
    staleBatchOf: batchOf,
    batchReason,
    renderStale: (ids: string[]) => void renderShots(ids),
    retrySegment: (shotId: string) => void renderShots([shotId]),
  };
}
