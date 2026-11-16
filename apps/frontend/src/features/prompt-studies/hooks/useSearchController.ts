// The bounded search tab's screen state (search settings draft, open task, selected image) and its controller.
import { useState } from "react";
import type { SearchController } from "../components/SearchTab";
import { initialSearch } from "../model/initialState";
import { SEARCH_LIMITS, validateSearch, type SearchDraft } from "../model/search";
import { latestVersion, newTask } from "../model/study";
import type { GenerationSettings, PromptStudy, TaskComponents } from "../types";
import type { StudyDocument } from "./useStudyDocument";
import type { TaskRunner } from "./useTaskRunner";

export function useSearchController({
  initial,
  doc,
  runner,
  settings,
  components,
  persistSettings,
}: {
  initial: PromptStudy;
  doc: StudyDocument;
  runner: TaskRunner;
  settings: GenerationSettings;
  components: TaskComponents;
  persistSettings: () => Record<string, unknown>;
}): SearchController {
  const study = doc.study;
  const busy = runner.state.busy;
  const [searchDraft, setSearchDraft] = useState<SearchDraft>(() => initialSearch(initial));
  const [searchTaskId, setSearchTaskId] = useState<string | null>(null);
  const [searchRow, setSearchRow] = useState<string | null>(null);
  return {
    draft: searchDraft,
    setDraft: setSearchDraft,
    taskId: searchTaskId,
    setTaskId: (taskId) => {
      setSearchTaskId(taskId);
      setSearchRow(null);
    },
    rowId: searchRow,
    setRowId: setSearchRow,
    start: (mode, rounds) => {
      const base = latestVersion(study);
      const validation = validateSearch(searchDraft);
      if (!base || !validation.ok || busy) return;
      const plan = validation.plan;
      const task = newTask({
        request: {
          kind: "reconstruct",
          search_seeds: plan.searchSeeds,
          holdout_seeds: plan.holdoutSeeds,
          max_rounds: plan.rounds,
          max_images: plan.budget,
          max_vision_operations: SEARCH_LIMITS.maxVisionOps,
          stop_after_no_improvement: plan.stopAfter,
          settings: { ...settings, components },
        },
        baseVersionId: base.version_id,
        now: new Date().toISOString(),
      });
      setSearchTaskId(task.task_id);
      setSearchRow(null);
      void runner.start(task, { mode, rounds }, persistSettings());
    },
  };
}
