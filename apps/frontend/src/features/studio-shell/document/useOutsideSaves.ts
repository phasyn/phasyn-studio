// Picks up a newer version of the open project saved elsewhere — another tab, the other Studio in another window, or an
// API client — while this page has nothing unsaved. The project list is read again every few
// seconds while the page is visible; a newer revision is loaded through the document's refresh, which the reducer takes
// only while nothing is unsaved (an edit made meanwhile keeps this page's version, and its save meets the conflict
// banner as before). Only reads: nothing is sent.
import { useEffect } from "react";
import { useStudioProjects } from "@/api/studioProjects";
import type { NoticeInput } from "../notices/useNotices";
import type { VersionedDoc } from "./docReducer";
import type { AutosaveDocument } from "./useAutosaveDocument";
import { t } from "@/i18n";

export const OUTSIDE_SAVES_POLL_MS = 10_000;

export function useOutsideSaves<TDoc extends VersionedDoc & { project_id: string }, TAction>(
  document: AutosaveDocument<TDoc, TAction>,
  notify: (notice: NoticeInput) => void,
  pollMs = OUTSIDE_SAVES_POLL_MS,
): void {
  const { state, refresh } = document;
  const { data } = useStudioProjects({ pollMs });
  const projectId = state.base.project_id;
  const serverRevision = data?.items.find((item) => item.project_id === projectId)?.revision ?? null;
  const baseRevision = state.base.revision;
  const status = state.status;
  useEffect(() => {
    if (serverRevision !== null && status === "saved" && serverRevision > baseRevision) void refresh(serverRevision);
  }, [serverRevision, status, baseRevision, refresh]);

  const refreshed = state.refreshedRevision;
  useEffect(() => {
    if (refreshed === null) return;
    notify({
      tone: "info",
      title: t("已載入在其他地方保存的新版本"),
      detail: t("另一個分頁或 AI 代理保存了這個專案（r{value}）；這裡沒有未保存的編輯，所以已換成新版本。", { value: refreshed }),
    });
  }, [refreshed, notify]);
}
