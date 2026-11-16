// Classification tables: which attribute, property, variable or call names make a CJK string UI text, a logic key or a
// model input, and the translator context each position gets.
/** Properties named after a language (zh: …, en: …) hold content in that language (such as a Chinese sentence for a prompt), not UI text. */
export const LANGUAGE_KEY_RE = /^(zh|zh_?tw|zh_?hant|zhHant|zhTW|cn|en|ja|jp|ko)$/i;

/** JSX attributes that are not for people: wrapping them would change behavior or styling (CJK values go to review). */
export const NON_UI_ATTRS = new Set([
  "key", "className", "class", "id", "htmlFor", "style", "role", "type", "href", "src", "srcSet", "to", "rel",
  "target", "method", "action", "form", "lang", "dir", "tabIndex", "ref", "variant", "size", "tone", "kind", "as",
  "pattern", "accept", "autoComplete", "inputMode", "enterKeyHint", "viewBox", "d", "fill", "stroke", "xmlns", "path",
  "testId", "slot", "mimeType", "fontFamily",
]);
/** Attributes whose value is logic data (a key or a value to match): review. */
export const VALUE_ATTRS = new Set(["value", "defaultValue", "checkedValue", "match", "query", "search", "filter", "keyword", "keywords"]);
/** Download file names: translating them breaks nothing, but the name would follow the UI language, so a maintainer decides (review). */
export const FILENAME_ATTRS = new Set(["download", "filename", "fileName"]);

/** Object property name → the context that helps translators. */
export const PROP_CONTEXT = [
  [/^(aria|ariaLabel|ariaDescription|srLabel|srText|screenReader)/i, "aria"],
  [/(^|_)(placeholder)$/i, "placeholder"],
  [/(tooltip|^hint$|Hint$|^help$|Help$|^tip$|Tip$)/, "tooltip"],
  [/^(title|heading|subtitle|caption|header|headline)$|Title$|Heading$|Header$/, "title"],
  [/^(label|shortLabel|longLabel|name|displayName|text|short)$|Label$|Text$/, "label"],
  [/^(description|desc|detail|details|summary|explanation|note|notes|body|subtext|lead)$|Description$|Detail$|Summary$|Note$/, "description"],
  [/^(message|msg|error|problem|reason|warning|cause|why|blocked|disabledReason)$|Message$|Error$|Reason$|Problem$|Warning$/, "message"],
  [/^(empty|emptyText|emptyLabel|emptyTitle|none|noneLabel)$|^empty/i, "empty-state"],
  [/^confirm|Confirm$/, "confirm"],
  [/^(action|actionLabel|cta|button|buttonLabel|submitLabel|cancelLabel|okLabel)$/, "button"],
  [/^(unit|suffix|prefix)$/, "unit"],
];
/** Property names meaning "the value is a key or pattern to match": never wrapped automatically (CJK values here are mostly word lists or regexes). */
export const LOGIC_PROP_RE = /^(id|key|pattern|patterns|regex|re|alias|aliases|token|tokens|marker|markers|separator|delimiter|sep|needle|needles|word|words|term|terms|synonyms|stopwords|slug|path|route|url|href|lang|locale|source_re|match_re|signature|fingerprint)$/i;
/** Search keywords (command palette and the like): translated, but the code must match both the source and the translation, so they are not simply replaced. */
export const KEYWORD_PROP_RE = /^(keywords?|aliases?|searchTerms?|search)$/i;
/** Model inputs (instructions sent to the models): translating them would change what a model receives, so they are never wrapped automatically. */
export const MODEL_INPUT_NAME_RE = /(INSTRUCTION|SYSTEM_PROMPT|PROMPT_TEMPLATE|RUBRIC|NEGATIVE_PROMPT|^instruction$|^instructions$|^systemPrompt$|^system$|^rubric$|^negative_prompt$|^negativePrompt$)/;
/**
 * A label map of names or labels (LANGUAGE_LABELS = { en: "英文" }): a language key there names a language, so its value
 * is UI text, unlike a language-keyed value elsewhere (content in that language).
 */
