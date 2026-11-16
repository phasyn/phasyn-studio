// Message text helpers: placeholder names for interpolated expressions, JSX text whitespace rules and the placeholders
// and plural hints of a source string.
import { CJK_RE, ts } from "./core.mjs";
import { calleeInfo } from "./ast.mjs";

const FORMATTER_RE = /^(format|fmt|short|display|label|text|describe|humanize|pretty|to|as|render)[A-Z]?|^(String|Number|Math\.\w+)$/;

function rawPlaceholderName(expr, sf) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const last = e.name.text;
    if (["length", "size"].includes(last)) {
      const base = rawPlaceholderName(e.expression, sf);
      return base ? `${base}Count` : "count";
    }
    return last;
  }
  if (ts.isElementAccessExpression(e)) {
    // LABELS[x.sigma] → sigma (a label map's value is named by its index); rows[i] → rows
    const obj = rawPlaceholderName(e.expression, sf);
    if (obj && (/^[A-Z][A-Z0-9_]*$/.test(obj) || /(Labels?|Names|Texts?|Titles?)$/.test(obj))) {
      const idx = rawPlaceholderName(e.argumentExpression, sf);
      if (idx && idx !== "value" && idx !== "text") return idx;
    }
    return obj ?? "value";
  }
  if (ts.isCallExpression(e)) {
    const callee = calleeInfo(e.expression, sf);
    const args = e.arguments;
    if (callee.full.endsWith(".join") && ts.isPropertyAccessExpression(e.expression)) return rawPlaceholderName(e.expression.expression, sf) ?? "list";
    const TRANSFORM = ["toFixed", "toLocaleString", "toString", "slice", "substring", "trim", "trimEnd", "trimStart", "toUpperCase", "toLowerCase", "padStart", "padEnd", "replace", "replaceAll", "at", "toPrecision", "valueOf", "normalize"];
    if (ts.isPropertyAccessExpression(e.expression) && TRANSFORM.includes(e.expression.name.text)) {
      return rawPlaceholderName(e.expression.expression, sf) ?? "value";
    }
    if (args.length >= 1 && (FORMATTER_RE.test(callee.name) || args.length === 1)) {
      const fromArg = rawPlaceholderName(args[0], sf);
      if (fromArg && fromArg !== "value") return fromArg;
    }
    return callee.name === "?" || callee.name === "[]" ? "value" : callee.name;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(op)) {
      return rawPlaceholderName(e.left, sf) ?? "value";
    }
    return "value";
  }
  if (ts.isConditionalExpression(e)) return "value";
  if (ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isStringLiteral(e)) return "text";
  if (ts.isNumericLiteral(e)) return "n";
  return "value";
}

/** A valid placeholder name ({name}): only [A-Za-z0-9_], UPPER_SNAKE becomes camelCase, repeats within a message get a number. */
export function placeholderNames(exprs, sf) {
  const used = new Map();
  return exprs.map((expr) => {
    let base = (rawPlaceholderName(expr, sf) ?? "value").replace(/[^A-Za-z0-9_]/g, "");
    if (/^[A-Z][A-Z0-9_]*$/.test(base) && base.length > 1) base = base.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (!base || /^\d/.test(base)) base = `v${base}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  });
}

const ENTITIES = { "&nbsp;": String.fromCharCode(160), "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };

function decodeEntities(text) {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** JSX text whitespace as TypeScript and Babel apply it: trim around line breaks, drop blank lines, join lines with one space. */
export function jsxTextValue(raw) {
  let acc;
  let first = 0;
  let last = -1;
  const add = (line) => {
    const decoded = decodeEntities(line);
    acc = acc === undefined ? decoded : `${acc} ${decoded}`;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\n" || c === "\r") {
      if (first !== -1 && last !== -1) add(raw.slice(first, last + 1));
      first = -1;
    } else if (c !== " " && c !== "\t") {
      last = i;
      if (first === -1) first = i;
    }
  }
  if (first !== -1) add(raw.slice(first));
  return acc ?? "";
}

/** Whether a JSX expression child is simple enough to merge into the message as a placeholder. */
export function simpleJsxExpression(expr, sf) {
  if (!expr) return false;
  let hasJsx = false;
  let hasCjk = false;
  const visit = (n) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CJK_RE.test(n.text)) hasCjk = true;
    if (ts.isTemplateExpression(n) && CJK_RE.test(n.getText(sf))) hasCjk = true;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return !hasJsx && !hasCjk;
}

/** The {name} placeholders of a source text (in order of appearance, without repeats). */
export function placeholdersIn(source) {
  const out = [];
  for (const match of source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

/** Whether English likely needs plural forms: a placeholder looks like a count and the source has a measure word (or the count is directly followed by an English noun, as in "{takesCount} take"). */
export function pluralHint(source, placeholders) {
  const countLike = placeholders.filter((p) => /^(n|count|total|num|number|length|size|matched|remaining|selected|missing|done|failed|minutes|hours|days|seconds)$|Count$|_count$|Total$|s$/.test(p));
  if (countLike.length === 0) return false;
  if (/[個張項筆次段幀秒鏡條組份位台件頁行列欄步種處則字天]|分鐘|小時/.test(source)) return true;
  return countLike.some((p) => new RegExp(`\\{${p}\\}\\s*[A-Za-z]`).test(source));
}
