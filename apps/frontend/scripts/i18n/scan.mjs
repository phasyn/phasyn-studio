// Scans one source file for user-visible CJK strings and classifies each site (wrap / skip / review / wrapped), the shared
// core of i18n-extract (dry run), i18n-codemod (--apply) and i18n-check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { i18nAliases, jsxTagName } from "./ast.mjs";
import { classify } from "./classify.mjs";
import { APP_ROOT, CJK_RE, CONTEXT_SEPARATOR, HAN_RE, ts } from "./core.mjs";
import { ALREADY_WRAPPED, contextForTag } from "./rules.mjs";
import { jsxTextValue, placeholderNames, placeholdersIn, simpleJsxExpression } from "./text.mjs";

/**
 * Scans one file and returns its sites:
 *  { kind, decision: "wrap"|"skip"|"review", reason, source, placeholders, exprs, line, start, end, context, notes, file }
 *  - kind: string (a string literal), template (a template literal), jsx-text (JSX text, possibly with merged {expr})
 *  - source: the zh-Hant source text for t() (expressions of a template or JSX text become {name})
 */
export function scanSource(text, rel, options = {}) {
  const sf = options.sourceFile ?? ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split("\n");
  const sites = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  // i18n-ignore: on the same or the previous line; between i18n-ignore-start and i18n-ignore-end; i18n-ignore-file in
  // the first 5 lines = the whole file
  const blocked = new Set();
  let inBlock = false;
  lines.forEach((line, index) => {
    if (/i18n-ignore-start/.test(line)) inBlock = true;
    if (inBlock) blocked.add(index + 1);
    if (/i18n-ignore-end/.test(line)) inBlock = false;
  });
  const ignoreFile = lines.slice(0, 5).some((line) => /i18n-ignore-file/.test(line));
  const ignored = (pos) => {
    if (ignoreFile) return true;
    const ln = lineOf(pos);
    if (blocked.has(ln)) return true;
    return /i18n-ignore(?!-)/.test(lines[ln - 1] ?? "") || /\/\/\s*i18n-ignore(?!-)/.test(lines[ln - 2] ?? "");
  };
  const aliases = i18nAliases(sf, rel);
  const canonicalCallee = (expr) => {
    const name = ts.isIdentifier(expr) ? expr.text : null;
    if (!name) return null;
    return aliases.get(name) ?? (ALREADY_WRAPPED.has(name) ? name : null);
  };
  const add = (site) => {
    if (ignored(site.start) && site.decision !== "skip" && site.decision !== "wrapped") {
      site.decision = "skip";
      site.reason = "i18n-ignore";
    }
    sites.push({ file: rel, line: lineOf(site.start), notes: [], ...site });
  };

  const classifyNode = (node) => classify(node, { sf, rel, aliases, canonicalCallee });

  const templateParts = (node) => {
    const exprs = node.templateSpans.map((s) => s.expression);
    const names = placeholderNames(exprs, sf);
    let source = node.head.text;
    node.templateSpans.forEach((span, i) => {
      source += `{${names[i]}}${span.literal.text}`;
    });
    return { source, names, exprs };
  };

  /**
   * A concatenation chain a + "…" + b: flattens the left-associative spine. The operands before the first string
   * operand (possibly a numeric sum) form one expression; every + after it concatenates strings, so the whole chain
   * equals one template literal and can safely become a single t("…{b}…", { b }).
   */
  const isPlus = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const concatChain = (top) => {
    const operands = [];
    let cur = top;
    while (isPlus(cur)) {
      operands.unshift(cur.right);
      cur = cur.left;
    }
    operands.unshift(cur);
    const isText = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
    const firstText = operands.findIndex(isText);
    if (firstText < 0) return null;
    const pieces = []; // { text } | { expr, group }
    if (firstText > 1) pieces.push({ group: operands.slice(0, firstText) });
    else if (firstText === 1) pieces.push({ expr: operands[0] });
    for (const op of operands.slice(firstText)) {
      if (ts.isStringLiteral(op) || ts.isNoSubstitutionTemplateLiteral(op)) pieces.push({ text: op.text });
      else if (ts.isTemplateExpression(op)) {
        pieces.push({ text: op.head.text });
        for (const span of op.templateSpans) {
          pieces.push({ expr: span.expression });
          pieces.push({ text: span.literal.text });
        }
      } else pieces.push({ expr: op });
    }
    const exprNodes = pieces.filter((p) => p.expr || p.group).map((p) => p.expr ?? p.group[0]);
    const names = placeholderNames(exprNodes, sf);
    let k = 0;
    let source = "";
    const exprTexts = [];
    for (const p of pieces) {
      if (p.text !== undefined) source += p.text;
      else {
        source += `{${names[k++]}}`;
        exprTexts.push(p.group ? `(${p.group.map((g) => g.getText(sf)).join(" + ")})` : p.expr.getText(sf));
      }
    }
    const literalText = pieces.filter((p) => p.text !== undefined).map((p) => p.text).join("");
    return { source, names, exprs: exprTexts, literalText, operands, pieces };
  };
  const coveredByChain = new Set();

  /**
   * JSX children.
   *  - One run of text (with simple {expr}) whose siblings carry no text (icons, inputs…): a plain message,
   *    {t("…{x}…", { x })}.
   *  - Text interleaved with elements or expressions that carry text (rich text): the whole sentence is one message;
   *    inline elements become numbered tags, as in "顯示 <0>{shown}</0>／<1>{total}</1> 個 instance", elements
   *    without text become <n/> and complex expressions {name} (React nodes). The codemod rewrites it to
   *    <T source="…" values={{…}} slots={[…]} />, and a translation may reorder the tags.
   * Inline elements merged into a parent message are recorded in `consumed` and produce no message of their own.
   */
  const consumed = new Set();
  const isBlankText = (n) => ts.isJsxText(n) && jsxTextValue(n.text).trim() === "";
  const isComment = (n) => ts.isJsxExpression(n) && !n.expression;
  const hasText = (n) => {
    if (ts.isJsxText(n)) return jsxTextValue(n.text).trim() !== "";
    if (ts.isJsxExpression(n)) return Boolean(n.expression) && !ts.isJsxElement(n.expression) && !ts.isJsxSelfClosingElement(n.expression);
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) return n.children.some(hasText);
    return false;
  };
  /** An inline element can be a slot when its children are only text, simple {expr} and comments. */
  const simpleInner = (el) => ts.isJsxElement(el) && el.children.every((c) => ts.isJsxText(c) || isComment(c) || (ts.isJsxExpression(c) && simpleJsxExpression(c.expression, sf)));
  const elementName = (el) => {
    const tagText = jsxTagName(el, sf).replace(/[^A-Za-z0-9]/g, "");
    return tagText ? tagText[0].toLowerCase() + tagText.slice(1) : "node";
  };

  const handleJsxChildren = (owner) => {
    if (consumed.has(owner)) return;
    const tag = jsxTagName(owner, sf);
    const kids = owner.children.filter((c) => !isComment(c));
    if (!kids.some((c) => ts.isJsxText(c) && !isBlankText(c))) return; // no direct text: each child element handles its own
    const first = kids.findIndex(hasText);
    let last = -1;
    kids.forEach((c, i) => {
      if (hasText(c)) last = i;
    });
    if (first < 0) return;
    const span = kids.slice(first, last + 1);
    const exprHasJsx = (expr) => {
      let hit = false;
      const v = (n) => {
        if (hit) return;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hit = true;
        else ts.forEachChild(n, v);
      };
      if (expr) v(expr);
      return hit;
    };
    const plain = span.every((c) => ts.isJsxText(c) || (ts.isJsxExpression(c) && !exprHasJsx(c.expression)));

    // Placeholders in order of appearance (names unique within the message)
    const valueNodes = [];
    const pieces = [];
    const slots = [];
    for (const c of span) {
      if (ts.isJsxText(c)) pieces.push({ text: jsxTextValue(c.text) });
      else if (ts.isJsxExpression(c)) {
        valueNodes.push(c.expression);
        pieces.push({ value: c.expression, node: exprHasJsx(c.expression) });
      } else if (ts.isJsxSelfClosingElement(c)) {
        pieces.push({ slot: slots.length, self: true });
        slots.push({ node: c, self: true });
      } else if (ts.isJsxElement(c) && simpleInner(c)) {
        const inner = [];
        for (const ic of c.children) {
          if (ts.isJsxText(ic)) inner.push({ text: jsxTextValue(ic.text) });
          else if (ts.isJsxExpression(ic) && ic.expression) {
            valueNodes.push(ic.expression);
            inner.push({ value: ic.expression });
          }
        }
        pieces.push({ slot: slots.length, inner });
        slots.push({ node: c, self: false });
      } else {
        valueNodes.push(c);
        pieces.push({ value: c, node: true });
      }
    }
    const names = placeholderNames(valueNodes, sf).map((n, i) => (ts.isJsxElement(valueNodes[i]) || ts.isJsxSelfClosingElement(valueNodes[i]) || ts.isJsxFragment(valueNodes[i]) ? null : n));
    // A JSX element used as a value is named after its tag
    const used = new Set(names.filter(Boolean));
    valueNodes.forEach((v, i) => {
      if (names[i]) return;
      let base = ts.isJsxFragment(v) ? "fragment" : elementName(v);
      let n = base;
      let k = 2;
      while (used.has(n)) n = `${base}${k++}`;
      used.add(n);
      names[i] = n;
    });
    const nameOf = new Map(valueNodes.map((v, i) => [v, names[i]]));
    const render = (list) => list.map((p) => (p.text !== undefined ? p.text : `{${nameOf.get(p.value)}}`)).join("");
    let source = pieces
      .map((p) => {
        if (p.text !== undefined) return p.text;
        if (p.value) return `{${nameOf.get(p.value)}}`;
        if (p.self) return `<${p.slot}/>`;
        return `<${p.slot}>${render(p.inner)}</${p.slot}>`;
      })
      .join("");
    const outer = source.length !== source.trim().length;
    source = source.trim();
    const literal = pieces.map((p) => (p.text !== undefined ? p.text : p.inner ? p.inner.map((q) => q.text ?? "").join("") : "")).join("");
    if (!CJK_RE.test(literal)) return;
    for (const sl of slots) if (!sl.self) consumed.add(sl.node);
    const rich = !plain;
    // Replaced range: the first non-blank character of the first text → the last non-blank character of the last text
    // (outer whitespace stays in place and React still renders it)
    const edgeStart = (node) => {
      if (!ts.isJsxText(node)) return node.getStart(sf);
      const raw = sf.text.slice(node.pos, node.end);
      return node.pos + (raw.length - raw.trimStart().length);
    };
    const edgeEnd = (node) => {
      if (!ts.isJsxText(node)) return node.getEnd();
      const raw = sf.text.slice(node.pos, node.end);
      return node.end - (raw.length - raw.trimEnd().length);
    };
    add({
      kind: rich ? "jsx-rich" : "jsx-text",
      decision: "wrap",
      reason: rich ? "jsx-rich-text" : "jsx-text",
      source,
      placeholders: names,
      exprs: valueNodes.map((v) => v.getText(sf)),
      slots: slots.map((sl) => (sl.self ? `<${jsxTagName(sl.node, sf)}/>` : `<${jsxTagName(sl.node, sf)}>`)),
      jsx: { owner, span, pieces, slotNodes: slots.map((sl) => sl.node), valueNodes, names, rich },
      start: edgeStart(span[0]),
      end: edgeEnd(span[span.length - 1]),
      context: rich ? "rich-text" : contextForTag(tag),
      notes: [`<${tag}>`, ...(rich ? ["rich-text"] : []), ...(outer ? ["outer-whitespace"] : [])],
    });
  };

  /** Comparisons of display text (x.label === y, title !== "…"): the sides may differ after translation, so review. */
  const DISPLAY_OPERAND_RE = /(^|\.)(label|title|summary|caption|message|hint|description|displayName|text|note|notes|reason|problem)$/;
  const EQ_OPS = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
  const checkDisplayComparison = (node) => {
    if (!ts.isBinaryExpression(node) || !EQ_OPS.includes(node.operatorToken.kind)) return;
    const sides = [node.left, node.right].map((e) => e.getText(sf));
    if (!sides.some((t) => DISPLAY_OPERAND_RE.test(t))) return;
    if (sides.some((t) => /^(null|undefined|""|''|``|\d+|true|false)$/.test(t))) return;
    if ([node.left, node.right].some((e) => ts.isStringLiteral(e) && !CJK_RE.test(e.text))) return;
    add({ kind: "compare", decision: "review", reason: "compares-display-text", context: "logic-key", source: node.getText(sf), placeholders: [], exprs: [], start: node.getStart(sf), end: node.getEnd(), notes: [] });
  };

  const visit = (node) => {
    checkDisplayComparison(node);
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) handleJsxChildren(node);
    if (isPlus(node) && !(node.parent && isPlus(node.parent) && node.parent.left === node)) {
      const chain = concatChain(node);
      if (chain && CJK_RE.test(chain.literalText)) {
        for (const op of chain.operands) {
          if (ts.isStringLiteral(op) || ts.isNoSubstitutionTemplateLiteral(op) || ts.isTemplateExpression(op)) coveredByChain.add(op);
        }
        const cls = classifyNode(node);
        add({
          kind: "concat",
          source: chain.source,
          placeholders: chain.names,
          exprs: chain.exprs,
          chainPieces: chain.pieces,
          start: node.getStart(sf),
          end: node.getEnd(),
          node,
          ...cls,
          notes: [...cls.notes, "rewrite-concatenation"],
        });
      }
    }
    if (coveredByChain.has(node)) {
      // Already part of a whole concatenation chain's message; only look for strings nested in its expressions
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) ts.forEachChild(span, visit);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK_RE.test(node.text)) {
        const cls = classifyNode(node);
        const bareJsxAttr = Boolean(node.parent && ts.isJsxAttribute(node.parent));
        // A wrapped string with a context: its catalog key is `<context>\u0004<source>`
        const source = cls.msgctxt ? `${cls.msgctxt}${CONTEXT_SEPARATOR}${node.text}` : node.text;
        add({ kind: "string", source, placeholders: cls.decision === "wrapped" ? placeholdersIn(node.text) : [], exprs: [], start: node.getStart(sf), end: node.getEnd(), node, bareJsxAttr, ...cls });
      }
    } else if (ts.isTemplateExpression(node)) {
      const parts = templateParts(node);
      const literalText = node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
      if (CJK_RE.test(literalText)) {
        const cls = classifyNode(node);
        add({
          kind: "template",
          source: parts.source,
          placeholders: parts.names,
          exprs: parts.exprs.map((e) => e.getText(sf)),
          exprNodes: parts.exprs,
          start: node.getStart(sf),
          end: node.getEnd(),
          node,
          ...cls,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const site of sites) {
    if (site.decision !== "skip" && /^(Image )?Studio：/.test(site.source)) {
      site.context = "run-label";
      site.notes.push("run-label: keep 'Studio：'/'Image Studio：' prefix and every '・' (recordsTree.ts parses them)");
    }
    if (site.decision !== "skip" && site.source.includes("[TODO:")) {
      site.context = "prompt-template";
      site.notes.push("prompt-template: translate only inside [TODO: …]; keep H3 syntax, tags and English skeleton");
    }
    site.punctOnly = !HAN_RE.test(site.source);
    if (site.decision === "wrap" && site.punctOnly && site.context !== "separator") site.notes.push("punctuation-only");
  }
  return { sites, sourceFile: sf };
}

/** Reads and scans one file (rel is relative to apps/frontend). */
export function scanFile(rel) {
  const text = readFileSync(join(APP_ROOT, rel), "utf8");
  return scanSource(text, rel).sites;
}
