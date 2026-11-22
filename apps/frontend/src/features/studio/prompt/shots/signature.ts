// A subject's signature (pure): the features every shot line restates. A
// shot line that names <Subject N> without her features lets H3 draw the original character back in fast-action shots,
// so each line repeats the hair colour and one accessory. The phrase comes from the subject's definition: the clause
// that names the hair (or "pink-haired", "blond") and one accessory, head and face first because those stay in a
// close-up; never a negated clause ("no wings": H3 draws what a prompt names). English definitions only; any other
// language gives no phrase and the dialog lets the person write one. The check words are the phrase's own words.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SPLIT_RE = /\s*[,;]\s*|\s+(?:and|with|wearing|featuring|preserving|plus|who\s+has|has|have)\s+/i;
const LEAD_RE = /^(?:(?:and|or|with|plus|wearing|featuring|preserving|has|have)\s+)+/i;
const POSSESSIVE_RE = /^(?:his|her|its|their)\s+/i;
const NEGATION_RE = /\b(?:no|not|without|never|none)\b/i;

/** The noun hair or a hairstyle; a hair clip or ribbon is an accessory, not the hair. */
const HAIR_RE =
  /\bhair\b(?![ -]?(?:clips?|pins?|ornaments?|bands?|ties?|ribbons?|accessory|accessories|sticks?|combs?|flowers?|bows?)\b)|\b(?:hairstyle|ponytails?|pigtails?|braids?|twin[ -]?tails|twintails|buns?)\b/i;
const HAIRED_RE = /\b([a-z]+(?:-[a-z]+)*?)-haired\b/i;
const HAIR_COLOUR_RE = /\b(blonde?|brunette|redhead(?:ed)?|red-headed)\b/i;
const HAIR_COLOUR: Readonly<Record<string, string>> = {
  blond: "blond hair",
  blonde: "blonde hair",
  brunette: "brown hair",
  redhead: "red hair",
  redheaded: "red hair",
  "red-headed": "red hair",
};
const HAIR_TAIL_RE = /\s+(?:tied|worn|styled|pulled|gathered|done|held|kept|fastened|swept)(?:\s+(?:up|back|together|aside|down))?$/i;

/** Accessories in order of preference: what stays in a close-up (hair, head, face) first. */
const ACCESSORIES: readonly RegExp[] = [
  /\bhair[ -]?(?:clips?|pins?|ornaments?|bands?|ties?|ribbons?|accessory|accessories|sticks?|combs?|flowers?|bows?)\b|\bhair(?:clips?|pins?|bands?)\b|\b(?:barrettes?|scrunchies?|kanzashi)\b/i,
  /\b(?:hats?|caps?|berets?|hoods?|helmets?|crowns?|tiaras?|circlets?|headbands?|headpieces?|headdress(?:es)?|veils?|halos?)\b/i,
  /\b(?:ribbons?|bows?|ornaments?|horns?|horned)\b/i,
  /\b(?:glasses|spectacles|goggles|monocles?|eye[ -]?patch(?:es)?|masks?|earrings?|headphones|headsets?)\b/i,
  /\b(?:scarf|scarves|mufflers?|chokers?|necklaces?|pendants?|collars?|neckties?|bow[ -]?ties?|ties?|bandanas?|capes?|cloaks?|mantles?|shawls?)\b/i,
  /\b(?:gloves?|gauntlets?|bracelets?|wristbands?|armbands?|belts?|sash(?:es)?|badges?|brooch(?:es)?|amulets?|talismans?|wings?)\b/i,
];

/** Words a noun phrase does not reach back over. */
const BOUNDARY = new Set(["in", "on", "of", "with", "and", "or", "wearing", "has", "have", "who", "that", "which", "is", "are", "at", "by", "for", "from", "to", "under", "over", "holding", "carrying"]);
const DETERMINER_RE = /^(?:a|an|the|his|her|its|their|one|two|three|\d+|pair|pairs|set)$/i;

/** Words that do not tell one character from another. */
const STOP = new Set([
  "the", "with", "and", "her", "his", "its", "their", "into", "long", "short", "medium", "small", "big", "large", "little", "tiny",
  "hair", "haired", "eye", "eyes", "wearing", "tied", "worn", "styled", "shaped", "colored", "coloured", "light", "dark", "pale",
  "bright", "deep", "high", "low", "one", "two", "pair", "set", "loose", "straight",
]);

