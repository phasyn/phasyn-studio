#!/usr/bin/env node
// i18n 完整性檢查（pnpm test 的 src/i18n/completeness.test.ts 與 pnpm i18n:check 共用）：
//   1. 使用者看得到的繁中字串都已包成 t()／<T>（i18n-ignore、測試、fixtures、未打包的檔案除外）
//   2. 每個 t()／<T> 原文（與命令面板關鍵字等執行期翻譯的原文）在 ja、en 目錄都有條目
//   3. 條目格式：placeholder 與原文相同、<n> 標籤相同、單複數物件格式正確；同一原文不可出現在兩個目錄檔
// CLI 另外檢查伺服器固定文字（執行 tools/i18n/server_scan.py）、過期條目與失效的覆寫規則。
//   node scripts/i18n-check.mjs [--catalogs <dir>] [--no-server] [--allow-missing] [--max <n>]
//                               [--list-stale | --prune-stale [--files server,common]]
//   --list-stale 列出過期條目（沒有任何原文需要的 key）；--prune-stale 從目錄檔刪掉它們（--files 只處理這些 area 檔）。
//   兩者都需要伺服器掃描（否則伺服器文字的 key 看起來都像過期），不能與 --no-server 一起用。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, OVERRIDES, areaOf, bundledFiles, listSourceFiles, scanFile } from "./i18n-scan.mjs";

export const CHECK_LOCALES = ["ja", "en"];
export const DEFAULT_CATALOGS = join(APP_ROOT, "src/i18n/catalogs");

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const TAG_RE = /<\/?\d+\/?>/g;
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other", "$count"]);

function placeholderSet(text) {
  return new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
}

function tagList(text) {
  return [...text.matchAll(TAG_RE)].map((m) => m[0]).sort();
}

/** 掃描打包進前端的檔案：未包的字串、已包的原文（含執行期翻譯的原文）、寫法錯誤（t() 不是字串常值）。 */
export function collectSources() {
  const files = listSourceFiles();
  const bundled = bundledFiles(files);
  const unwrapped = [];
  const problems = [];
  const sources = new Map();
  for (const rel of files) {
    if (!bundled.has(rel)) continue;
    for (const site of scanFile(rel)) {
      const where = `${rel}:${site.line}`;
      if (site.decision === "wrap") unwrapped.push({ where, source: site.source, context: site.context, kind: site.kind });
      else if (site.reason === "t-template-arg") problems.push({ where, source: site.source, problem: "t() 的第一個引數要是字串常值（樣板字串在執行期才組出來，永遠查不到譯文）" });
      else if (site.decision === "wrapped" || site.decision === "dynamic") {
        const entry = sources.get(site.source) ?? { where: [], area: areaOf(rel).area };
        entry.where.push(where);
        sources.set(site.source, entry);
      }
    }
  }
  return { files: bundled.size, unwrapped, problems, sources };
}

/** 讀取一種語言的所有目錄檔：原文 → { value, file }；記下重複與壞掉的檔案。 */
export function loadLocaleCatalogs(catalogsDir, locale) {
  const dir = join(catalogsDir, locale);
  const entries = new Map();
  const duplicates = [];
  const broken = [];
  if (!existsSync(dir)) return { entries, duplicates, broken, files: [] };
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (error) {
      broken.push({ where: `${locale}/${name}`, source: "", problem: `不是有效的 JSON：${error.message}` });
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      broken.push({ where: `${locale}/${name}`, source: "", problem: "目錄檔要是 JSON 物件" });
      continue;
    }
    for (const [source, value] of Object.entries(data)) {
      const previous = entries.get(source);
      if (previous) duplicates.push({ where: `${locale}/${previous.file} ＋ ${locale}/${name}`, source, problem: "同一個原文出現在兩個目錄檔" });
      entries.set(source, { value, file: name });
    }
  }
  return { entries, duplicates, broken, files };
}

