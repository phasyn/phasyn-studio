// Types for scripts/precompress.mjs (used by vite.config.ts and its unit test).
import type { Plugin } from "vite";

export const COMPRESSIBLE: RegExp;
export const MIN_BYTES: number;
export function precompressDir(dir: string, options?: { minBytes?: number }): string[];
export function precompress(options?: { minBytes?: number }): Plugin;
