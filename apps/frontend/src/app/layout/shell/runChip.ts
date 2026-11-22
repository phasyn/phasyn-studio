// The running-run chip's short name (a pure helper beside ActiveRun, so that file only exports components).
/** A run's name without the 「Studio：<project>・」 prefix the Studio puts on its renders. */
export function chipName(label: string): string {
  const rest = /^Studio\s*[:：][^・·]*[・·]\s*(.+)$/u.exec(label)?.[1]; // i18n-ignore: matched run-label data
  return rest ?? label;
}
