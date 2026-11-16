// Notifications of a Studio page: newest last in state, at most four kept. Success and info close on their own, and so
// does a warning that asks for nothing (no link), a little later (the timer lives in NoticeItem and pauses on hover or
// focus); a warning with an action to take and errors stay until dismissed. When a fifth arrives, the oldest notice
// that closes on its own goes first: one that stays is dropped only when nothing else can go (the newest notice always
// stays).
import { useCallback, useRef, useState } from "react";

export interface Notice {
  id: number;
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  detail?: string;
  /** `to: "#engine"` opens the engine sheet instead of navigating. */
  link?: { label: string; to: string };
  /** Auto-close delay (ms); absent = closed by the user. */
  timeoutMs?: number;
}

export type NoticeInput = Omit<Notice, "id" | "timeoutMs">;

const MAX_NOTICES = 4;
const AUTO_CLOSE_MS = 6000;
/** A warning without an action (for example a refused edit) stays a little longer than an info. */
const WARNING_CLOSE_MS = 10000;

/** How long a notice stays before it closes on its own; undefined = until the user closes it. */
function autoCloseMs(notice: NoticeInput): number | undefined {
  if (notice.tone === "success" || notice.tone === "info") return AUTO_CLOSE_MS;
  if (notice.tone === "warning" && !notice.link) return WARNING_CLOSE_MS;
  return undefined;
}

/** Keeps at most `max` notices: drops the oldest one that closes on its own first, else the oldest; never the newest. */
export function trimNotices(items: readonly Notice[], max = MAX_NOTICES): Notice[] {
  const out = [...items];
  while (out.length > max) {
    const older = out.slice(0, -1);
    const auto = older.findIndex((item) => item.timeoutMs !== undefined);
    out.splice(auto >= 0 ? auto : 0, 1);
  }
  return out;
}

export function useNotices(): { notices: Notice[]; notify: (notice: NoticeInput) => void; dismiss: (id: number) => void } {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const notify = useCallback((notice: NoticeInput) => {
    const id = nextId.current++;
    const timeoutMs = autoCloseMs(notice);
    setNotices((items) => trimNotices([...items, { ...notice, id, timeoutMs }]));
  }, []);
  const dismiss = useCallback((id: number) => setNotices((items) => items.filter((item) => item.id !== id)), []);
  return { notices, notify, dismiss };
}
