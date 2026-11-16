// Types for scripts/feature-graph.mjs (used by its unit test).

export interface ImportSite {
  /** Path relative to the app root, with forward slashes. */
  file: string;
  line: number;
  specifier: string;
  typeOnly: boolean;
}

export interface FeatureGraph {
  features: string[];
  /** from → to → import sites */
  edges: Map<string, Map<string, ImportSite[]>>;
  /** Source files read under src/features. */
  files: number;
}

export interface FeatureCycle {
  /** Every feature of the strongly connected component, sorted. */
  features: string[];
  /** Shortest cycle from the component's first feature back to itself. */
  path: string[];
  /** Import sites of each edge on `path`. */
  sites: ImportSite[][];
}

export const SRC_ROOT: string;
export function listSources(dir: string): string[];
export function moduleSpecifiers(fileName: string, text: string): { specifier: string; line: number; typeOnly: boolean }[];
export function featureGraph(srcRoot?: string): FeatureGraph;
export function findCycles(graph: FeatureGraph): FeatureCycle[];
export function formatCycles(cycles: readonly FeatureCycle[], perEdge?: number): string;
