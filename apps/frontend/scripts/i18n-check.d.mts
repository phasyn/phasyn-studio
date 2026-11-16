// scripts/i18n-check.mjs 的型別（src/i18n/completeness.test.ts 用）。
export interface I18nIssue {
  /** file:line（原始碼）或 <locale>/<file>（目錄檔）。 */
  where: string;
  /** 繁中原文（目錄的 key）。 */
  source: string;
  area?: string;
  context?: string;
  kind?: string;
  problem?: string;
}

export interface I18nCheckResult {
  files: number;
  sources: number;
  unwrapped: I18nIssue[];
  problems: I18nIssue[];
  missing: Record<string, I18nIssue[]>;
  invalid: I18nIssue[];
  duplicates: I18nIssue[];
  broken: I18nIssue[];
  stale: Record<string, number | null>;
  /** Stale entries per locale (null without the server scan). */
  staleEntries: Record<string, I18nIssue[] | null>;
  overrides: I18nIssue[];
}

export type I18nSection = "unwrapped" | "problems" | "missing" | "invalid" | "duplicates" | "broken" | "overrides";

export const CHECK_LOCALES: readonly string[];
export const DEFAULT_CATALOGS: string;
export function entryProblems(source: string, value: unknown): string[];
export function runI18nCheck(options?: { catalogsDir?: string; locales?: readonly string[]; server?: ReadonlyArray<{ source: string; where?: string[] }> | null }): I18nCheckResult;
export function formatSection(result: I18nCheckResult, section: I18nSection, locale?: string | null, max?: number): string;
export function formatReport(result: I18nCheckResult, max?: number): string;
export const SERVER_SCANNER: string;
export function serverSources(): Array<{ source: string; where?: string[] }> | null;
export function pruneStale(result: I18nCheckResult, catalogsDir?: string, areas?: readonly string[] | null): number;
