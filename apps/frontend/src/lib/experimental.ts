// Experiment and research variants the owner sets up next to the main routes and components: their names say so. They
// are listed after the main ones and never picked as a default (Video Studio's 實驗 group, Image Studio's route list and
// the pipeline template's component choices).
const EXPERIMENT_WORDS = /實驗|研究|research|experiment/iu; // i18n-ignore: matches the words people put in route and component names

/** True when one of the names (a label or an id) marks an experiment or research variant. */
export function namesExperiment(...names: readonly (string | null | undefined)[]): boolean {
  return names.some((name) => name != null && EXPERIMENT_WORDS.test(name));
}
