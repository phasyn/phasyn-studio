// Shared constants of the i18n tooling: the TypeScript compiler API, paths and the character classes the scanner uses.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** The repo's TypeScript (apps/frontend/node_modules); only the compiler API, no type checking. */
export const ts = require("typescript");

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SRC_ROOT = join(APP_ROOT, "src");

/** CJK text or full-width punctuation (including 、。「」（）：； and Japanese kana). */
export const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[\u{20000}-\u{2fa1f}]/u;
/** Han characters or kana: tells real text from format strings that only have full-width punctuation. */
export const HAN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\u{20000}-\u{2fa1f}]/u;

/** Separates a homograph's context from its source text (catalog key = `<context>` + U+0004 + `<source>`, as in src/i18n/message.ts). */
export const CONTEXT_SEPARATOR = String.fromCharCode(4);

/** A string that looks like a regex or a character set ((?:…), [ \t]*, \d, ^…$, a symbols-only [：:]) is matching logic, not UI text. */
const REGEX_LIKE_RE = /\(\?[:=!<]|\[\^|\\[dDsSwWbB]|\][*+?{]|\)[*+?{]|^\^|\$$/;
export function regexLike(text) {
  if (REGEX_LIKE_RE.test(text)) return true;
  const charClass = /^\[([^\]]+)\]$/.exec(text);
  return Boolean(charClass && !/[\p{L}\p{N}]/u.test(charClass[1]));
}

/** Separators of UI lists built with join(): the codemod rewrites them to formatList (the zh-Hant output is unchanged). */
export const LIST_SEPARATORS = new Set(["、", "，", "／"]);
