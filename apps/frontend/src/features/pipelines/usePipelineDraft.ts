// The pipeline editor's draft: the working copy, its baseline (the last saved version; null for a new pipeline), stable
// keys for the step list and every edit. Edits are functional updates where two of them can happen in one event
// (for example "add an input of this type" and "wire the step to it").
import { useState } from "react";
import type { Port } from "@/api/generated/contracts";
import type { WirePipeline, WireStep } from "@/api/types";
import { localIdError, uniqueName } from "@/lib/ids";
import { cloneJson, valuesEqual } from "@/lib/json";
import { moveItem, useStableKeys } from "@/lib/useStableKeys";
import { addExport, removeStep, renameStep } from "./pipelineModel";
import { t } from "@/i18n";

export function usePipelineDraft(initial: WirePipeline, isNew: boolean) {
  const [baseline, setBaseline] = useState<WirePipeline | null>(isNew ? null : initial);
  const [draft, setDraft] = useState<WirePipeline>(() => cloneJson(initial));
  const stepKeys = useStableKeys(draft.steps.length);
  const dirty = baseline === null || !valuesEqual(baseline, draft);

  /** Adds a pipeline input shaped like `port` (unique name) and returns its name. */
  const addInputFor = (port: Port): string => {
    const name = uniqueName(port.name, new Set(draft.inputs.map((input) => input.name)));
    setDraft((previous) => ({
      ...previous,
      inputs: [...previous.inputs, { name, type_id: port.type_id, required: port.required, transport: port.transport, description: port.description || port.name }],
    }));
    return name;
  };

  const updateStep = (index: number, next: WireStep) =>
    setDraft((previous) => ({ ...previous, steps: previous.steps.map((item, position) => (position === index ? next : item)) }));

  /** Renames the step at `index`; returns why it cannot (invalid or duplicate id) or null. */
  const renameAt = (index: number, current: string, next: string): string | null => {
    const error = localIdError(next, "step_id ");
    if (error) return error;
    if (draft.steps.some((other, position) => position !== index && other.step_id === next)) return t("step_id 重複");
    setDraft(renameStep(draft, current, next));
    return null;
  };

  const moveAt = (index: number, to: number) => {
    stepKeys.move(index, to);
    setDraft({ ...draft, steps: moveItem(draft.steps, index, to) });
  };

  /** Removes the step at `index` and returns its id. */
  const removeAt = (index: number): string | undefined => {
    const removed = draft.steps[index];
    stepKeys.remove(index);
    setDraft(removeStep(draft, index));
    return removed?.step_id;
  };

  /** Appends an empty step and returns its id. */
  const addStep = (): string => {
    stepKeys.append();
    const stepId = uniqueName("step", new Set(draft.steps.map((step) => step.step_id)));
    setDraft({ ...draft, steps: [...draft.steps, { step_id: stepId, node_id: "", component_id: "", inputs: {}, parameters: {} }] });
    return stepId;
  };

  const exportPort = (stepId: string, port: Port) => setDraft((previous) => addExport(previous, stepId, port.name).pipeline);

  const discard = () => {
    if (baseline) setDraft(cloneJson(baseline));
  };

  const markSaved = (saved: WirePipeline) => {
    setBaseline(saved);
    setDraft(saved);
  };

  return { draft, setDraft, baseline, dirty, stepKeys, addInputFor, updateStep, renameAt, moveAt, removeAt, addStep, exportPort, discard, markSaved };
}

export type PipelineDraft = ReturnType<typeof usePipelineDraft>;
