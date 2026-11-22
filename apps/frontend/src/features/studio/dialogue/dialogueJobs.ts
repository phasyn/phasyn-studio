// The speech jobs a project has under way: transcriptions whose captions are applied when they finish, and dubbed lines
// that land on their audio track. They are kept per project in this browser (localStorage), so a job started before a
// reload or a panel switch still lands when the panel is shown again. The store is only a to-do list: the run itself is
// the truth, read from the Controller.
import { isRecord } from "@/lib/json";

interface JobBase {
  runId: string;
  /** What the panel says while it runs, e.g. 「鏡頭名・時間碼」 or the line's first words. */
  label: string;
  startedAt: number;
  /** Set when the job could not finish or its result could not be applied; the row stays until dismissed. */
  error?: string;
}

export interface TranscribeJob extends JobBase {
  kind: "transcribe";
  clipIds: string[];
  outputKey: string;
}

export interface SpeechJob extends JobBase {
  kind: "speech";
  captionId: string;
  trackId: string;
  at: number;
  outputKey: string;
}

export type DialogueJob = TranscribeJob | SpeechJob;

const MAX_JOBS = 60;
const listeners = new Set<() => void>();
const cache = new Map<string, readonly DialogueJob[]>();
const EMPTY: readonly DialogueJob[] = [];

const storageKey = (projectId: string) => `phasyn.studio.dialogue-jobs.${projectId}`;

function valid(value: unknown): value is DialogueJob {
  if (!isRecord(value) || typeof value["runId"] !== "string" || typeof value["label"] !== "string" || typeof value["startedAt"] !== "number") return false;
  if (value["kind"] === "transcribe") return Array.isArray(value["clipIds"]) && value["clipIds"].every((id) => typeof id === "string") && typeof value["outputKey"] === "string";
  return value["kind"] === "speech" && typeof value["captionId"] === "string" && typeof value["trackId"] === "string" &&
    typeof value["at"] === "number" && typeof value["outputKey"] === "string";
}

function read(projectId: string): readonly DialogueJob[] {
  const known = cache.get(projectId);
  if (known) return known;
  let jobs: readonly DialogueJob[] = EMPTY;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(projectId)) ?? "[]");
    if (Array.isArray(parsed)) jobs = parsed.filter(valid);
  } catch {
    jobs = EMPTY;
  }
  cache.set(projectId, jobs);
  return jobs;
}

function write(projectId: string, jobs: readonly DialogueJob[]): void {
  const kept = jobs.slice(-MAX_JOBS);
  cache.set(projectId, kept);
  try {
    if (kept.length === 0) window.localStorage.removeItem(storageKey(projectId));
    else window.localStorage.setItem(storageKey(projectId), JSON.stringify(kept));
  } catch {
    // Storage may be full or blocked: the jobs still work for this page's lifetime
  }
  for (const listener of listeners) listener();
}

export const dialogueJobs = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  list: read,
  add: (projectId: string, added: readonly DialogueJob[]): void => {
    const known = new Set(added.map((job) => job.runId));
    write(projectId, [...read(projectId).filter((job) => !known.has(job.runId)), ...added]);
  },
  fail: (projectId: string, runId: string, error: string): void => {
    write(projectId, read(projectId).map((job) => (job.runId === runId ? { ...job, error } : job)));
  },
  remove: (projectId: string, runIds: readonly string[]): void => {
    const gone = new Set(runIds);
    write(projectId, read(projectId).filter((job) => !gone.has(job.runId)));
  },
};
