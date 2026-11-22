// Setup for the jsdom test project (`*.dom.test.ts(x)` / `*.test.tsx`): jest-dom matchers, per-test cleanup and stubs
// for the browser APIs jsdom lacks (ResizeObserver, matchMedia, media playback).
import * as domMatchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { resetCatalogCache } from "@/api/catalog";

// Vitest 5 separates the assertion return type from its subject. The pinned jest-dom adapter
// still augments Vitest 4's one-parameter interface; register the same public matchers directly.
declare module "vitest" {
  interface Matchers<R, T> extends Omit<TestingLibraryMatchers<T, R>, "toBeInTheDocument"> {
    toBeInTheDocument(): R;
  }
}
expect.extend(domMatchers);

class NoopResizeObserver {
  observe(): void { /* jsdom has no layout to observe. */ }
  unobserve(): void { /* jsdom has no layout to observe. */ }
  disconnect(): void { /* jsdom has no layout to observe. */ }
}

if (typeof globalThis.ResizeObserver === "undefined") globalThis.ResizeObserver = NoopResizeObserver;

if (typeof window.matchMedia !== "function") {
  class FixedMediaQuery extends EventTarget implements MediaQueryList {
    readonly matches = false;
    readonly media: string;
    onchange: MediaQueryList["onchange"] = null;

    constructor(media: string) {
      super();
      this.media = media;
    }
    addListener(): void { /* A synthetic query never changes. */ }
    removeListener(): void { /* A synthetic query never changes. */ }
  }
  window.matchMedia = (query) => new FixedMediaQuery(query);
}

// jsdom implements no media playback; components only need play() to resolve and pause()/load() to exist.
Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: () => Promise.resolve() });
Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => undefined });
Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => undefined });

// Vitest globals are off, so Testing Library cannot register its own afterEach cleanup.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCatalogCache();
});
