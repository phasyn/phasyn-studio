#!/usr/bin/env node
// 從權威契約產生前端檔案（請勿手改產物）：
//   contracts/component.schema.json → src/api/generated/contracts.ts（wire 型別）
//   contracts/error-codes.json      → src/api/generated/errorCodes.ts（錯誤碼 → kind）
//   contracts/component.schema.json → src/api/generated/contracts.subset.json (the $defs closure the forms read)
//   用法：pnpm gen:types；pnpm gen:types --check 只比對不寫入（任一產物與契約不一致就失敗）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const schemaPath = resolve(appRoot, "../../contracts/component.schema.json");
const outFile = resolve(appRoot, "src/api/generated/contracts.ts");
const errorCodesPath = resolve(appRoot, "../../contracts/error-codes.json");
const errorCodesFile = resolve(appRoot, "src/api/generated/errorCodes.ts");
const subsetFile = resolve(appRoot, "src/api/generated/contracts.subset.json");
/** Contract definitions the forms use directly (lib/contractSchemas.ts and the `#/$defs/…` refs in src); the subset keeps their $ref closure. */
const FORM_DEFS = ["Device", "InstanceSettings", "LoadSettings", "RecorderConfig"];
const checkOnly = process.argv.includes("--check");

// 避免與全域型別（Error、Event）同名
const RENAME = { Error: "ApiErrorBody", Event: "RecordingEvent" };

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const defs = {};
for (const [name, def] of Object.entries(schema.$defs)) {
  const target = RENAME[name] ?? name;
  defs[target] = { ...def, title: target };
}
// Annotation keywords that may sit next to a $ref without changing what it validates. json-schema-to-typescript turns
// a $ref with siblings into a new schema (a numbered duplicate type such as RecordingCost1), so they are dropped there.
const ANNOTATIONS = new Set(["description", "title", "$comment", "examples", "deprecated", "readOnly", "writeOnly"]);
const isAnnotation = (key) => ANNOTATIONS.has(key) || key.startsWith("x-");
const rewrite = (node) => {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && Object.keys(node).every((key) => key === "$ref" || isAnnotation(key))) node = { $ref: node.$ref };
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
      const name = value.slice("#/$defs/".length);
      out.$ref = `#/$defs/${RENAME[name] ?? name}`;
    } else {
      out[key] = rewrite(value);
    }
  }
  return out;
};
const bundled = {
  title: "PhasynStudioContracts",
  type: "object",
  properties: Object.fromEntries(Object.keys(defs).map((k) => [k, { $ref: `#/$defs/${k}` }])),
  additionalProperties: false,
  $defs: rewrite(defs),
};
const banner = [
  "/* eslint-disable */",
  "/**",
  " * 由 scripts/gen-contracts.mjs 從 contracts/component.schema.json 產生；請勿手改。",
  " * 重新產生：pnpm --filter @phasyn-studio/frontend gen:types",
  " */",
].join("\n");
const source = await compile(bundled, "PhasynStudioContracts", {
  bannerComment: banner,
  additionalProperties: false,
  unreachableDefinitions: true,
  declareExternallyReferenced: true,
  ignoreMinAndMaxItems: true,
  strictIndexSignatures: true,
  unknownAny: true,
  format: true,
});
/** Error code → kind table from the server's error-code registry (contracts/error-codes.json). */
function errorCodesSource() {
  const registry = JSON.parse(readFileSync(errorCodesPath, "utf8"));
  const kinds = Object.keys(registry.kinds).sort();
  const entries = Object.entries(registry.codes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, entry]) => `  ${code}: ${JSON.stringify(entry.kind)},`);
  return [
    "/* eslint-disable */",
    "/**",
    " * 由 scripts/gen-contracts.mjs 從 contracts/error-codes.json 產生；請勿手改。",
    " * 重新產生：pnpm --filter @phasyn-studio/frontend gen:types",
    " */",
    `export type ErrorKind = ${kinds.map((kind) => JSON.stringify(kind)).join(" | ")};`,
    "",
    "/** Every code the server may send, with its kind (client, conflict, unavailable, remote, internal). */",
    "export const ERROR_CODE_KINDS: Readonly<Record<string, ErrorKind>> = {",
    ...entries,
    "};",
    "",
    "/** Recorder notice codes (RecorderNotice.code): informational, never an error response. */",
    `export const NOTICE_CODES: readonly string[] = ${JSON.stringify(Object.keys(registry.notices ?? {}).sort())};`,
    "",
  ].join("\n");
}

/**
 * The $defs closure of FORM_DEFS, unchanged: the bundle carries a few KB of the contract instead of all of it (about
 * 150 KB minified). lib/contractSchemas.test.ts checks that every definition the source names is in it.
 */
function subsetSource() {
  const keep = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) visit(value.slice("#/$defs/".length).split("/")[0]);
        else walk(value);
      }
    }
  };
  const visit = (name) => {
    if (keep.has(name)) return;
    if (!Object.hasOwn(schema.$defs, name)) throw new Error(`contracts/component.schema.json has no $defs/${name}`);
    keep.add(name);
    walk(schema.$defs[name]);
  };
  FORM_DEFS.forEach(visit);
  const subset = {
    $comment: "Generated by scripts/gen-contracts.mjs from contracts/component.schema.json: the $defs closure the forms use. Do not edit.",
    $schema: schema.$schema,
    $defs: Object.fromEntries([...keep].sort().map((name) => [name, schema.$defs[name]])),
  };
  return `${JSON.stringify(subset, null, 2)}\n`;
}

const outputs = [
  [outFile, source],
  [errorCodesFile, errorCodesSource()],
  [subsetFile, subsetSource()],
];
if (checkOnly) {
  const stale = outputs.filter(([file, text]) => (existsSync(file) ? readFileSync(file, "utf8") : "") !== text).map(([file]) => file);
  if (stale.length > 0) {
    console.error(`與契約不一致：${stale.join("、")}；請執行 pnpm gen:types`);
    process.exit(1);
  }
  console.log("產生的檔案與契約一致");
} else {
  for (const [file, text] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`已寫入 ${file}`);
  }
}
