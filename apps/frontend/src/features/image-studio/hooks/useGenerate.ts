// 生成一張圖片（工具列的「生成圖片」與屬性面板的 Ctrl+Enter 共用同一個函式與同一個送出中狀態）：圖生圖有未保存的遮罩時
// 先上傳（只送一次；失敗就不生成，草稿保留），再規劃一個 run——批次 N 張共用一個文字條件，DiT 以下各一份
// （planImageRender），take id 在送出前決定。另一個 run 還在執行、元件組合讀不到或未就緒、路由不存在或參數不合法時不送出
// （以通知說明），也不換成別的路由；每個 run 只送一次，送出中再按不做事。
import { useCallback, useRef, useState, type RefObject } from "react";
import { isApiError } from "@/api/http";
import { useCreateRun } from "@/api/runs";
import { engineUnavailable } from "@/features/studio";
import type { NoticeInput } from "@/features/studio-shell";
import type { ImageEngine } from "../imageStudioContext";
import { planImageRender } from "../model/plan";
import { imageProjectReducer, type ImageProjectAction } from "../model/project";
import { findImageRoute } from "../model/routes";
import { imageShots, localId } from "../model/shots";
import { errorText } from "../support";
import type { ImageStudioProject, StudioImageShot, StudioImageTake } from "../types";
import { uploadMaskDraft } from "./maskDrafts";
import { t } from "@/i18n";

export interface GenerateOptions {
  engine: ImageEngine;
  /** 最新的草稿（送出前讀，不用可能過時的 render 值）。 */
  projectRef: RefObject<ImageStudioProject>;
  dispatch: (action: ImageProjectAction) => void;
  notify: (notice: NoticeInput) => void;
  autoLibrary: boolean;
  /** 主控上還有 run 在執行時的原因；有值時不送出。 */
  runBlockedReason: string | null;
  /** Records why an image's generation was not sent (null clears it once one starts). */
  markNotSent: (shotId: string, reason: string | null) => void;
  /** 送出成功：監看這張圖片的第一個新 take。 */
  onStarted: (shotId: string, takeId: string | null) => void;
}

export function useGenerate({ engine, projectRef, dispatch, notify, autoLibrary, runBlockedReason, markNotSent, onStarted }: GenerateOptions) {
  const { mutateAsync: postRun } = useCreateRun();
  const [busy, setBusy] = useState(false);
  /** Read synchronously so a second click during a submission sends nothing. */
  const busyRef = useRef(false);

  /** 圖生圖有未保存的遮罩時先上傳；回傳要套用的動作，失敗時 false（已通知）。 */
  const uploadMask = useCallback(
    async (shot: StudioImageShot): Promise<ImageProjectAction | null | false> => {
      if (shot.mode !== "i2i") return null;
      try {
        return await uploadMaskDraft(shot);
      } catch (error) {
        notify({ tone: "danger", title: t("遮罩上傳失敗，沒有生成"), detail: t("{error}（遮罩草稿保留，可以再試一次）", { error: errorText(error) }) });
        return false;
      }
    },
    [notify],
  );

  const generate = useCallback(
    async (shotId: string) => {
      if (busyRef.current) return;
      if (runBlockedReason) {
        markNotSent(shotId, runBlockedReason);
        notify({ tone: "warning", title: t("沒有送出：目前有其他 run 正在執行"), detail: runBlockedReason });
        return;
      }
      const unavailable = engineUnavailable(engine);
      if (unavailable) {
        notify({ tone: "warning", title: t("生成引擎還不能判斷"), detail: unavailable, link: { label: t("開啟生成引擎"), to: "#engine" } });
        return;
      }
      const target = imageShots(projectRef.current).find((item) => item.image_shot_id === shotId);
      if (!target) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const mask = await uploadMask(target);
        if (mask === false) return;
        let doc = projectRef.current;
        if (mask) {
          doc = imageProjectReducer(doc, mask);
          dispatch(mask);
        }
        const shot = imageShots(doc).find((item) => item.image_shot_id === shotId);
        if (!shot) return;
        const takeIds = Array.from({ length: Math.max(1, Math.min(8, Math.trunc(shot.batch) || 1)) }, () => localId("t"));
        const { plan, problem } = planImageRender(doc, shot, takeIds, { routes: engine.routes, autoLibrary });
        if (!plan) {
          // Only a problem with the route's components has its fix in the engine sheet
          const route = findImageRoute(engine.routes, shot.route);
          notify({ tone: "warning", title: t("無法生成"), detail: problem, link: route !== null && !route.ready ? { label: t("開啟生成引擎"), to: "#engine" } : undefined });
          return;
        }
        const run = await postRun(plan.body);
        const takes: StudioImageTake[] = plan.branches.map((branch, index) => ({
          take_id: takeIds[index] ?? localId("t"),
          run_id: run.run_id,
          created_at: run.created_at,
          state: "rendering",
          seed: branch.seed,
          image: null,
          image_white: null,
          library_item_id: null,
          timings_ms: {},
          error: null,
          params_snapshot: branch.snapshot as unknown as Record<string, unknown>,
        }));
        dispatch({ type: "addImageTakes", shotId, takes });
        markNotSent(shotId, null);
        onStarted(shotId, takes[0]?.take_id ?? null);
        notify({
          tone: "info",
          title: takes.length > 1 ? t("開始生成「{title}」{takesCount} 張", { title: shot.title, takesCount: takes.length }) : t("開始生成「{title}」", { title: shot.title }),
          detail: plan.notes.length > 0 ? plan.notes.join(t("；")) : undefined,
        });
      } catch (error) {
        const active = isApiError(error) && error.code === "RUN_ACTIVE";
        markNotSent(shotId, active ? t("主控的同時執行數已滿，這次沒有送出；等其中一個 run 結束後再按一次。") : errorText(error));
        notify({
          tone: "danger",
          title: active ? t("沒有送出：目前有其他 run 正在執行") : t("無法開始生成"),
          detail: active ? t("主控的同時執行數已滿；等其中一個 run 結束或取消後再試。") : errorText(error),
          link: active ? { label: t("查看執行紀錄"), to: "/records/runs" } : undefined,
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [autoLibrary, dispatch, engine, markNotSent, notify, onStarted, postRun, projectRef, runBlockedReason, uploadMask],
  );

  return { busy, generate };
}
