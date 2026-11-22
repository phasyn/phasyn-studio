import { isFiniteNumber, isRecord } from "@/lib/json";
// The Program monitor in its own window (UI list #25): a same-origin window that the main window renders into
// through a React portal, so it is the same component tree and state; play, scrub, edits, captions and effects are in
// step by construction, and the window only shows (it saves nothing). The page's stylesheets and theme are copied in;
// keys typed there reach the editor's shortcuts; its place and size are remembered; when the Window Management API is
// available and allowed, a first opening goes to another screen. Closing it (or 收回) brings the monitor back.
import { useCallback, useEffect, useRef, useState } from "react";

const NAME = "phasyn-program-monitor";
const PLACE_KEY = "phasyn.editor.programWindow";
const DEFAULT_SIZE = { width: 1280, height: 800 };

interface Place {
  left: number;
  top: number;
  width: number;
  height: number;
}

let openWindow: Window | null = null;

/** Whether the Program window is open and visible: playback keeps running while it shows, even if the main page is hidden. */
export function popoutVisible(): boolean {
  return openWindow !== null && !openWindow.closed && !openWindow.document.hidden;
}

function readPlace(): Place | null {
  try {
    const raw = window.localStorage.getItem(PLACE_KEY);
    if (!(raw != null && raw !== "")) return null;
    const place: unknown = JSON.parse(raw);
    if (!isRecord(place)) return null;
    const {left, top, width, height} = place;
    return isFiniteNumber(left) && isFiniteNumber(top) && isFiniteNumber(width) && isFiniteNumber(height) ? {left, top, width, height} : null;
  } catch {
    return null;
  }
}

function savePlace(popup: Window): void {
  try {
    const place: Place = { left: popup.screenX, top: popup.screenY, width: popup.outerWidth, height: popup.outerHeight };
    if (place.width > 200 && place.height > 150) window.localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // a blocked storage only forgets the place
  }
}

declare global {
  interface Window {
    getScreenDetails?: () => Promise<{ screens: ScreenDetail[]; currentScreen: ScreenDetail }>;
  }
}

interface ScreenDetail {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
}

/** Another screen than the page's, when the Window Management API is there and the user allows it (else null). */
async function otherScreen(): Promise<Place | null> {
  if (typeof window.getScreenDetails !== "function") return null;
  try {
    const details = await Promise.race([window.getScreenDetails(), new Promise<null>((resolve) => void setTimeout(() => { resolve(null); }, 3000))]);
    const other = details?.screens.find((screen) => screen !== details.currentScreen);
    if (!other) return null;
    return { left: other.availLeft, top: other.availTop, width: other.availWidth, height: other.availHeight };
  } catch {
    return null;
  }
}

function features(place: Place | null): string {
  const size = place ?? { left: window.screenX + 80, top: window.screenY + 80, ...DEFAULT_SIZE };
  return `popup=yes,left=${String(Math.round(size.left))},top=${String(Math.round(size.top))},width=${String(Math.round(size.width))},height=${String(Math.round(size.height))}`;
}

/** The new window's page: the main page's stylesheets, theme attributes and language, and an empty root. */
function prepare(popup: Window, title: string): HTMLElement {
  const doc = popup.document;
  doc.title = title;
  const html = doc.documentElement;
  html.lang = document.documentElement.lang;
  html.className = document.documentElement.className;
  for (const { name, value } of Array.from(document.documentElement.attributes)) {
    if (name.startsWith("data-") || name === "style") html.setAttribute(name, value);
  }
  doc.head.replaceChildren(
    ...Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"], meta[name="color-scheme"]')).map((node) => doc.importNode(node, true)),
  );
  doc.body.className = document.body.className;
  doc.body.style.margin = "0";
  const root = doc.createElement("div");
  root.className = "flex h-dvh w-dvw flex-col bg-canvas text-fg";
  doc.body.replaceChildren(root);
  return root;
}

/** Keys typed in the Program window go to the main window's listeners (the editor's shortcuts). */
function forwardKeys(popup: Window): void {
  popup.addEventListener("keydown", (event) => {
    const copy = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
  });
}

export interface ProgramPopout {
  /** The window's root while it is open: the monitor is rendered there instead of in the panel. */
  container: HTMLElement | null;
  /** The opened window (for fullscreen). */
  popup: Window | null;
  /** Open the window (or bring it forward); false when the browser blocked it. */
  open: () => Promise<boolean>;
  /** Close the window: the monitor goes back into its panel. */
  close: () => void;
}

export function useProgramPopout(title: string): ProgramPopout {
  const [state, setState] = useState<{ popup: Window; container: HTMLElement } | null>(null);
  const liveRef = useRef(state);
  useEffect(() => {
    liveRef.current = state;
  });

  const close = useCallback(() => {
    const current = liveRef.current;
    if (!current) return;
    savePlace(current.popup);
    openWindow = null;
    setState(null);
    if (!current.popup.closed) current.popup.close();
  }, []);

  const open = useCallback(async () => {
    const current = liveRef.current;
    if (current && !current.popup.closed) {
      current.popup.focus();
      return true;
    }
    const place = readPlace() ?? (await otherScreen());
    const popup = window.open("", NAME, features(place));
    if (!popup) return false;
    const container = prepare(popup, title);
    forwardKeys(popup);
    // Closing the window by its own button, or reloading it, brings the monitor back
    popup.addEventListener("pagehide", () => {
      if (liveRef.current?.popup !== popup) return;
      savePlace(popup);
      openWindow = null;
      setState(null);
    });
    openWindow = popup;
    setState({ popup, container });
    popup.focus();
    return true;
  }, [title]);

  // The window lives only as long as the editor: leaving the page or the workspace closes it
  useEffect(() => {
    const leave = () => { close(); };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      close();
    };
  }, [close]);

  const popup = state?.popup ?? null;
  useEffect(() => {
    popup?.document.querySelector("title")?.replaceChildren(title);
  }, [popup, title]);

  return { container: state?.container ?? null, popup, open, close };
}
