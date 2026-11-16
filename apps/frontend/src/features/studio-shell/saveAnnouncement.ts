// What the save indicator says to assistive technology: only the changes that matter — a save failed, or saving works
// again after a failure or a conflict. The routine cycle while typing (unsaved → saving → saved) is not announced, and
// a conflict is announced by the conflict banner itself (role="alert").
import type { SaveStatus } from "./document/docReducer";
import { t } from "@/i18n";

export interface AnnouncementState {
  /** The last status seen. */
  status: SaveStatus;
  /** A failure or a conflict happened since the last time saving worked. */
  troubled: boolean;
  /** The current announcement (empty = nothing to say). */
  message: string;
}

export function initialAnnouncement(status: SaveStatus): AnnouncementState {
  return { status, troubled: status === "error" || status === "conflict", message: "" };
}

/** The next state for a new status (the same object when nothing changes). */
export function nextAnnouncement(state: AnnouncementState, status: SaveStatus): AnnouncementState {
  if (status === state.status) return state;
  if (status === "error") return { status, troubled: true, message: t("儲存失敗") };
  if (status === "conflict") return { status, troubled: true, message: state.message };
  if (status === "saved" && state.troubled) return { status, troubled: false, message: t("已儲存") };
  // Trying again clears the live text, so the next failure changes it and is announced again
  if (status === "dirty" || status === "saving") return { ...state, status, message: "" };
  return { ...state, status };
}
