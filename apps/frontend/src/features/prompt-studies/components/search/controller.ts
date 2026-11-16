// The bounded search tab's controller (state owned by the study workspace) and the tasks it shows.
import type { SearchDraft } from "../../model/search";
import type { PromptStudyTask, PromptTaskRequest } from "../../types";
import type { Workspace } from "../workspace";

export type ReconstructRequest = Extract<PromptTaskRequest, { kind: "reconstruct" }>;

export interface SearchController {
  draft: SearchDraft;
  setDraft: (draft: SearchDraft) => void;
  taskId: string | null;
  setTaskId: (taskId: string) => void;
  /** 選擇的圖片（生成 run id）。 */
  rowId: string | null;
  setRowId: (rowId: string) => void;
  start: (mode: "step" | "loop", rounds: number | "all") => void;
}

export function searchTasks(ws: Workspace): PromptStudyTask[] {
  return ws.study.tasks.filter((task) => task.kind === "reconstruct").reverse();
}
