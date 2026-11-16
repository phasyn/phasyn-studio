// Setup for the jsdom test project (`*.dom.test.ts(x)` / `*.test.tsx`): jest-dom matchers, per-test cleanup and stubs
// for the browser APIs jsdom lacks (ResizeObserver, matchMedia, media playback).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetCatalogCache } from "@/api/catalog";

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") globalThis.ResizeObserver = NoopResizeObserver;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
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