/** 單一條目的格式問題（placeholder 與 <n> 標籤與原文相同；單複數物件另可有 zero／two／few／many）。 */
export function entryProblems(source, value) {
  const want = placeholderSet(source);
  const wantTags = tagList(source).join(" ");
  const checkText = (text, allowMissing = null) => {
    const out = [];
    if (typeof text !== "string" || text.trim() === "") return ["譯文是空的"];
    const got = placeholderSet(text);
    const missing = [...want].filter((name) => !got.has(name) && name !== allowMissing);
    const extra = [...got].filter((name) => !want.has(name));
    if (missing.length) out.push(`缺少 placeholder ${missing.map((n) => `{${n}}`).join("、")}`);
    if (extra.length) out.push(`多出 placeholder ${extra.map((n) => `{${n}}`).join("、")}`);
    if (tagList(text).join(" ") !== wantTags) out.push(`rich-text 標籤與原文不同（原文 ${wantTags || "無"}）`);
    return out;
  };
  if (typeof value === "string") return checkText(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["條目要是字串或單複數物件"];
  const keys = Object.keys(value);
  if (keys.some((key) => !PLURAL_KEYS.has(key)) || typeof value.other !== "string") return ["單複數物件只能有 one／other（必要）／$count 等鍵"];
  const count = value.$count;
  if (count !== undefined && (typeof count !== "string" || !want.has(count))) return [`$count「${String(count)}」不是原文的 placeholder`];
  const out = [];
  for (const [form, text] of Object.entries(value)) {
    if (form === "$count") continue;
    for (const problem of checkText(text, form === "one" ? (count ?? "count") : null)) out.push(`${form}：${problem}`);
  }
  return out;
}

/** Repo-level scanner of fixed server texts (tools/i18n/server_scan.py). */
export const SERVER_SCANNER = fileURLToPath(new URL("../../../tools/i18n/server_scan.py", import.meta.url));

/** Fixed server texts from SERVER_SCANNER; null only when python3 is not installed (a failing scan throws). */
export function serverSources() {
  const dir = mkdtempSync(join(tmpdir(), "i18n-server-"));
  const out = join(dir, "server.json");
  try {
    const run = spawnSync("python3", ["-I", SERVER_SCANNER, "--out", out], { encoding: "utf8" });
    if (run.error && run.error.code === "ENOENT") return null;
    if (run.status !== 0 || !existsSync(out)) throw new Error(`server_scan.py failed (exit ${run.status}): ${(run.stderr || String(run.error ?? "")).trim()}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 完整檢查。server：伺服器固定文字清單（serverSources() 的結果）；給了才檢查伺服器文字與過期條目。
 * 回傳的每個問題都有 where（file:line 或目錄檔）與 source（原文），方便一次修完。
 */
export function runI18nCheck({ catalogsDir = DEFAULT_CATALOGS, locales = CHECK_LOCALES, server = null } = {}) {
  const collected = collectSources();
  const required = new Map(collected.sources);
  if (server) {
    for (const item of server) {
      if (!required.has(item.source)) required.set(item.source, { where: item.where ?? [], area: "server" });
    }
  }
  const result = {
    files: collected.files,
    sources: required.size,
    unwrapped: collected.unwrapped,
    problems: collected.problems,
    missing: {},
    invalid: [],
    duplicates: [],
    broken: [],
    stale: {},
    staleEntries: {},
    overrides: [],
  };
  for (const locale of locales) {
    const catalog = loadLocaleCatalogs(catalogsDir, locale);
    result.duplicates.push(...catalog.duplicates);
    result.broken.push(...catalog.broken);
    result.missing[locale] = [];
    for (const [source, info] of required) {
      if (!catalog.entries.has(source)) result.missing[locale].push({ where: info.where[0] ?? "", source, area: info.area });
    }
    const stale = [];
    for (const [source, { value, file }] of catalog.entries) {
      if (!required.has(source)) {
        stale.push({ where: `${locale}/${file}`, source });
        continue;
      }
      for (const problem of entryProblems(source, value)) result.invalid.push({ where: `${locale}/${file}`, source, problem });
    }
    result.stale[locale] = server ? stale.length : null;
    result.staleEntries[locale] = server ? stale : null;
  }
  const files = new Set(listSourceFiles());
  for (const override of OVERRIDES) {
    if (!files.has(override.file)) result.overrides.push({ where: override.file, source: "", problem: "覆寫規則指向不存在的檔案（改名或刪除後要更新 i18n-scan.mjs 的 OVERRIDES）" });
  }
  return result;
}

const SECTION_TITLES = {
  unwrapped: "未包成 t()／<T> 的繁中字串（包起來，或確定不是介面文字時在同一行加 // i18n-ignore）",
  problems: "寫法錯誤",
  invalid: "目錄條目格式錯誤",
  duplicates: "重複的原文",
  broken: "壞掉的目錄檔",
  overrides: "失效的覆寫規則",
};

/** 一個區段的文字報告（每行：位置 + 原文 + 說明）。 */
export function formatSection(result, section, locale = null, max = 400) {
  const list = section === "missing" ? (result.missing[locale] ?? []) : (result[section] ?? []);
  if (list.length === 0) return "";
  const title = section === "missing" ? `${locale} 缺少譯文（在 src/i18n/catalogs/${locale}/<area>.json 補上）` : SECTION_TITLES[section];
  const lines = [`${title}：${list.length} 筆`];
  for (const item of list.slice(0, max)) {
    const area = item.area ? ` [${item.area}]` : "";
    lines.push(`  ${item.where}${area}  ${JSON.stringify(item.source)}${item.problem ? `  — ${item.problem}` : ""}`);
  }
  if (list.length > max) lines.push(`  …另有 ${list.length - max} 筆`);
  return lines.join("\n");
}

export function formatReport(result, max = 400) {
  const parts = ["unwrapped", "problems", "invalid", "duplicates", "broken", "overrides"].map((section) => formatSection(result, section, null, max));
  for (const locale of Object.keys(result.missing)) parts.push(formatSection(result, "missing", locale, max));
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Removes stale entries (keys no source needs) from the catalog files; `areas` limits it to those area files
 * (e.g. ["server", "common"]). Only valid for a result computed with the server scan. Returns the removed count.
 */
export function pruneStale(result, catalogsDir = DEFAULT_CATALOGS, areas = null) {
  let removed = 0;
  for (const [locale, entries] of Object.entries(result.staleEntries)) {
    if (!entries) throw new Error("pruneStale needs a check result that includes the server scan");
    const byFile = new Map();
    for (const { where, source } of entries) {
      const file = where.slice(locale.length + 1);
      if (areas && !areas.includes(file.replace(/\.json$/, ""))) continue;
      byFile.set(file, [...(byFile.get(file) ?? []), source]);
    }
    for (const [file, sources] of byFile) {
      const path = join(catalogsDir, locale, file);
      const data = JSON.parse(readFileSync(path, "utf8"));
      for (const source of sources) delete data[source];
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
      removed += sources.length;
    }
  }
  return removed;
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const wantsStale = args.includes("--list-stale") || args.includes("--prune-stale");
  if (wantsStale && args.includes("--no-server")) throw new Error("--list-stale／--prune-stale 需要伺服器掃描，不能與 --no-server 一起用");
  const server = args.includes("--no-server") ? null : serverSources();
  if (wantsStale && !server) throw new Error("找不到 python3：沒有伺服器掃描就無法判斷過期條目");
  const catalogsDir = value("--catalogs") ?? DEFAULT_CATALOGS;
  const result = runI18nCheck({ catalogsDir, server });
  if (args.includes("--list-stale")) {
    for (const entries of Object.values(result.staleEntries)) for (const item of entries ?? []) console.log(`${item.where}  ${JSON.stringify(item.source)}`);
    return;
  }
  if (args.includes("--prune-stale")) {
    const areas = value("--files")?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
    console.log(`已刪除 ${pruneStale(result, catalogsDir, areas)} 筆過期條目`);
    return;
  }
  const max = Number(value("--max") ?? 400);
  const report = formatReport(result, max);
  if (report) console.log(report);
  const missing = Object.values(result.missing).reduce((n, list) => n + list.length, 0);
  console.log(
    `\n檔案 ${result.files}・原文 ${result.sources}${server ? `（含伺服器 ${server.length}）` : "（未檢查伺服器文字：找不到 python3）"}・未包 ${result.unwrapped.length}・缺譯 ${Object.entries(result.missing)
      .map(([locale, list]) => `${locale} ${list.length}`)
      .join("／")}・格式錯誤 ${result.invalid.length}・重複 ${result.duplicates.length}` +
      (server ? `・過期條目 ${Object.entries(result.stale).map(([locale, n]) => `${locale} ${n}`).join("／")}` : ""),
  );
  const failed = result.unwrapped.length + result.problems.length + result.invalid.length + result.duplicates.length + result.broken.length + (args.includes("--allow-missing") ? 0 : missing);
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
