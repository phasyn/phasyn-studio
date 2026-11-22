// 生成中的 take 現在在做什麼（純函式）：依這張圖的階段（outcome.ts takeStages）、中間預覽的步數與
// recorder 的逐步紀錄（影片 Studio 的 DiT 進度模型 summarizeDit）。只顯示有證據的數字：預覽給的是「第幾步」，
// 不推估剩餘時間；逐步紀錄的推估由 summarizeDit 標明來源。
import type { DitProgress } from "@/features/studio";
import type { RunStepPreview } from "../types";
import type { TakeStage } from "./outcome";
import { t } from "@/i18n";

const WAITING: ReadonlySet<string> = new Set(["pending", "waiting", "unknown"]);

export interface TakeActivity {
  /** 一行說明，例如「DiT 第 12／40 步」「VAE 解碼中」「等待資源」。 */
  text: string;
  /** 已完成的階段數／全部階段數。 */
  done: number;
  total: number;
  /** DiT 步數進度（0–1）；沒有證據時 null。 */
  fraction: number | null;
}

export function takeActivity(stages: readonly TakeStage[], preview: Pick<RunStepPreview, "step" | "total"> | null, dit: DitProgress | null): TakeActivity {
  const done = stages.filter((stage) => stage.state === "succeeded" || stage.state === "skipped").length;
  const total = stages.length;
  const running = stages.find((stage) => stage.state === "running");
  let fraction: number | null = null;
  let text = "";
  if (running?.role === "dit") {
    if (preview && preview.total > 0) {
      fraction = Math.min(1, Math.max(0, preview.step / preview.total));
      text = t("DiT 第 {step}／{total} 步（預覽）", { step: preview.step, total: preview.total });
    } else if (dit?.total != null && dit.completed !== null) {
      fraction = dit.fraction;
      text = dit.current !== null ? t("DiT 第 {current}／{total} 步", { current: dit.current, total: dit.total }) : dit.loopDone ? t("DiT {total}／{total2} 步・收尾中", { total: dit.total, total2: dit.total }) : t("DiT 已完成 {completed}／{total} 步", { completed: dit.completed, total: dit.total });
    } else {
      text = (dit?.total != null && Boolean(dit.total)) ? t("DiT 去噪中・共 {total} 步", { total: dit.total }) : t("DiT 去噪中");
    }
  } else if (running) {
    text = t("{label}執行中", { label: running.label });
  } else if (stages.some((stage) => stage.state === "waiting")) {
    text = t("等待資源（同一張卡的其他步驟執行中）");
  } else if (stages.length > 0 && stages.every((stage) => WAITING.has(stage.state))) {
    text = t("排隊中");
  }
  return { text, done, total, fraction };
}
