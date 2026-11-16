// task.message (contract PromptStudyTask.message: a string of at most 2000 characters) keeps a small JSON note instead of
// finished text, so a study reads in its viewer's language, not in the language of whoever ran it: the step a run was
// created for, the error code of the step that failed, or why the task finished. Text that is not such a note (written
// by another tool or edited by hand) is shown as it is; reading never throws. Pure.
import type { CandidateRef, EvaluationSplit, PromptStudy, PromptVariant } from "../types";
import { VARIANTS } from "../types";
import { isRecord } from "@/lib/json";
import type { StepAction } from "./planner";
import { describeStepData, FINISH_REASONS, finishText, STEP_ACTIONS, type FinishNote, type StepData, type StepSpec } from "./stepText";
import { t } from "@/i18n";

export type TaskNote = { kind: "step"; step: StepData } | { kind: "failed"; code: string } | { kind: "finish"; finish: FinishNote };

/** Marks the JSON as one of these notes (and its version). */
const FORMAT = "phasyn.prompt-study.task-note/1";
const SPLITS: readonly EvaluationSplit[] = ["search", "holdout", "manual"];

export function encodeTaskNote(note: TaskNote): string {
  return JSON.stringify({ format: FORMAT, ...note });
}

const isInt = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function readSpec(value: unknown): StepSpec | null {
  if (!isRecord(value)) return null;
  const { split, round, versionId, variant, seed } = value;
  if (!oneOf(SPLITS, split) || !isInt(round) || !isText(versionId) || !oneOf<PromptVariant>(VARIANTS, variant) || !isInt(seed)) return null;
  return { split, round, versionId, variant, seed };
}

function readCandidate(value: unknown): CandidateRef | null {
  if (!isRecord(value) || !isText(value.version_id) || !oneOf<PromptVariant>(VARIANTS, value.variant)) return null;
  return { version_id: value.version_id, variant: value.variant };
}

function readStep(value: unknown): StepData | null {
  if (!isRecord(value) || !oneOf<StepAction>(STEP_ACTIONS, value.action)) return null;
  const action = value.action;
  switch (value.kind) {
    case "analyze":
      return { kind: "analyze", action };
    case "revise":
      if ((value.round !== null && !isInt(value.round)) || !isText(value.fromVersionId) || typeof value.comparison !== "boolean") return null;
      return { kind: "revise", action, round: value.round, fromVersionId: value.fromVersionId, comparison: value.comparison };
    case "render":
    case "compare": {
      const spec = readSpec(value.spec);
      return spec ? { kind: value.kind, action, spec } : null;
    }
    case "pairwise": {
      const incumbent = readCandidate(value.incumbent);
      const challenger = readCandidate(value.challenger);
      if (!incumbent || !challenger || !isInt(value.round) || !isInt(value.seed)) return null;
      return { kind: "pairwise", action, round: value.round, seed: value.seed, incumbent, challenger };
    }
    default:
      return null;
  }
}

function readFinish(value: unknown): FinishNote | null {
  if (!isRecord(value) || !oneOf(FINISH_REASONS, value.reason)) return null;
  const reason = value.reason;
  if (reason === "image_budget" || reason === "vision_budget") {
    return isInt(value.used) && isInt(value.max) ? { reason, used: value.used, max: value.max } : null;
  }
  return { reason };
}

/** The note `message` holds, or null when it is anything else. */
export function readTaskNote(message: string): TaskNote | null {
  if (!message.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== FORMAT) return null;
  switch (value.kind) {
    case "step": {
      const step = readStep(value.step);
      return step ? { kind: "step", step } : null;
    }
    case "failed":
      return isText(value.code) ? { kind: "failed", code: value.code } : null;
    case "finish": {
      const finish = readFinish(value.finish);
      return finish ? { kind: "finish", finish } : null;
    }
    default:
      return null;
  }
}

/** task.message for people, in the current language; text that is not a note is shown as it is. */
export function taskNoteText(study: PromptStudy, message: string): string {
  const note = readTaskNote(message);
  if (!note) return message;
  switch (note.kind) {
    case "step":
      return describeStepData(study, note.step);
    case "failed":
      return t("上一步失敗：{code}", { code: note.code });
    case "finish":
      return finishText(note.finish);
  }
}
