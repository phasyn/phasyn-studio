// The wizard's segment pictures: a frame of the original read in this browser when its row scrolls into view
// (frameSampler). One read at a time; the waiting pictures of one file share one video element. Pictures are kept by
// file and time while the page lives (a failed one is not retried); leaving the plan step cancels what still waits.
import { useEffect, useSyncExternalStore } from "react";
import { readVideo } from "./frameSampler";
import { snapshotStore } from "./snapshotStore";

export type ThumbState = { status: "loading" } | { status: "ready"; src: string } | { status: "failed"; reason: string };

/** Width the pictures are read at: twice the widest shown (sharp on a 2× screen). */
const THUMB_WIDTH = 288;
const THUMB_LIMIT = 240;

interface ThumbRequest {
  key: string;
  url: string;
  seconds: number;
}

const store = snapshotStore<ThumbState>(THUMB_LIMIT);
let waiting: ThumbRequest[] = [];
let running: AbortController | null = null;

const keyOf = (url: string, seconds: number) => `${url}@${seconds.toFixed(3)}`;

async function pump(): Promise<void> {
  if (running) return;
  const next = waiting[0];
  if (!next) return;
  const controller = new AbortController();
  running = controller;
  const reading: { current: ThumbRequest | null } = { current: null };
  const outcome = await readVideo(next.url, controller.signal, async (reader) => {
    for (;;) {
      const index = waiting.findIndex((item) => item.url === next.url);
      const item = index < 0 ? undefined : waiting.splice(index, 1)[0];
      if (!item) return;
      reading.current = item;
      await reader.seek(item.seconds);
      store.set(item.key, { status: "ready", src: reader.thumbnail(THUMB_WIDTH) });
      reading.current = null;
    }
  });
  if (!outcome.ok) {
    // The file (or one seek) failed: every picture still waiting for this file says why; a cancel just forgets them
    const failed = [...(reading.current ? [reading.current] : []), ...waiting.filter((item) => item.url === next.url)];
    waiting = waiting.filter((item) => item.url !== next.url);
    for (const item of failed) {
      if (outcome.aborted) store.delete(item.key);
      else store.set(item.key, { status: "failed", reason: outcome.reason });
    }
  }
  running = null;
  void pump();
}

function requestThumb(url: string, seconds: number): void {
  const key = keyOf(url, seconds);
  if (store.get(key) || waiting.some((item) => item.key === key)) return;
  waiting.push({ key, url, seconds });
  store.set(key, { status: "loading" });
  void pump();
}

/** Drops the waiting pictures and stops the running read (finished pictures stay). */
export function cancelThumbs(): void {
  for (const item of waiting) store.delete(item.key);
  waiting = [];
  running?.abort();
}

/** The picture of `url` at `seconds`, read once `wanted` (the row was seen); null while there is nothing yet. */
export function useSourceThumb(url: string | null, seconds: number, wanted: boolean): ThumbState | null {
  const states = useSyncExternalStore(store.subscribe, store.snapshot);
  const state = url ? states.get(keyOf(url, seconds)) : undefined;
  const missing = state === undefined;
  useEffect(() => {
    if (url && wanted && missing) requestThumb(url, seconds);
  }, [url, seconds, wanted, missing]);
  return state ?? null;
}

if (import.meta.hot) import.meta.hot.dispose(() => cancelThumbs());
