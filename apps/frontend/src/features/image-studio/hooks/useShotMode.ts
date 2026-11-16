// 切換文生圖／圖生圖：目前的元件組合與新模式不符時，只有在「用同一個 DiT 元件」的對應元件組合剛好一個時才一起換
// （模型與精度不變），並以通知說明；否則保留原本的路由，由使用者在「基本」分頁自己選（不替使用者換模型）。
import { useCallback } from "react";
import { useImageStudio } from "../imageStudioContext";
import { variantLabel } from "../model/constants";
import { counterpartRoute, findImageRoute } from "../model/routes";
import type { ImageMode, StudioImageShot } from "../types";
import { t } from "@/i18n";

export function useSetMode(shot: StudioImageShot) {
  const { engine, dispatch, notify } = useImageStudio();
  return useCallback(
    (mode: ImageMode) => {
      if (mode === shot.mode) return;
      const current = findImageRoute(engine.routes, shot.route);
      const counterpart = counterpartRoute(engine.routes, current, mode);
      dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch: counterpart ? { mode, route: counterpart.id } : { mode } });
      if (counterpart) {
        notify({ tone: "info", title: t("運算路由改用「{label}」", { label: counterpart.label }), detail: t("同一個 DiT 元件（{variant}），只差在{value}。", { variant: variantLabel(counterpart.variant), value: mode === "i2i" ? t("加上參考圖的前處理與編碼") : t("不送參考圖") }) });
      }
    },
    [dispatch, engine.routes, notify, shot.image_shot_id, shot.mode, shot.route],
  );
}
