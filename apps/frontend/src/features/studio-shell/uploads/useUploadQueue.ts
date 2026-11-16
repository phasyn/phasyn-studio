// Serial upload queue of a Studio page, scoped to one project: files are processed one at a time; leaving the project
// (or unmounting) aborts the uploads in flight, and a result that arrives for another project is not applied. A failed
// upload is never resent on its own — "retry" is the user's decision and makes a new file on the controller.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAbortError } from "@/lib/async";
import { t } from "@/i18n";

export type UploadState = "waiting" | "reading" | "uploading" | "done" | "failed";

export interface UploadTask<TInfo> {
  key: string;
  name: string;
  state: UploadState;
  /** What happened (done) or why it could not be processed; null while working or when `error` explains it. */
  message: string | null;
  error: unknown;
  scopeId: string;
  /** An accepted file (it can be uploaded again after a failure); false for a file refused before uploading. */
  retryable: boolean;
  info: TInfo;
}

/** Work for one accepted file: report the phase, return the message shown when done; throw to fail (an UploadProblem
 * shows its message; an abort error shows UPLOAD_ABORTED; anything else is shown as an error). */
export type UploadRun = (signal: AbortSignal, phase: (state: "reading" | "uploading") => void) => Promise<string>;

export type UploadRequest<TInfo> = { file: File; info: TInfo; run: UploadRun } | { file: File; info: TInfo; problem: string };

let counter = 0;
const nextKey = () => `upload-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

/** A file that cannot be processed for a known reason (for example a full library): shown as a message, not an error. */
export class UploadProblem extends Error {}

export const UPLOAD_ABORTED = t("已中止：上傳期間切換了專案或關閉了面板；主控可能已收到檔案，但沒有加入素材庫");

export function useUploadQueue<TInfo>(scopeId: string) {
  const [tasks, setTasks] = useState<UploadTask<TInfo>[]>([]);
  const runs = useRef(new Map<string, UploadRun>());
  const controllers = useRef(new Set<AbortController>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const scope = useRef(scopeId);

  useLayoutEffect(() => {
    scope.current = scopeId;
  });

  // Leaving the project or unmounting aborts the uploads in flight (the controller may already have the file)
  useEffect(() => {
    const owned = controllers.current;
    return () => {
      for (const controller of owned) controller.abort();
      owned.clear();
    };
  }, [scopeId]);

  const update = (key: string, patch: Partial<UploadTask<TInfo>>) => setTasks((list) => list.map((task) => (task.key === key ? { ...task, ...patch } : task)));

  const process = async (key: string, taskScope: string, run: UploadRun) => {
    if (scope.current !== taskScope) {
      update(key, { state: "failed", message: UPLOAD_ABORTED, error: null });
      return;
    }
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const message = await run(controller.signal, (state) => update(key, { state }));
      if (controller.signal.aborted || scope.current !== taskScope) {
        update(key, { state: "failed", message: UPLOAD_ABORTED, error: null });
        return;
      }
      runs.current.delete(key);
      update(key, { state: "done", message, error: null });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) update(key, { state: "failed", message: UPLOAD_ABORTED, error: null });
      else if (error instanceof UploadProblem) update(key, { state: "failed", message: error.message, error: null });
      else update(key, { state: "failed", message: null, error });
    } finally {
      controllers.current.delete(controller);
    }
  };

  const enqueue = (key: string, taskScope: string, run: UploadRun) => {
    queue.current = queue.current.then(() => process(key, taskScope, run));
  };

  return {
    /** This project's uploads (others are not shown). */
    tasks: tasks.filter((task) => task.scopeId === scopeId),
    add: (requests: readonly UploadRequest<TInfo>[]) => {
      const taskScope = scope.current;
      const added = requests.map((request): UploadTask<TInfo> => {
        const key = nextKey();
        if ("problem" in request) return { key, name: request.file.name, state: "failed", message: request.problem, error: null, scopeId: taskScope, retryable: false, info: request.info };
        runs.current.set(key, request.run);
        enqueue(key, taskScope, request.run);
        return { key, name: request.file.name, state: "waiting", message: null, error: null, scopeId: taskScope, retryable: true, info: request.info };
      });
      setTasks((existing) => [...existing.filter((task) => task.state !== "done"), ...added]);
    },
    /** Upload again after a failure (a new request: the controller stores a new file). */
    retry: (key: string) => {
      const run = runs.current.get(key);
      if (!run) return;
      update(key, { state: "waiting", error: null, message: null, scopeId: scope.current });
      enqueue(key, scope.current, run);
    },
    dismiss: (key: string) => {
      runs.current.delete(key);
      setTasks((existing) => existing.filter((task) => task.key !== key));
    },
  };
}
