// Public entry of the plugin platform: the Controller's plugin
// registry as the web UI reads it, the rule evaluator, generation-setting checks, the content revisions recorded on
// takes, the plugin manager window, and the "use" controls a Studio puts next to its prompt.
// Other features import from here only; nothing in this feature imports a Studio.

// The registry
export type { PluginRegistry, RegistryGeneration, RegistryRule } from "./model/registry";
export { currentPluginRegistry } from "./registry/store";
export { usePluginRegistry } from "./registry/usePluginRegistry";

// Evaluating a project's selection
export { evaluateSelection, findingPlace, resolveSelection } from "./model/evaluate";
export type { PluginSelection, PromptEvaluation, RuleFinding } from "./model/evaluate";
// The matching the rules use, for checks outside a render (the prompt advisor, the shot descriptions dialog)
export { findPhrase, preparePhrases, type PreparedPhrase } from "./model/phrases";
export { withoutDialogue } from "./model/shots";
export { checkGeneration, generationDefaults, generationFindingText } from "./model/generation";
export type { GenerationActuals, GenerationFinding } from "./model/generation";
export { changedRevs, selectionRevs } from "./model/revs";
export { selectedItems } from "./model/contributions";
export { withoutRef } from "./model/selection";
export { pluginText } from "./model/text";

// The plugin manager window
export type { PluginProjectBinding } from "./manager/managerContext";
export { openPluginManager } from "./manager/managerOpen";
export { PluginManagerHost } from "./manager/PluginManagerHost";

// Using plugins next to a prompt
export { ActiveChips } from "./use/ActiveChips";
export { AddMenu } from "./use/AddMenu";
export { ApplyDefaultsDialog } from "./use/ApplyDefaultsDialog";
export type { GenerationTarget, ShotGenerationValues } from "./use/ApplyDefaultsDialog";
export { ManagePluginsButton } from "./use/ManagePluginsButton";
export { RegistryNotice } from "./parts/RegistryNotice";
export { PresetButtons } from "./use/PresetButtons";
export { ValidationList } from "./use/ValidationList";
