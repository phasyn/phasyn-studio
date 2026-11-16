// Which files the i18n tools look at: source files under src/, their catalog area, per-file overrides and the files the
// production bundle actually reaches from src/main.tsx.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { nameText } from "./ast.mjs";
import { APP_ROOT, SRC_ROOT, ts } from "./core.mjs";

export const AREAS = ["common", "studio", "studio-prompt", "studio-plugins", "image-studio", "inference", "components", "records", "server", "errors", "runtime"];

/**
 * Point overrides, matched by file and declaration name rather than line numbers (so they survive a restyle):
 *  names: outer variable names; props: names of the properties directly holding the strings; neither = the whole file.
 * --check reports overrides whose target is gone (update them here when a file is renamed or deleted).
 */
export const OVERRIDES = [
  {
    file: "src/features/studio/prompt/advisor/rewrite.ts",
    decision: "skip",
    reason: "override:llm-request",
    why: "「複製改寫指令」的全文：指南原文照錄（測試鎖 602 字元）＋使用者自行貼到 LLM 的請求內容，不是介面文字",
  },
  {
    file: "src/features/studio/prompt/advisor/examples.ts",
    props: ["text", "signature"],
    decision: "skip",
    reason: "override:prompt-content",
    why: "指南範例的 prompt 原文（插入編輯器、送進 H3）；signature 用來比對目前的 prompt",
  },
  {
    file: "src/features/prompt-studies/model/scene.ts",
    names: ["REVISION_INSTRUCTION"],
    decision: "skip",
    reason: "override:model-input",
    why: "自動修訂時送給視覺模型的指示；翻譯會改變模型輸入",
  },
  {
    file: "src/features/studio/references/materials.ts",
    names: ["IMAGE_MASK_NOTE"],
    decision: "review",
    context: "logic-key",
    reason: "override:stored-marker",
    why: "寫進專案素材的 note，之後用 === 辨認遮罩；翻譯後舊專案（或另一語言建立的）會認不出來。Video Studio 的素材清單不列遮罩，不會顯示這段文字",
  },
  {
    file: "src/app/layout/admin/PipelinesPane.tsx",
    names: ["INSTRUCTIONS"],
    decision: "wrap",
    context: "aria",
    reason: "override:ui-help",
    why: "樹狀清單的鍵盤／拖曳操作說明（aria 描述），不是模型指示",
  },
];

export function overrideFor(rel, node) {
  for (const o of OVERRIDES) {
    if (o.file !== rel) continue;
    if (!o.names && !o.props) return o;
    if (o.props) {
      const p = node.parent;
      if (p && ts.isPropertyAssignment(p) && p.initializer === node && o.props.includes(nameText(p.name))) return o;
    }
    if (o.names) {
      for (let cur = node; cur; cur = cur.parent) {
        if (ts.isVariableDeclaration(cur) && o.names.includes(nameText(cur.name))) return o;
      }
    }
  }
  return null;
}

const AREA_RULES = [
  // studio is large (about 3× any other area): the prompt editor and advice rules form studio-prompt, so translators can work in parallel
  ["src/features/studio/prompt/", "studio-prompt"],
  // the plugin platform and the Studio files that only wire it in: one catalog file for everything about plugins
  ["src/features/plugins/", "studio-plugins"],
  ["src/features/studio/components/PromptPlugins.tsx", "studio-plugins"],
  ["src/features/studio/model/promptPlugins.ts", "studio-plugins"],
  ["src/api/plugins.ts", "studio-plugins"],
  ["src/features/studio/", "studio"],
  ["src/features/studio-shell/", "studio"],
  ["src/features/image-studio/", "image-studio"],
  ["src/features/inference/", "inference"],
  ["src/features/prompt-studies/", "inference"],
  ["src/features/semantics/", "inference"],
  ["src/features/components/", "components"],
  ["src/features/pipelines/", "components"],
  ["src/features/recordings/", "records"],
  ["src/features/runs/", "records"],
  ["src/features/tracking/", "records"],
  ["src/features/activity/", "records"],
  ["src/features/command/", "common"],
];

/** The catalog area of a path; an unlisted features/<x>/ also goes to common but is reported as unknownFeature for a maintainer to place. */
export function areaOf(rel) {
  if (rel === "src/i18n/errors.ts") return { area: "errors", unknownFeature: null };
  if (rel.startsWith("src/i18n/")) return { area: "runtime", unknownFeature: null };
  for (const [prefix, area] of AREA_RULES) if (rel.startsWith(prefix)) return { area, unknownFeature: null };
  const match = /^src\/features\/([^/]+)\//.exec(rel);
  return { area: "common", unknownFeature: match ? match[1] : null };
}

const SKIP_FILE_RE = /(\.test|\.spec)\.(ts|tsx)$|\.d\.ts$/;
const SKIP_DIRS = new Set(["src/api/generated", "src/i18n/catalogs", "src/test"]);

/** The .ts / .tsx files under src/ to scan (not tests, the generated contracts or the i18n runtime itself). */
export function listSourceFiles(root = SRC_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(APP_ROOT, abs).split(sep).join("/");
      if (statSync(abs).isDirectory()) {
        if (!SKIP_DIRS.has(rel) && name !== "node_modules" && name !== "__tests__") walk(abs);
      } else if (/\.(ts|tsx)$/.test(name) && !SKIP_FILE_RE.test(name)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

function resolveImport(fromRel, spec, known) {
  let base;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(fromRel), spec).split(sep).join("/");
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (known.has(cand)) return cand;
  return null;
}

/**
 * Files reachable from src/main.tsx (static imports, export … from, dynamic import()) = the files bundled into the app.
 * Unreachable ones (fixtures and samples only tests use) hold no user-visible text, and the codemod leaves them alone.
 */
export function bundledFiles(files = listSourceFiles()) {
  const known = new Set(files);
  const edges = new Map();
  for (const rel of files) {
    const text = readFileSync(join(APP_ROOT, rel), "utf8");
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out = [];
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) out.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        out.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    edges.set(rel, out.map((spec) => resolveImport(rel, spec, known)).filter(Boolean));
  }
  const seen = new Set();
  const stack = ["src/main.tsx"].filter((f) => known.has(f));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const g of edges.get(f) ?? []) if (!seen.has(g)) stack.push(g);
  }
  return seen;
}
