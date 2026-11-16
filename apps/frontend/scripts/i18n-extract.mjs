#!/usr/bin/env node
// i18n dry-run 抽取：列出 codemod 會包成 t() 的每個使用者可見 CJK 字串（依 area 去重），不改任何原始碼。
//   用法：node scripts/i18n-extract.mjs --out <dir> [--server <server-raw.json>] [--errors <errors-raw.json>]
//   產物：<dir>/<area>.json（[{ source, placeholders, where, uses, context, ... }]）、_review.json、_summary.json
//   規則：同一個原文只放在一個 area；出現在 ≥ 2 個 area（含後端）就放 common。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, AREAS, CJK_RE, areaOf, bundledFiles, listSourceFiles, pluralHint, scanFile } from "./i18n-scan.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const outDir = resolve(opt("--out") ?? join(APP_ROOT, "node_modules/.cache/i18n-extract"));
const serverRaw = opt("--server");
const errorsRaw = opt("--errors");
const MAX_WHERE = 6;

/** 譯者需要翻的 review 類別（UI 文字但寫法需要人工確認）；logic-key／filename 不進 area 檔。 */
const TRANSLATABLE_REVIEW = new Set(["fragment", "text", "list-item", "label", "title", "description", "tooltip", "message", "search-keyword", "filename"]);

const entries = new Map(); // source -> { areas:Set, sites:[] }
const review = [];
const skipped = new Map();
const unknownFeatures = new Map();
let fileCount = 0;

const note = (source, area, site) => {
  let e = entries.get(source);
  if (!e) {
    e = { areas: new Set(), sites: [] };
    entries.set(source, e);
  }
  e.areas.add(area);
  e.sites.push(site);
};

const allFiles = listSourceFiles();
const bundled = bundledFiles(allFiles);
const notBundled = allFiles.filter((f) => !bundled.has(f));
for (const rel of allFiles) {
  if (!bundled.has(rel)) continue; // 只給測試用（fixtures、samples）：不會出現在介面上
  fileCount += 1;
  const { area, unknownFeature } = areaOf(rel);
  if (unknownFeature) unknownFeatures.set(unknownFeature, (unknownFeatures.get(unknownFeature) ?? 0) + 1);
  for (const site of scanFile(rel)) {
    if (site.decision === "skip") {
      skipped.set(site.reason, (skipped.get(site.reason) ?? 0) + 1);
      continue;
    }
    if (site.decision === "review") {
      review.push({
        where: `${rel}:${site.line}`,
        area,
        reason: site.reason,
        context: site.context,
        source: site.source,
        ...(site.exprs?.length ? { exprs: site.exprs } : {}),
        notes: site.notes,
      });
      if (!TRANSLATABLE_REVIEW.has(site.context)) continue;
    }
    note(site.source, area, { ...site, area });
  }
}

// index.html（noscript、載入中、title、meta description）：codemod 不改 HTML，由 index.html 的語系腳本處理。
const htmlPath = join(APP_ROOT, "index.html");
if (existsSync(htmlPath)) {
  const lines = readFileSync(htmlPath, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/\slang="(ja|en)"/.test(line)) return; // 已經是日文／英文的 noscript 行
    const texts = [];
    for (const m of line.matchAll(/>([^<>]+)</g)) texts.push({ text: m[1].trim(), context: "html-text" });
    for (const m of line.matchAll(/\scontent="([^"]+)"/g)) texts.push({ text: m[1].trim(), context: "html-meta" });
    for (const { text, context } of texts) {
      if (text && CJK_RE.test(text)) {
        note(text, "common", { file: "index.html", line: i + 1, kind: "html", decision: "wrap", reason: "index-html", context, placeholders: [], notes: ["index.html（非 codemod）"] });
      }
    }
  });
}

/** 後端字串（tools/i18n/server_scan.py 的輸出）與錯誤標題：同一原文若也在前端出現就放 common。 */
const external = [];
for (const [path, area] of [
  [serverRaw, "server"],
  [errorsRaw, "errors"],
]) {
  if (!path) continue;
  const items = JSON.parse(readFileSync(path, "utf8"));
  for (const item of items) {
    external.push(item);
    for (const where of item.where ?? []) {
      note(item.source, area, {
        file: where.replace(/:\d+$/, ""),
        line: Number(/:(\d+)$/.exec(where)?.[1] ?? 0),
        kind: area,
        decision: "wrap",
        reason: area,
        context: item.context ?? "description",
        placeholders: item.placeholders ?? [],
        notes: item.notes ?? [],
        whereText: where,
        extra: item,
      });
    }
    if (!item.where?.length) note(item.source, area, { file: "", line: 0, kind: area, decision: "wrap", reason: area, context: item.context, placeholders: item.placeholders ?? [], notes: item.notes ?? [], extra: item });
  }
}

