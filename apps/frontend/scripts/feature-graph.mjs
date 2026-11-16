// Feature-level dependency graph of src/features: which feature imports which. Every import form counts (static and
// type-only imports, re-exports, import() and import types, require(), vi.mock() and friends), and test files are
// included. The architecture rule is that this graph has no cycles, so features layer cleanly and each one can be
// read, tested and lazy-loaded on its own; scripts/check-boundaries.mjs enforces it in `pnpm lint`.
// CLI: `node scripts/feature-graph.mjs` prints the edges and any cycle with its import sites (exit 1 on a cycle).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
/** vi.* calls whose first argument names a module the test depends on. */
const VI_MODULE_CALLS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/** Every TypeScript source under `dir` (declaration files excluded). */
export function listSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(path));
    else if (SOURCE_RE.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Module specifiers one source file depends on, with their 1-based lines. */
export function moduleSpecifiers(fileName, text) {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const add = (node, typeOnly) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    out.push({ specifier: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, typeOnly });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly));
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(first, false);
      else if (ts.isIdentifier(callee) && callee.text === "require") add(first, false);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "vi" && VI_MODULE_CALLS.has(callee.name.text)) add(first, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Builds the graph from `<srcRoot>/features/<name>/…`. `@/` resolves to srcRoot (the app's path alias); package imports
 * and imports of shared code (src/api, src/lib, src/components…) are not feature edges. Sites are relative to the app.
 */
export function featureGraph(srcRoot = SRC_ROOT) {
  const featuresDir = join(srcRoot, "features");
  const features = readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const known = new Set(features);
  const featureOf = (path) => {
    const rel = relative(featuresDir, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    const name = rel.split(sep)[0];
    return known.has(name) ? name : null;
  };
  const targetOf = (file, specifier) => {
    if (specifier.startsWith("@/")) return featureOf(join(srcRoot, specifier.slice(2)));
    if (specifier.startsWith(".")) return featureOf(resolve(dirname(file), specifier));
    return null;
  };
  const appRoot = dirname(srcRoot);
  /** from → to → import sites */
  const edges = new Map(features.map((name) => [name, new Map()]));
  let files = 0;
  for (const file of listSources(featuresDir)) {
    const from = featureOf(file);
    if (!from) continue;
    files += 1;
    for (const { specifier, line, typeOnly } of moduleSpecifiers(file, readFileSync(file, "utf8"))) {
      const to = targetOf(file, specifier);
      if (!to || to === from) continue;
      const out = edges.get(from);
      if (!out.has(to)) out.set(to, []);
      out.get(to).push({ file: relative(appRoot, file).split(sep).join("/"), line, specifier, typeOnly });
    }
  }
  return { features, edges, files };
}

/** One cycle per strongly connected component (Tarjan), as the shortest path from its first feature back to itself. */
export function findCycles(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let next = 0;
  const connect = (node) => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of graph.edges.get(node)?.keys() ?? []) {
      if (!index.has(to)) {
        connect(to);
        low.set(node, Math.min(low.get(node), low.get(to)));
      } else if (onStack.has(to)) low.set(node, Math.min(low.get(node), index.get(to)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) components.push(component.sort());
  };
  for (const node of graph.features) if (!index.has(node)) connect(node);
  return components
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((component) => {
      const members = new Set(component);
      const start = component[0];
      const previous = new Map([[start, null]]);
      const queue = [start];
      let last = null;
      while (queue.length && last === null) {
        const node = queue.shift();
        for (const to of graph.edges.get(node)?.keys() ?? []) {
          if (to === start) {
            last = node;
            break;
          }
          if (members.has(to) && !previous.has(to)) {
            previous.set(to, node);
            queue.push(to);
          }
        }
      }
      if (last === null) throw new Error(`no cycle back to ${start} in its component ${component.join(", ")}`);
      const path = [start];
      for (let node = last; node !== start; node = previous.get(node)) path.splice(1, 0, node);
      path.push(start);
      const sites = path.slice(0, -1).map((from, i) => graph.edges.get(from).get(path[i + 1]));
      return { features: component, path, sites };
    });
}

/** Human-readable report: each cycle, then up to `perEdge` import sites for every edge on it. */
export function formatCycles(cycles, perEdge = 3) {
  const lines = [];
  for (const cycle of cycles) {
    lines.push(`cycle: ${cycle.path.join(" → ")}${cycle.features.length > cycle.path.length - 1 ? ` (component: ${cycle.features.join(", ")})` : ""}`);
    cycle.sites.forEach((sites, i) => {
      lines.push(`  ${cycle.path[i]} → ${cycle.path[i + 1]}: ${sites.length} import(s)`);
      for (const site of sites.slice(0, perEdge)) lines.push(`    ${site.file}:${site.line}  ${site.specifier}${site.typeOnly ? " (type-only)" : ""}`);
    });
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const graph = featureGraph();
  for (const [from, out] of graph.edges) {
    for (const [to, sites] of out) console.log(`${from} → ${to}  (${sites.length} import${sites.length === 1 ? "" : "s"})`);
  }
  const cycles = findCycles(graph);
  console.log(cycles.length ? `\n${formatCycles(cycles)}` : `\n${graph.features.length} features, ${graph.files} files: no cycles`);
  process.exitCode = cycles.length ? 1 : 0;
}
