// Static architecture gate. Parse imports only; never import application modules or start a test runner.
import { readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { featureGraph, findCycles, formatCycles, listSources, moduleSpecifiers, SRC_ROOT } from "./feature-graph.mjs";

const SHARED = new Set(["api", "components", "compute", "lib", "i18n", "test"]);
const EDITOR = "src/features/studio/editor/";
// Explicit domain owners: UI, browser media, migration and export adapters stay outside this set.
const DOMAIN = new Set(["model", "curves", "animation", "compositing", "adjustment", "validation", "slicing", "timing", "commands", "restoreTake", "transitionCut", "history", "historyLabels", "sourceDrop", "timelineGeometry"].map((name) => `${EDITOR}${name}.ts`));

function isEntry(specifier, file) {
  const rest = specifier.replace(/^@\/features\/[^/]+/, "");
  return specifier.startsWith("@/features/") && (rest === "" || (rest === "/testing" && /\.test\.tsx?$/.test(file)));
}

/** Resolve source aliases/relative specifiers lexically; dependency packages are not source paths. */
function sourceTarget(file, specifier) {
  if (specifier.startsWith("@/")) return posix.normalize(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return posix.normalize(posix.join(posix.dirname(file), specifier));
  return null;
}

function sourceFile(target, known) {
  if (!target) return null;
  const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
  const candidates = [target, ...[".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"].map((suffix) => `${stem}${suffix}`)];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** Pure rule evaluation over a feature graph and parsed source-module records. */
export function boundaryProblems(graph, modules) {
  const problems = [];
  const featureSites = [...graph.edges.values()].flatMap((out) => [...out.values()].flat());
  const cycles = findCycles(graph);
  if (cycles.length) problems.push(`Features must layer without cycles.\n${formatCycles(cycles)}`);
  for (const site of featureSites) {
    if (!site.specifier.startsWith("@/features/")) problems.push(`${site.file}:${site.line}  Cross-feature imports must use @/features/<name>: ${site.specifier}`);
    else if (!isEntry(site.specifier, site.file)) problems.push(`${site.file}:${site.line}  Import the public feature entry: ${site.specifier}`);
  }
  if (graph.features.length < 2 || graph.files <= graph.features.length || featureSites.length === 0) problems.push("Feature inventory is unexpectedly empty or incomplete; update the architecture scanner before accepting this result.");

  const known = new Set(modules.map((module) => module.file));
  const editorFiles = modules.filter((module) => module.file.startsWith(EDITOR));
  const editorGraph = { features: editorFiles.map((module) => module.file).sort(), edges: new Map(editorFiles.map((module) => [module.file, new Map()])), files: editorFiles.length };
  for (const file of DOMAIN) if (!known.has(file)) problems.push(`${file}: domain owner is missing; update the boundary map in the same change.`);

  for (const module of modules) {
    const layer = module.file.split("/")[1];
    for (const site of module.sites) {
      const target = sourceTarget(module.file, site.specifier);
      const resolved = sourceFile(target, known);
      const importsFeature = target?.startsWith("src/features/") ?? false;
      const location = `${module.file}:${site.line}  ${site.specifier}`;
      if (importsFeature && SHARED.has(layer)) problems.push(`${location}: shared layers must not import features.`);
      if (importsFeature && layer === "app" && module.file !== "src/app/lazyPages.tsx" && !isEntry(site.specifier, module.file)) problems.push(`${location}: app modules use public feature entries; only app/lazyPages.tsx may load page modules directly.`);

      if (DOMAIN.has(module.file)) {
        // Generated from the contract and free of I/O: the document's types, and the numeric bounds of the timeline
        const contracts = site.typeOnly && /^src\/api\/generated\/contracts(?:\.ts)?$/.test(target ?? "");
        const limits = /^src\/api\/generated\/timelineLimits(?:\.ts)?$/.test(target ?? "");
        const api = target?.startsWith("src/api/") && !contracts && !limits;
        const ui = target?.startsWith("src/components/") || target?.startsWith("src/app/") || resolved?.endsWith(".tsx") || /^src\/features\/[^/]+\/(?:components|hooks)(?:\/|$)/.test(target ?? "");
        const adapter = target?.startsWith(EDITOR) && !DOMAIN.has(resolved ?? target);
        // Domain code currently has no package dependency. A package needs an explicit boundary decision.
        const dependency = target === null;
        if (api || ui || adapter || dependency) problems.push(`${location}: editor domain modules must not import UI, browser/export adapters or API I/O; generated contract types and timeline limits are allowed.`);
      }

      if (module.file.startsWith(EDITOR) && resolved?.startsWith(EDITOR)) {
        if (module.file === resolved) problems.push(`${location}: editor modules must not import themselves.`);
        const edges = editorGraph.edges.get(module.file);
        if (!edges.has(resolved)) edges.set(resolved, []);
        edges.get(resolved).push({ ...site, file: module.file });
      }
    }
  }
  const editorCycles = findCycles(editorGraph);
  if (editorCycles.length) problems.push(`Editor modules must layer without cycles (type-only edges included).\n${formatCycles(editorCycles)}`);
  return problems;
}

/** Filesystem adapter; the rule evaluator above accepts in-memory records for focused static checks. */
export function inspectBoundaries(srcRoot = SRC_ROOT) {
  const graph = featureGraph(srcRoot);
  const appRoot = dirname(srcRoot);
  const roots = [...SHARED, "app", "features/studio/editor"];
  const modules = roots.flatMap((root) => listSources(join(srcRoot, root))).sort().map((file) => ({
    file: relative(appRoot, file).split(sep).join("/"),
    sites: moduleSpecifiers(file, readFileSync(file, "utf8")),
  }));
  return { features: graph.features.length, files: graph.files, editorFiles: modules.filter((module) => module.file.startsWith(EDITOR)).length, problems: boundaryProblems(graph, modules) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectBoundaries();
  if (result.problems.length) {
    console.error(result.problems.join("\n"));
    process.exitCode = 1;
  } else console.log(`Architecture boundaries: ${result.features} features, ${result.files} feature files, ${result.editorFiles} editor files; no violations.`);
}
