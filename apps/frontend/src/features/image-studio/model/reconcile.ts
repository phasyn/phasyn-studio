// 讀回生成結果（純函式）：專案中狀態為 rendering 的 take 依它的 run 更新；批次中一張完成就先更新那一張。
// 送出時選了「完成後自動加入素材庫」的 take，成功後把白底版加進素材庫（素材 id 由 take id 決定，重複套用不會加兩次）。
// 只讀 run，不重送、不恢復任何工作。
import type { WireRun } from "@/api/types";
import type { ImageStudioProject, StudioImageTake } from "../types";
import { imageTakeOutcome } from "./outcome";
import { takeSnapshot } from "./params";
import type { ImageProjectAction } from "./project";
import { whiteLibraryItem } from "./sendToVideo";
import { imageShots } from "./shots";

/** take 的白底版在素材庫的 id（固定：同一個 take 不論在哪個分頁加入都是同一個項目）。 */
export function whiteItemId(take: Pick<StudioImageTake, "take_id">): string {
  return `imgw-${take.take_id}`.slice(0, 160);
}

export function reconcileImageActions(project: ImageStudioProject, run: WireRun, now: string): ImageProjectAction[] {
  const actions: ImageProjectAction[] = [];
  let library = project.library ?? [];
  for (const shot of imageShots(project)) {
    for (const take of shot.takes) {
      if (take.run_id !== run.run_id || take.state !== "rendering") continue;
      const outcome = imageTakeOutcome(run, take);
      if (outcome.state === "rendering") continue;
      actions.push({ type: "updateImageTake", runId: run.run_id, takeId: take.take_id, patch: outcome, activateOnSuccess: true });
      if (outcome.state !== "succeeded" || !takeSnapshot(take)?.auto_library) continue;
      const updated: StudioImageTake = { ...take, ...outcome };
      const result = whiteLibraryItem({ library }, shot, updated, whiteItemId(take), now);
      if (result.item && !result.existing) {
        actions.push({ type: "addLibraryItems", items: [result.item] });
        library = [...library, result.item];
      }
    }
  }
  return actions;
}