const byArea = Object.fromEntries(AREAS.map((a) => [a, []]));
const NOTE_KEEP = new Set(["as-const", "punctuation-only", "outer-whitespace", "nested", "nested-array", "joined-fragments", "fragment-of-rich-text", "rewrite-concatenation", "rich-text", "index.html（非 codemod）"]);
for (const [source, e] of entries) {
  const area = e.areas.size > 1 ? "common" : [...e.areas][0];
  const contexts = new Map();
  for (const s of e.sites) contexts.set(s.context, (contexts.get(s.context) ?? 0) + 1);
  const ranked = [...contexts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const ui = [...new Set(e.sites.flatMap((s) => s.notes.filter((n) => /^<|\(\)$|:$|^const /.test(n))))].slice(0, 4);
  const notes = [...new Set(e.sites.flatMap((s) => s.notes.filter((n) => NOTE_KEEP.has(n) || /^(api-payload|run-label|prompt-template)/.test(n))))];
  const reviews = [...new Set(e.sites.filter((s) => s.decision === "review").map((s) => s.reason))];
  const placeholders = e.sites[0].placeholders ?? [];
  const sorted = [...e.sites].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const entry = {
    source,
    placeholders,
    where: sorted.slice(0, MAX_WHERE).map((s) => s.whereText ?? `${s.file}:${s.line}`),
    uses: e.sites.length,
    context: ranked[0],
  };
  if (ranked.length > 1) entry.contexts = ranked;
  if (ui.length) entry.ui = ui;
  if (notes.length) entry.notes = notes;
  if (reviews.length) entry.review = reviews;
  if (pluralHint(source, placeholders)) entry.plural = true;
  if (source !== source.trim()) entry.notes = [...(entry.notes ?? []), "edge-whitespace: keep the same leading/trailing spaces"];
  if (source.includes("\n")) entry.notes = [...(entry.notes ?? []), `newlines: keep exactly ${source.split("\n").length - 1}`];
  const braceNames = [...source.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  if ((source.match(/[{}]/g) ?? []).length !== placeholders.length * 2 || braceNames.some((n) => !placeholders.includes(n))) {
    entry.notes = [...(entry.notes ?? []), "literal-braces: some {…} here are literal text, not placeholders"];
  }
  if (e.areas.size > 1) entry.areas = [...e.areas].sort();
  const extra = e.sites.find((s) => s.extra)?.extra;
  const slots = e.sites.find((s) => s.slots?.length)?.slots;
  if (slots) entry.slots = slots;
  // placeholder → 第一個出處的原始運算式（讓譯者知道 {value} 是什麼）
  const withExprs = sorted.find((s) => s.exprs?.length === placeholders.length && placeholders.length > 0);
  if (withExprs) entry.args = Object.fromEntries(placeholders.map((n, i) => [n, withExprs.exprs[i].replace(/\s+/g, " ").slice(0, 80)]));
  if (extra?.origin) entry.origin = extra.origin;
  if (extra?.code) entry.code = extra.code;
  if (extra?.group) entry.group = extra.group;
  if (extra?.uses && e.areas.size === 1) entry.uses = extra.uses;
  if (extra?.notes?.length) entry.notes = [...new Set([...(entry.notes ?? []), ...extra.notes])];
  byArea[area].push({ entry, firstFile: sorted[0].file, firstLine: sorted[0].line });
}

mkdirSync(outDir, { recursive: true });
const summary = { generated_by: "apps/frontend/scripts/i18n-extract.mjs (dry-run)", files_scanned: fileCount, areas: {}, review_sites: review.length, skipped_by_reason: Object.fromEntries([...skipped.entries()].sort((a, b) => b[1] - a[1])) };
for (const area of AREAS) {
  const list = byArea[area].sort((a, b) => (a.firstFile === b.firstFile ? a.firstLine - b.firstLine : a.firstFile < b.firstFile ? -1 : 1)).map((x) => x.entry);
  if (!list.length && (area === "server" || area === "errors")) continue;
  writeFileSync(join(outDir, `${area}.json`), `${JSON.stringify(list, null, 2)}\n`);
  const chars = list.reduce((n, x) => n + [...x.source].length, 0);
  summary.areas[area] = {
    strings: list.length,
    uses: list.reduce((n, x) => n + x.uses, 0),
    source_chars: chars,
    with_placeholders: list.filter((x) => x.placeholders.length).length,
    plural_candidates: list.filter((x) => x.plural).length,
    needs_review: list.filter((x) => x.review).length,
  };
}
const reviewByReason = {};
for (const r of review) {
  const key = r.reason.replace(/:.*/, "");
  reviewByReason[key] = (reviewByReason[key] ?? 0) + 1;
}
summary.review_by_reason = Object.fromEntries(Object.entries(reviewByReason).sort((a, b) => b[1] - a[1]));
if (unknownFeatures.size) summary.unknown_feature_dirs_counted_as_common = Object.fromEntries(unknownFeatures);
summary.not_bundled_files_skipped = notBundled;
summary.total_unique_strings = Object.values(summary.areas).reduce((n, a) => n + a.strings, 0);
writeFileSync(join(outDir, "_review.json"), `${JSON.stringify(review, null, 2)}\n`);
writeFileSync(join(outDir, "_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`files scanned: ${fileCount}`);
for (const [area, s] of Object.entries(summary.areas)) {
  console.log(`${area.padEnd(13)} strings=${String(s.strings).padStart(5)} uses=${String(s.uses).padStart(5)} chars=${String(s.source_chars).padStart(6)} placeholders=${s.with_placeholders} plural=${s.plural_candidates} review=${s.needs_review}`);
}
console.log(`total unique: ${summary.total_unique_strings}; review sites: ${review.length}; out: ${outDir}`);
