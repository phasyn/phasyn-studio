import { RunRecipePanel } from "@/components/common/RunRecipePanel";
import { RunRecipeComparison, type RecipeComparisonScope } from "./RunRecipeComparison";
import { InferencePresetPanel } from "./InferencePresetPanel";

/** `scope`: inside a Studio project, compare only against that project's runs (the given shot's first). */
export function NativeRunRecipePanel({ runId, running, scope }: { runId: string; running: boolean; scope?: RecipeComparisonScope }) {
  return <div className="grid min-w-0 gap-3"><RunRecipeComparison key={runId} runId={runId} scope={scope} /><RunRecipePanel runId={runId} running={running} renderPreset={(provider) => <InferencePresetPanel key={runId} runId={runId} provider={provider} />} /></div>;
}
