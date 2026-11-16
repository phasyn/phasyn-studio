// How a key leads to the next one: the choices of the key strip, in the order editors expect them.
import type { TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import type { ChoiceOption } from "../fields";

export type Interpolation = TimelineKeyframe["interpolation"];

export const INTERPOLATIONS: readonly ChoiceOption<Interpolation>[] = [
  { value: "linear", label: t("線性") },
  { value: "bezier", label: t("貝茲") },
  { value: "ease_in", label: t("緩入") },
  { value: "ease_out", label: t("緩出") },
  { value: "ease_in_out", label: t("緩入緩出") },
  { value: "hold", label: t("定格") },
];