/** The definition without what is not appearance: the reference picture, the white-background sentence, "preserving her facial identity". */
function appearanceOf(definition: string): string {
  return (
    definition
      // The sentence about the reference picture (white background, crop, pose)
      .replace(/[.;]\s*(?:@Image[1-9][0-9]?|<Picture[ \t]*\d{1,3}>)\s+is\b[\s\S]*$/i, "")
      // The swap wizard's ", providing the face, hairstyle, costume, and accessories exactly as drawn"
      .replace(/,?\s*providing\s+the\s+face\b[^.;]*/i, "")
      // "in @Image1", "shown in <Picture 1>"
      .replace(/\s*,?\s*(?:(?:shown|seen|drawn|depicted|pictured)\s+)?(?:in|from|by)\s+(?:@Image[1-9][0-9]?|<Picture[ \t]*\d{1,3}>)/gi, "")
      .replace(/\bpreserving\s+(?:his|her|its|their)\s+facial\s+identity\s*,?\s*(?:and\s+)?/i, "")
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:the|a|an)\s+/i, "")
      .replace(/[\s.,;:]+$/, "")
      .trim()
  );
}

function clausesOf(appearance: string): string[] {
  return appearance
    .split(SPLIT_RE)
    .map((clause) => clause.replace(LEAD_RE, "").replace(POSSESSIVE_RE, "").trim())
    .filter((clause) => clause !== "" && !NEGATION_RE.test(clause));
}

/** The first match that is a word or a compound's last part ("side-ponytail"), not a compound's first part ("crown-shaped"). */
function nounMatch(pattern: RegExp, clause: string): RegExpExecArray | null {
  for (const match of clause.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
    if (clause.charAt(match.index + match[0].length) !== "-") return match;
  }
  return null;
}

/** The clause when it is short, else the words just before the match (back to an article or a preposition) and the match. */
function phraseAround(clause: string, match: RegExpExecArray, limit: number): string {
  const words = clause.split(/\s+/);
  if (words.length <= limit) return clause;
  // The words the match starts and ends in (it can start inside one: "side-ponytail")
  const first = clause.slice(0, match.index).split(/\s+/).length - 1;
  const last = clause.slice(0, match.index + match[0].length).trimEnd().split(/\s+/).length;
  let from = first;
  while (from > 0 && first - from < 4) {
    const word = (words[from - 1] ?? "").toLowerCase();
    if (BOUNDARY.has(word)) break;
    from -= 1;
    if (DETERMINER_RE.test(word)) break;
  }
  return words.slice(from, last).join(" ");
}

function withArticle(phrase: string): string {
  const words = phrase.split(/\s+/);
  const last = words.at(-1) ?? "";
  if (DETERMINER_RE.test(words[0] ?? "") || (/s$/i.test(last) && !/ss$/i.test(last))) return phrase;
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

function hairPhrase(clauses: readonly string[], appearance: string): string {
  for (const clause of clauses) {
    const match = nounMatch(HAIR_RE, clause);
    if (match) return phraseAround(clause, match, 8).replace(HAIR_TAIL_RE, "");
  }
  const haired = HAIRED_RE.exec(appearance)?.[1];
  if (haired != null && haired !== "") return `${haired.toLowerCase()} hair`;
  const colour = HAIR_COLOUR_RE.exec(appearance)?.[1];
  return (colour != null && colour !== "") ? (HAIR_COLOUR[colour.toLowerCase()] ?? "") : "";
}

function accessoryPhrase(clauses: readonly string[]): string {
  for (const pattern of ACCESSORIES) {
    for (const clause of clauses) {
      const match = nounMatch(pattern, clause);
      if (!match) continue;
      return /^horned$/i.test(match[0]) ? "horns" : withArticle(phraseAround(clause, match, 6));
    }
  }
  return "";
}

/** "with long pink hair and a gold hair clip": what a subject chip inserts after <Subject N>; "" when the definition names neither. */
export function signaturePhrase(definition: string): string {
  const appearance = appearanceOf(definition);
  if (appearance === "" || CJK_RE.test(appearance)) return "";
  const clauses = clausesOf(appearance);
  const hair = hairPhrase(clauses, appearance);
  const found = accessoryPhrase(clauses);
  // The hair clause can already carry the accessory ("long pink hair tied in a red ribbon")
  const accessory = found !== "" && hair.toLowerCase().includes(found.replace(/^(?:an?|the)\s+/i, "").toLowerCase()) ? "" : found;
  const parts = [hair, accessory].filter((part) => part !== "");
  return parts.length === 0 ? "" : `with ${parts.join(" and ")}`;
}

/** Lower-case word stems of a text (a plural s dropped), for comparing words: "Horns" and "horn" are the same word. */
export function wordStems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/** The words of a signature phrase that can tell the character apart (not "with", "long", "hair"…). */
export function signatureWords(phrase: string): string[] {
  return [...new Set(wordStems(phrase).filter((word) => !STOP.has(word)))];
}

/** Each list without the words another list has too (two silver-haired characters share "silver"), unless that empties it. */
export function distinctWords(lists: readonly (readonly string[])[]): string[][] {
  return lists.map((words, index) => {
    const others = new Set(lists.flatMap((other, at) => (at === index ? [] : other)));
    const own = words.filter((word) => !others.has(word));
    return own.length > 0 ? own : [...words];
  });
}
