// The render this project waits for, told outside the page. While it runs, the tab title carries its progress
// (「約 38% — 專案」); when it ends, the title says how (「✓ 渲染完成 — 專案」) until the page has focus again and then
// gets its own title back, and when the page is not in focus a browser notification says it too. A render or an export
// that ends also plays its sound, in focus or not (renderSound.ts; the person can turn it off). Notifications need the
// permission the 渲染鏡頭 click asks for once (askRenderAlerts: a user gesture, never on page load); without it, or where
// the browser offers none (an insecure origin), nothing more happens. useRenderAlerts is mounted once, from the toolbar,
// and reads only the activity and the run cache the render tracker keeps fresh: it sends no request of its own.
import { useEffect, useRef, useState } from "react";
import { useCachedRun } from "@/api/runs";
import type { RunState } from "@/api/types";
import { createPersistentStore } from "@/lib/persistentStore";
import type { ActivityKind } from "../../model/renderActivity";
import { useRenderActivity } from "../../renderActivityContext";
import { useStudio } from "../../studioContext";
import { activitySubject, endText, tabProgress } from "./renderActivityView";
import { playRenderSound, unlockRenderSound, type RenderSound } from "./renderSound";
import { t } from "@/i18n";

/** Whether the permission was asked in this browser: a dismissed prompt is not shown again. */
const asked = createPersistentStore<boolean>({ key: "phasyn.studio.render-alerts-asked", initial: false, parse: (raw) => raw === true });

function notifications(): typeof Notification | null {
  return typeof window !== "undefined" && "Notification" in window ? window.Notification : null;
}

/** From the 渲染鏡頭 click: asks the browser, the first time only, whether this page may notify when a render ends. */
export function askRenderAlerts(): void {
  const api = notifications();
  if (api?.permission !== "default" || asked.get()) return;
  asked.set(true);
  // The answer is read when a render ends (Notification.permission); a refusal resolves as "denied", nothing to handle
  void api.requestPermission().catch(() => undefined);
}

/** A browser notification of the end of a run (only with permission and while the page is not in focus). */
function notifyEnd(title: string, body: string, runId: string): void {
  const api = notifications();
  if (api?.permission !== "granted" || document.hasFocus()) return;
  try {
    const note = new api(title, { body, tag: `phasyn-run-${runId}`, icon: "/brand/icon-192.png" });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // A browser that notifies only through a service worker refuses the constructor: the tab title still says it
  }
}

// The tab title is the document's, so its state lives once, here: what it was before this page changed it, what this
// page shows, and the listeners waiting to give it back.
const tab: { base: string | null; shown: string | null; release: (() => void) | null } = { base: null, shown: null, release: null };

function stopWaiting(): void {
  tab.release?.();
  tab.release = null;
}

function showTitle(text: string): void {
  stopWaiting();
  // The first time, or after someone else changed it: the current title is the one to come back to
  if (tab.shown === null || document.title !== tab.shown) tab.base = document.title;
  tab.shown = text;
  document.title = text;
}

function restoreTitle(): void {
  stopWaiting();
  // A title someone else set meanwhile stays
  if (tab.shown !== null && tab.base !== null && document.title === tab.shown) document.title = tab.base;
  tab.shown = null;
  tab.base = null;
}

/** Shows `text` until the page is visible and in focus again, then the page's own title. */
function showTitleUntilSeen(text: string): void {
  showTitle(text);
  const back = () => {
    if (document.visibilityState === "visible" && document.hasFocus()) restoreTitle();
  };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  tab.release = () => {
    window.removeEventListener("focus", back);
    document.removeEventListener("visibilitychange", back);
  };
}

/** The sound of an ended run: renders and exports only (proxies are background work); none for a cancelled one. */
function endSound(kind: ActivityKind, state: Exclude<RunState, "running">): RenderSound | null {
  if (kind === "proxy" || state === "cancelled") return null;
  return state === "succeeded" ? "done" : "problem";
}

/** A run this page saw running: watched until its end is read from the run cache (the activity is gone by then). */
interface Watched {
  runId: string;
  kind: ActivityKind;
  /** What it produces, for the notification (「批次 3 個鏡頭」). */
  subject: string;
}

export function useRenderAlerts(): void {
  const activity = useRenderActivity();
  const { project } = useStudio();
  const [watched, setWatched] = useState<Watched | null>(null);
  if (activity && activity.run.run_id !== watched?.runId) {
    setWatched({ runId: activity.run.run_id, kind: activity.kind, subject: activitySubject(activity) });
  }
  const run = useCachedRun(watched?.runId ?? null).data;
  const ended = watched !== null && run?.run_id === watched.runId && run.state !== "running" ? run.state : null;
  const progress = activity ? tabProgress(activity) : null;
  const projectTitle = project.title || t("未命名專案");
  const announcedRef = useRef<string | null>(null);

  useEffect(() => {
    if (progress !== null) showTitle(t("{status} — {title}", { status: progress, title: projectTitle }));
  }, [progress, projectTitle]);

  // The browser starts audio only after the page has been used: the first press prepares it for the end of a render
  useEffect(() => {
    const unlock = () => { unlockRenderSound(); };
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);

  // Once per run: its sound; a page in focus has seen it end (its own title comes back); otherwise the title and a
  // notification say it
  useEffect(() => {
    if (!watched || !ended || announcedRef.current === watched.runId) return;
    announcedRef.current = watched.runId;
    const sound = endSound(watched.kind, ended);
    if (sound) playRenderSound(sound);
    if (document.hasFocus()) {
      restoreTitle();
      return;
    }
    const outcome = endText(watched.kind, ended);
    showTitleUntilSeen(t("{status} — {title}", { status: outcome, title: projectTitle }));
    notifyEnd(outcome, t("{label}：{detail}", { label: projectTitle, detail: watched.subject }), watched.runId);
  }, [watched, ended, projectTitle]);

  // Leaving the project gives the tab its own title back
  useEffect(() => restoreTitle, []);
}