export const NAME_MAP_RE = /(LABELS?|Labels?|NAMES|Names)$/;
/** Label maps (Record<id, display text>): the keys are ids and every value is UI text. */
export const LABEL_MAP_RE = /(LABELS?|Labels?|_TEXTS?$|Texts?$|NAMES$|Names$|TITLES?$|Titles?$|HINTS?$|Hints?$|DESCRIPTIONS?$|Descriptions?$|MESSAGES?$|Messages?$|COPY$|Copy$|HELP$|Help$|TOOLTIPS?$|Tooltips?$|CAPTIONS?$|Captions?$|SUMMAR(Y|IES)$|Summar(y|ies)$|EXPLAIN|Explain|FIELDS$|Fields$|COLUMNS$|Columns$|HEADINGS?$|Headings?$|PHRASES?$|Phrases?$|NOTES?$|Notes?$|REASONS?$|Reasons?$|STATUS_TEXT|SPEC$|SPECS$|Spec$|Specs$|META$|Meta$|INFO$|Info$|CATALOG$|Catalog$)/;
/** Variable names that look like a word list or pattern used for matching. */
export const LOGIC_NAME_RE = /(_PREFIX$|_SUFFIX$|^PREFIX|^SUFFIX|KEYWORD|PATTERN|REGEX|_RE$|^RE_|MARKER|ALIAS|TOKEN|SYNONYM|STOPWORD|SEPARATOR|DELIM|NEEDLE|TRIGGER_WORD|LEXICON|VOCAB|_WORDS?$|_TERMS?$|^WORDS?$|^TERMS?$|Keywords?$|Pattern$|Patterns$|Regex$|Markers?$|Aliases$|Tokens?$|Words?$|Terms?$|Synonyms$|Needles?$|Lexicon$|Vocab$|_SOURCE$|Source$)/;

/** Calls whose arguments are strings to match (never wrapped; CJK arguments go to review). */
export const LOGIC_METHODS = new Set([
  "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split", "replace", "replaceAll", "match", "matchAll",
  "search", "localeCompare", "has", "get", "delete", "test", "exec", "querySelector", "querySelectorAll",
  "getElementById", "closest", "matches", "getItem", "setItem", "removeItem", "getAttribute", "setAttribute", "parse",
  "trimStart", "trimEnd", "padStart", "padEnd", "at", "charAt", "codePointAt", "normalize", "encodeURIComponent",
  "decodeURIComponent", "RegExp", "fnmatch", "compare", "count", "countOf", "find", "findIndex", "some", "every",
]);
export const ALREADY_WRAPPED = new Set(["t", "tServer", "tError", "tPlural"]);
/** Calls whose arguments are messages for people (wrapped automatically, with these contexts). */
export const UI_CALLS = [
  [/^(notify|toast|pushToast|showToast|addToast|announce|flash)$/, "toast"],
  [/^(confirm|alert|prompt)$/, "confirm"],
  [/^(setError|setProblem|setWarning|fail|failure|invalid|reject|issue|problem|error|warn|blocked|blockReason|disabledBecause)$/, "message"],
  [/^(setMessage|setStatus|setNotice|setHint|setInfo|setTitle|setLabel|setCaption|setText|setSummary|setDetail|setReason|setPlaceholder)$/, "message"],
  [/^(push|unshift)$/, "message"],
  [/^join$/, "separator"],
  [/^use(State|Ref|Memo)$/, "default"],
];
export const ERROR_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ApiError", "ComponentError", "DOMException"]);

/** JSX element name → the context of its JSX text. */
export const TAG_CONTEXT = [
  [/^(button|.*Button|.*Btn)$/, "button"],
  [/^(h[1-6]|.*Title|.*Heading|PageHeader|DialogHeader|SectionTitle|EntityHeader|legend|caption|figcaption|summary)$/, "title"],
  [/^(label|Label|.*Label|FieldLabel|dt)$/, "label"],
  [/^(th|TableHead|.*HeadCell|SortHeader|.*ColumnHeader)$/, "column"],
  [/^(option|SelectItem|.*Option)$/, "option"],
  [/^(.*Tab|TabsTrigger|.*TabTrigger)$/, "tab"],
  [/^(.*MenuItem|.*Menu|li)$/, "menu-or-list"],
  [/^(.*Badge|.*Chip|.*Pill|.*Tag)$/, "badge"],
  [/^(a|Link|NavLink|.*Link)$/, "link"],
  [/^(.*Callout|.*Notice|.*Alert|.*Banner|.*Warning|.*Error.*)$/, "notice"],
  [/^(.*EmptyState|.*Empty)$/, "empty-state"],
  [/^(kbd|code|pre|samp)$/, "code"],
  [/^(p|span|div|small|strong|em|b|i|dd|td|section|article|header|footer|main|output)$/, "text"],
];

export function contextForTag(tag) {
  for (const [re, ctx] of TAG_CONTEXT) if (re.test(tag)) return ctx;
  return "text";
}

export function contextForProp(name) {
  for (const [re, ctx] of PROP_CONTEXT) if (re.test(name)) return ctx;
  return "text";
}

export function contextForAttr(name) {
  if (name.startsWith("aria-")) return "aria";
  if (name === "title") return "tooltip";
  if (name === "placeholder") return "placeholder";
  if (name === "alt") return "alt";
  if (name === "label") return "label";
  return contextForProp(name) === "text" ? `prop:${name}` : contextForProp(name);
}
