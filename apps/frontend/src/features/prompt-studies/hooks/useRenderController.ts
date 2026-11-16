// The render-and-compare tab's screen state (seeds, variants, open task, selected image) and its controller.
import { useState } from "react";
import type { RenderController } from "../components/RenderTab";
import { INITIAL_RENDER_SEEDS, randomSeed, resolveRenderSeeds, type RenderSeedDraft } from "../model/seeds";
import { latestVersion, newTask } from "../model/study";
import type { GenerationSettings, PromptVariant, TaskComponents } from "../types";
import type { StudyDocument } from "./useStudyDocument";
import type { TaskRunner } from "./useTaskRunner";

export function useRenderController({
  doc,
  runner,
  settings,
  components,
  persistSettings,
}: {
  doc: StudyDocument;
  runner: TaskRunner;
  settings: GenerationSettings;
  components: TaskComponents;
  persistSettings: () => Record<string, unknown>;
}): RenderController {
  const study = doc.study;
  const busy = runner.state.busy;
  const [renderSeeds, setRenderSeeds] = useState<RenderSeedDraft>(INITIAL_RENDER_SEEDS);
  const [variants, setVariants] = useState<PromptVariant[]>(["core", "detailed"]);
  const [renderTaskId, setRenderTaskId] = useState<string | null>(null);
  const [renderRow, setRenderRow] = useState<string | null>(null);
  return {
    seeds: renderSeeds,
    setSeeds: setRenderSeeds,
    variants,
    setVariants,
    taskId: renderTaskId,
    setTaskId: (taskId) => {
      setRenderTaskId(taskId);
      setRenderRow(null);
    },
    rowId: renderRow,
    setRowId: setRenderRow,
    start: () => {
      const base = latestVersion(study);
      const seeds = resolveRenderSeeds(renderSeeds, randomSeed);
      if (!base || !seeds.ok || busy || variants.length === 0) return;
      const task = newTask({
        request: { kind: "render", variants, seeds: seeds.seeds, settings: { ...settings, components } },
        baseVersionId: base.version_id,
        now: new Date().toISOString(),
      });
      setRenderTaskId(task.task_id);
      setRenderRow(null);
      void runner.start(task, { mode: "loop", rounds: "all" }, persistSettings());
    },
  };
}
