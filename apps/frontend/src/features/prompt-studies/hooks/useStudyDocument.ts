// 研究文件的唯一狀態 owner：每次修改都以「最新已保存的文件」為基礎套用（依序排隊，不會互相覆寫），
// 立即 PUT（revision 樂觀並行）。409 時停止所有後續保存，由使用者選「重新載入」；其他失敗回報給呼叫端（不自動重送）。
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError } from "@/api/http";
import { fetchStudy, publishStudy, saveStudy } from "../api";
import type { PromptStudy } from "../types";
import { t } from "@/i18n";

export type SaveState = "saved" | "saving" | "error" | "conflict";

export class StudyConflictError extends Error {
  constructor() {
    super(t("研究已在其他地方更新：先重新載入，這次的修改沒有保存"));
    this.name = "StudyConflictError";
  }
}

export interface StudyDocument {
  study: PromptStudy;
  saveState: SaveState;
  saveError: unknown;
  /** 以最新文件套用修改並保存；回傳保存後的文件（失敗時丟出錯誤，文件維持上一次保存的內容）。 */
  update: (change: (study: PromptStudy) => PromptStudy) => Promise<PromptStudy>;
  /** 目前最新的文件（事件處理器與非同步流程用；畫面用 study）。 */
  latest: () => PromptStudy;
  /** 丟棄本機狀態，讀伺服器最新版本（衝突時）。 */
  reload: () => Promise<void>;
}

export function useStudyDocument(initial: PromptStudy): StudyDocument {
  const client = useQueryClient();
  const [study, setStudy] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<unknown>(null);
  const latestRef = useRef(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const conflicted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback(
    (change: (current: PromptStudy) => PromptStudy): Promise<PromptStudy> => {
      const job = queue.current.then(async () => {
        if (conflicted.current) throw new StudyConflictError();
        const base = latestRef.current;
        const next = change(base);
        if (next === base) return base;
        if (mounted.current) setSaveState("saving");
        try {
          const saved = await saveStudy({ ...next, revision: base.revision });
          latestRef.current = saved;
          publishStudy(client, saved);
          if (mounted.current) {
            setStudy(saved);
            setSaveState("saved");
            setSaveError(null);
          }
          return saved;
        } catch (error) {
          if (isApiError(error) && error.code === "REVISION_CONFLICT") conflicted.current = true;
          if (mounted.current) {
            setSaveState(conflicted.current ? "conflict" : "error");
            setSaveError(error);
          }
          throw error;
        }
      });
      queue.current = job.catch(() => undefined);
      return job;
    },
    [client],
  );

  const reload = useCallback(async () => {
    const fresh = await fetchStudy(latestRef.current.study_id);
    conflicted.current = false;
    latestRef.current = fresh;
    publishStudy(client, fresh);
    if (mounted.current) {
      setStudy(fresh);
      setSaveState("saved");
      setSaveError(null);
    }
  }, [client]);

  const latest = useCallback(() => latestRef.current, []);

  return { study, saveState, saveError, update, latest, reload };
}
