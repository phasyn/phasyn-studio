// 每個主要動作「為什麼還不能按」（純函式，畫面與測試共用）；可以時為 null。順序就是檢查的優先序。
import type { ComponentChoice } from "./components";
import { roleProblem } from "./components";
import type { SceneIssue } from "./scene";
import { latestVersion, openTask, taskStartBlock } from "./study";
import type { PromptStudy, PromptVariant } from "../types";
import type { ImageRoute } from "./routes";
import { settingsProblems } from "./routes";
import type { GenerationSettings } from "../types";
import { t } from "@/i18n";

interface Common {
  study: PromptStudy;
  busy: boolean;
}

export function analyzeBlock(input: Common & { vision: ComponentChoice | null; compile: ComponentChoice | null }): string | null {
  if (input.busy) return t("正在執行另一個步驟");
  if (input.study.versions.length > 0) return t("已經有版本：用「修訂場景」或直接編修");
  const start = taskStartBlock(input.study);
  if (start != null && start !== "") return start;
  return roleProblem("vision", input.vision) ?? roleProblem("compile", input.compile);
}

export function saveVersionBlock(input: Common & { changed: boolean; dirty: boolean; issues: readonly SceneIssue[]; compile: ComponentChoice | null }): string | null {
  if (input.study.archived) return t("研究已封存：取消封存後才能編修");
  if (input.busy) return t("正在執行另一個步驟");
  if (!input.dirty) return t("沒有修改");
  if (input.issues.length > 0) return t("場景有 {issuesCount} 個問題", { issuesCount: input.issues.length });
  return roleProblem("compile", input.compile);
}

export function refineBlock(input: Common & { dirty: boolean; isLatest: boolean; instruction: string; vision: ComponentChoice | null; compile: ComponentChoice | null }): string | null {
  if (input.busy) return t("正在執行另一個步驟");
  const start = taskStartBlock(input.study);
  if (start != null && start !== "") return start;
  if (input.dirty) return t("先儲存或還原目前的修改，再修訂");
  if (!input.isLatest) return t("只能修訂最新版本；歷史版本可以檢視與套用");
  if (!input.instruction.trim()) return t("請輸入修訂指示");
  if (input.instruction.length > 2000) return t("修訂指示最多 2000 字");
  return roleProblem("vision", input.vision) ?? roleProblem("compile", input.compile);
}

/** 生成比對與有界搜尋共用：生成用的元件組合、設定、視覺與評分元件。 */
export function generationBlock(input: Common & { route: ImageRoute | null; settings: GenerationSettings; vision: ComponentChoice | null; score: ComponentChoice | null }): string | null {
  if (input.busy) return t("正在執行另一個步驟");
  const start = taskStartBlock(input.study);
  if (start != null && start !== "") return start;
  if (!latestVersion(input.study)) return t("還沒有版本：先分析原圖");
  if (!input.route) return t("請選擇生成用的元件組合（t2i）");
  if (!input.route.ready) return t("元件組合不能用：{value}", { value: input.route.problems[0] ?? t("未就緒") });
  const problems = settingsProblems(input.settings);
  if (problems.length > 0) return problems[0] ?? null;
  return roleProblem("vision", input.vision) ?? roleProblem("score", input.score);
}

export function renderBlock(input: Parameters<typeof generationBlock>[0] & { seedProblem: string | null; variants: readonly PromptVariant[] }): string | null {
  const base = generationBlock(input);
  if (base != null && base !== "") return base;
  if (input.variants.length === 0) return t("至少選一種候選（core 或 detailed）");
  return input.seedProblem;
}

/** 已有未結束的任務時，「繼續」能不能按。 */
export function continueBlock(input: Common & { taskId: string | null }): string | null {
  if (input.busy) return t("正在執行");
  const open = openTask(input.study);
  if (open?.task_id !== input.taskId) return t("這個任務已經結束");
  if (input.study.archived) return t("研究已封存：取消封存後才能繼續");
  return null;
}
