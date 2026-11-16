// Types for scripts/third-party-licenses.mjs (used by vite.config.ts and its unit test).
import type { Plugin } from "vite";

export interface BundledPackage {
  name: string;
  version: string;
  license: string | null;
  author: string | null;
  repository: string | null;
  texts: { name: string; text: string }[];
}

export const ALLOWED_LICENSES: Set<string>;
export function packageRoot(moduleId: string): string | null;
export function licenseAllowed(expression: string | null, allowed?: ReadonlySet<string>): boolean;
export function readPackage(root: string): BundledPackage;
export function markdownSection(markdown: string, heading: string): string | null;
export function renderNotice(packages: readonly BundledPackage[], adapted?: readonly string[]): string;
export function thirdPartyLicenses(options?: {
  fileName?: string;
  allowed?: ReadonlySet<string>;
  adapted?: { file: string; sections: readonly string[] } | null;
}): Plugin;
