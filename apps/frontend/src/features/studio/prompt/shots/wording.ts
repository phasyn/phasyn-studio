// The shot-line wording checks, shared by
// the prompt advisor (修正與建議) and the 逐鏡描述 dialog, matched as whole words (spaces, hyphens and line breaks
// alike; dialogue not counted).
//  - A viewpoint that contradicts the reference video (side for a back view) made H3 draw the new character that way
//    and then copy the original shot: every shot line that names a <Subject N> states the viewpoint it has there.
//  - What a shot line negates gets drawn (no wings → wings): the line describes what is there instead.
// The dialog's viewpoint chips write one of VIEWPOINTS; each of their phrases contains a viewpoint term. Pure.
import { findPhrase, preparePhrases, withoutDialogue } from "@/features/plugins";
import { t } from "@/i18n";

/** What states a viewpoint. */
export const VIEWPOINT_TERMS: readonly string[] = [
  "from the front",
  "front view",
  "frontal",
  "head-on",
  "facing the camera",
  "facing the lens",
  "facing the viewer",
  "faces the camera",
  "face the camera",
  "toward the camera",
  "towards the camera",
  "toward the lens",
  "towards the lens",
  "from the side",
  "side view",
  "side-on",
  "in profile",
  "profile view",
  "from behind",
  "from the back",
  "back view",
  "rear view",
  "back to the camera",
  "back toward the camera",
  "back towards the camera",
  "away from the camera",
  "three-quarter",
  "three-quarters",
  "over the shoulder",
  "over her shoulder",
  "over his shoulder",
  "over their shoulder",
  "over its shoulder",
  "high angle",
  "low angle",
  "eye level",
  "dutch angle",
  "bird's-eye",
  "worm's-eye",
  "top-down",
  "overhead view",
  "overhead shot",
  "aerial view",
  "aerial shot",
  "from above",
  "from below",
  "looking down",
  "looking up",
  "point of view",
  "pov",
  "first-person",
];

/** Negation words. */
export const NEGATION_TERMS: readonly string[] = [
  "no",
  "not",
  "without",
  "never",
  "none",
  "nothing",
  "nobody",
  "nowhere",
  "neither",
  "nor",
  "cannot",
  "can't",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "won't",
  "avoid",
  "avoids",
  "avoiding",
];

const VIEWPOINT_PHRASES = preparePhrases(VIEWPOINT_TERMS);
const NEGATION_PHRASES = preparePhrases(NEGATION_TERMS);

/** The viewpoint a shot's text states (the first term of the list it contains); null = it states none. */
export function statedViewpoint(text: string): string | null {
  return findPhrase(VIEWPOINT_PHRASES, withoutDialogue(text), true);
}

/** The first negation word (in list order) of a shot's text, dialogue not counted; null = none. */
export function negationWord(text: string): string | null {
  return findPhrase(NEGATION_PHRASES, withoutDialogue(text), true);
}

export type ViewpointId = "front" | "side" | "back" | "back-quarter" | "shoulder" | "high" | "low";

export interface Viewpoint {
  id: ViewpointId;
  /** What the chip writes into the shot line. */
  phrase: string;
}

export const VIEWPOINTS: readonly Viewpoint[] = [
  { id: "front", phrase: "seen from the front" },
  { id: "side", phrase: "seen from the side" },
  { id: "back", phrase: "seen from behind" },
  { id: "back-quarter", phrase: "seen from behind at a three-quarter angle" },
  { id: "shoulder", phrase: "framed over the shoulder" },
  { id: "high", phrase: "seen from a high angle looking down" },
  { id: "low", phrase: "seen from a low angle looking up" },
];

/** The chips' names (read when shown, in the current language). */
export function viewpointLabels(): Record<ViewpointId, string> {
  return {
    front: t("正面", undefined, { context: "viewpoint" }),
    side: t("側面", undefined, { context: "viewpoint" }),
    back: t("背影", undefined, { context: "viewpoint" }),
    "back-quarter": t("斜後方", undefined, { context: "viewpoint" }),
    shoulder: t("過肩", undefined, { context: "viewpoint" }),
    high: t("俯角", undefined, { context: "viewpoint" }),
    low: t("仰角", undefined, { context: "viewpoint" }),
  };
}
