import type { FeatureGraph, ImportSite } from "./feature-graph.mjs";

export interface BoundaryModule {
  /** App-relative source path with forward slashes. */
  file: string;
  sites: Omit<ImportSite, "file">[];
}

export interface BoundaryReport {
  features: number;
  files: number;
  editorFiles: number;
  problems: string[];
}

export function boundaryProblems(graph: FeatureGraph, modules: readonly BoundaryModule[]): string[];
export function inspectBoundaries(srcRoot?: string): BoundaryReport;
