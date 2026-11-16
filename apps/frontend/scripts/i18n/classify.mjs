// Decides what a CJK string literal or template is from its syntactic position: wrap (UI text the codemod wraps in t()),
// skip (types, keys, console…), review (needs a human), wrapped / dynamic (already translated or matched at run time).
import { ancestry, calleeInfo, climb, contextOfCall, contextOfJsx, holderOf, jsxTagName, nameText, stringUsedAsMatcher, usedAsMatcher } from "./ast.mjs";
import { CJK_RE, LIST_SEPARATORS, regexLike, ts } from "./core.mjs";
import { overrideFor } from "./files.mjs";
import {
  contextForAttr,
  contextForProp,
  contextForTag,
  ERROR_CTORS,
  FILENAME_ATTRS,
  KEYWORD_PROP_RE,
  LANGUAGE_KEY_RE,
  LOGIC_METHODS,
  LOGIC_NAME_RE,
  LOGIC_PROP_RE,
  NAME_MAP_RE,
  NON_UI_ATTRS,
  UI_CALLS,
  VALUE_ATTRS,
} from "./rules.mjs";

/**
 * What a string (or template) is used for, from its syntactic position → decision / context.
 * ctx: { sf, rel, aliases, canonicalCallee } of the file being scanned.
 */
export function classify(node, ctx) {
  const { sf, rel, aliases, canonicalCallee } = ctx;
  // Strings already inside t() come first (overrides only decide unwrapped strings; nothing is wrapped twice)
  const direct = node.parent;
  if (direct && ts.isCallExpression(direct) && direct.arguments[0] === node && ["t", "translateRaw"].includes(canonicalCallee(direct.expression))) {
    if (ts.isTemplateExpression(node)) return { decision: "review", reason: "t-template-arg", context: "logic-key", notes: [] };
    const outer = classify(direct, ctx);
    return { decision: "wrapped", reason: "already-wrapped", context: outer.context, notes: outer.notes, msgctxt: contextOfCall(direct) };
  }
  const ov = overrideFor(rel, node);
  if (ov) return { decision: ov.decision, reason: ov.reason, context: ov.context ?? "text", notes: [] };
  const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : node.getText(sf);
  if (/\[[a-z][a-z-]*[\^$*~|]?=/.test(literal)) return { decision: "review", reason: "css-selector", context: "logic-key", notes: [] };
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && regexLike(literal)) return { decision: "review", reason: "regex-like", context: "logic-key", notes: [] };
  const { child, parent, via } = climb(node);
  const notes = via.includes("as-const") ? ["as-const"] : [];
  const res = (decision, reason, context = "text", extra = []) => ({ decision, reason, context, notes: [...notes, ...extra] });
  if (!parent) return res("review", "orphan");

  // Wrapped: t("source") / tServer("…"); the key of t(`…${x}`) is only built at run time and never found (an error)
  if (ts.isCallExpression(parent) && parent.arguments[0] === child) {
    const canonical = canonicalCallee(parent.expression);
    if (canonical === "t" || canonical === "translateRaw") {
      if (ts.isTemplateExpression(node)) return res("review", "t-template-arg", "logic-key");
      const outer = classify(parent, ctx);
      return { decision: "wrapped", reason: "already-wrapped", context: outer.context, notes: outer.notes, msgctxt: contextOfCall(parent) };
    }
    if (canonical === "tServer" || canonical === "tError" || canonical === "tPlural") return res("skip", "already-wrapped");
  }
  // Type positions, import / export, object keys, case labels
  if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) {
    return res("skip", "type-or-module");
  }
  if (ts.isImportTypeNode?.(parent)) return res("skip", "type-or-module");
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === child) {
    return res(CJK_RE.test(child.text ?? "") ? "review" : "skip", "object-key-cjk", "logic-key");
  }
  if (ts.isComputedPropertyName(parent)) return res("review", "computed-key-cjk", "logic-key");
  if (ts.isCaseClause(parent)) return res("review", "case-label-cjk", "logic-key");
  if (ts.isEnumMember(parent)) return res("review", "enum-member", "logic-key");
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) return res("review", "element-key-cjk", "logic-key");
  if (ts.isTaggedTemplateExpression(parent)) {
    const tag = calleeInfo(parent.tag, sf).full;
    return res(tag === "String.raw" ? "review" : "review", `tagged-template:${tag}`, "logic-key");
  }

  // Comparisons and concatenation
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const cmp = [
      ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword,
    ];
    if (cmp.includes(op)) return res("review", "comparison-operand", "logic-key");
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) return res("review", "concatenation", "fragment");
    if (op === ts.SyntaxKind.EqualsToken) {
      const target = parent.left.getText(sf);
      if (/(^|\.)(title|textContent|innerText|placeholder|ariaLabel|label|message)$/.test(target)) return res("wrap", "assignment", contextForProp(target.split(".").pop()));
      return res("wrap", "assignment", "text");
    }
    return res("review", `binary:${ts.SyntaxKind[op]}`, "logic-key");
  }

  // Strings nested inside a template
  if (ts.isTemplateSpan(parent)) return res("wrap", "nested-in-template", "fragment", ["nested"]);
  if (ts.isSpreadElement(parent)) return res("review", "spread", "text");

  // Model inputs (instructions sent to a model) and API payloads, judged by variable and property names up the ancestors
  const anc = ancestry(child);
  if (anc.modelInput && !anc.labelMap) return res("review", `model-input:${anc.modelInput}`, "model-input");
  const apiNote = anc.apiPayload ? [`api-payload:${anc.apiPayload}`] : [];

  // JSX attributes
  const jsxAttr = ts.isJsxAttribute(parent) ? parent : ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent) ? parent.parent : null;
  if (jsxAttr) {
    const name = nameText(jsxAttr.name) ?? "?";
    const tag = jsxAttr.parent?.parent ? jsxTagName(jsxAttr.parent.parent, sf) : "?";
    if (name === "source" && (aliases.get(tag) === "T" || tag === "T")) {
      return { ...res("wrapped", "rich-wrapped", "rich-text"), msgctxt: contextOfJsx(jsxAttr.parent) };
    }
    if (name.startsWith("data-") || NON_UI_ATTRS.has(name)) return res("review", `jsx-attr:${name}`, "logic-key", [`<${tag} ${name}>`]);
    if (FILENAME_ATTRS.has(name)) return res("review", `filename-attr:${name}`, "filename", [`<${tag} ${name}>`]);
    if (KEYWORD_PROP_RE.test(name)) return res("dynamic", `search-keyword:${name}`, "search-keyword", [`<${tag} ${name}>`]);
    if (VALUE_ATTRS.has(name)) return res("review", `jsx-value-attr:${name}`, "logic-key", [`<${tag} ${name}>`]);
    return res("wrap", "jsx-attr", contextForAttr(name), [`<${tag} ${name}>`, ...apiNote]);
  }
  // {"…"} / {`…`} among JSX children
  if (ts.isJsxExpression(parent)) {
    const owner = parent.parent;
    const tag = owner && (ts.isJsxElement(owner) || ts.isJsxFragment(owner)) ? jsxTagName(owner, sf) : "?";
    return res("wrap", "jsx-child-expression", contextForTag(tag), [`<${tag}>`]);
  }

  // Object property values
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === child) {
    const key = nameText(parent.name) ?? "?";
    if (LANGUAGE_KEY_RE.test(key)) {
      if (anc.labelMap && NAME_MAP_RE.test(anc.labelMap)) return res("wrap", "language-label", "label", [`${anc.labelMap}.${key}`, ...apiNote]);
      return res("review", `language-specific:${key}`, "logic-key", [`${key}:`]);
    }
    if (anc.labelMap) return res("wrap", "label-map", contextForProp(key), [`${anc.labelMap}.${key}`, ...apiNote]);
    if (KEYWORD_PROP_RE.test(key)) return res("dynamic", `search-keyword:${key}`, "search-keyword", [`${key}:`]);
    if (LOGIC_PROP_RE.test(key)) return res("review", `logic-prop:${key}`, "logic-key", [`${key}:`]);
    if (/^(filename|fileName|downloadName)$/.test(key)) return res("review", `filename-prop:${key}`, "filename", [`${key}:`]);
    // notify({ title, detail }) / toast({…}): marked toast, so translators know it is a notification
    let obj = parent.parent;
    while (obj?.parent && ts.isParenthesizedExpression(obj.parent)) obj = obj.parent;
    const call = obj?.parent;
    if (call && ts.isCallExpression(call) && /^(notify|toast|pushToast|showToast|addToast)$/.test(calleeInfo(call.expression, sf).name)) {
      return res("wrap", "toast-property", key === "title" ? "toast" : "toast-detail", [`${calleeInfo(call.expression, sf).name}({ ${key} })`]);
    }
    return res("wrap", "property", contextForProp(key), [`${key}:`, ...apiNote]);
  }
  if (ts.isShorthandPropertyAssignment(parent)) return res("wrap", "property", "text");

  // Map entries (new Map([[key, value], …])): a key is a lookup key; a value is judged like an object property value
  const entry = mapEntryOf(parent, child);
  if (entry) {
    const note = `new ${entry.ctor}([[key, value]])`;
    if (entry.position === "key") return res("review", "map-key", "logic-key", [note]);
    const holder = holderOf(entry.map);
    const hname = holder.name ?? "";
    if (anc.labelMap) return res("wrap", "map-label", "label", [`${anc.labelMap}: ${note}`, ...apiNote]);
    if (LOGIC_NAME_RE.test(hname) || (holder.kind === "prop" && (LOGIC_PROP_RE.test(hname) || KEYWORD_PROP_RE.test(hname)))) {
      return res("review", `matcher-map:${hname}`, "logic-key", [note]);
    }
    return res("wrap", "map-value", "text", [note, ...apiNote]);
  }

  // Array elements: judged by what holds the outermost array
  if (ts.isArrayLiteralExpression(parent)) {
    let outer = parent;
    while (outer.parent && (ts.isArrayLiteralExpression(outer.parent) || ts.isParenthesizedExpression(outer.parent))) outer = outer.parent;
    const holder = holderOf(outer);
    const hname = holder.name ?? "";
    if (holder.kind === "prop" && KEYWORD_PROP_RE.test(hname)) return res("dynamic", `search-keyword:${hname}`, "search-keyword", [`${hname}: [...]`]);
    if (holder.kind === "var" && (LOGIC_NAME_RE.test(hname) || usedAsMatcher(holder.decl, sf))) {
      return res("review", `matcher-list:${hname}`, "logic-key", [`const ${hname}`]);
    }
    if (holder.kind === "prop" && LOGIC_PROP_RE.test(hname)) return res("review", `logic-prop-list:${hname}`, "logic-key");
    if (holder.kind === "call" && ["Set", "Map", "RegExp", "includes", "some", "every", "has"].includes(hname)) {
      return res("review", `matcher-call:${hname}`, "logic-key");
    }
    if (holder.kind === "call" && hname === "join") return res("wrap", "joined-list", "fragment", ["joined-fragments"]);
    const asConst = via.includes("as-const") || (holder.child && ts.isAsExpression(holder.child) && holder.child.type.getText(sf) === "const");
    const ctx = holder.kind === "prop" ? contextForProp(hname) : "list-item";
    return res("wrap", `list:${holder.kind}${hname ? `:${hname}` : ""}`, ctx === "text" ? "list-item" : ctx, [
      ...(asConst ? ["as-const"] : []),
      ...(outer !== parent ? ["nested-array"] : []),
      ...apiNote,
    ]);
  }

  // Call arguments
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== child) {
    const callee = calleeInfo(parent.expression, sf);
    const index = (parent.arguments ?? []).indexOf(child);
    if (callee.full.startsWith("console.")) return res("skip", "console");
    if (ts.isNewExpression(parent) && ERROR_CTORS.has(callee.name)) return res("wrap", "error-ctor", "error");
    if (ts.isNewExpression(parent) && ["Set", "Map", "WeakMap", "WeakSet"].includes(callee.name)) return res("review", `matcher-call:${callee.name}`, "logic-key");
    if (callee.name === "RegExp") return res("review", "regex-source", "logic-key");
    if (callee.name === "join") {
      const listJoin = LIST_SEPARATORS.has(literal) && ts.isPropertyAccessExpression(parent.expression) && parent.arguments.length === 1;
      return res("wrap", listJoin ? "join-list" : "join-separator", "separator", [`${callee.full}()`]);
    }
    if (callee.name === "set" && index === 0) return res("review", "map-key", "logic-key");
    if (LOGIC_METHODS.has(callee.name)) return res("review", `logic-call:${callee.name}`, "logic-key", [`${callee.full}()`]);
    if (/^(cn|clsx|cva|twMerge|classNames)$/.test(callee.name)) return res("skip", "class-name");
    if (/^(navigate|fetch|request|http|get|post|put|patch|del)$/i.test(callee.name) || /^(api|http)\./.test(callee.full)) {
      return res("review", `request-call:${callee.full}`, "logic-key");
    }
    if (/^(download|saveAs|downloadBlob|downloadText|downloadJson|filename|fileName)/i.test(callee.name)) return res("review", `filename:${callee.name}`, "filename");
    for (const [re, ctx] of UI_CALLS) if (re.test(callee.name)) return res("wrap", `call:${callee.name}`, ctx, [`${callee.full}()`, ...apiNote]);
    return res("wrap", `call-arg:${callee.name}`, "text", [`${callee.full}()`, ...apiNote]);
  }

  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    const name = nameText(parent.name) ?? "?";
    if (LOGIC_NAME_RE.test(name)) return res("review", `logic-var:${name}`, "logic-key", [`const ${name}`]);
    const usage = stringUsedAsMatcher(parent, sf);
    if (usage === "regex") return res("review", `regex-const:${name}`, "logic-key", [`const ${name}`]);
    if (usage === "compare") return res("wrap", `matcher-const:${name}`, contextForProp(name), [`const ${name}`, "compared-elsewhere"]);
    return res("wrap", "variable", contextForProp(name), [`const ${name}`, ...apiNote]);
  }
  if (ts.isParameter(parent)) return res("wrap", "default-parameter", "text");
  if (ts.isBindingElement(parent)) return res("wrap", "default-binding", "text");
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === child)) return res("wrap", "return", "text", apiNote);
  if (ts.isThrowStatement(parent)) return res("wrap", "throw", "error");
  if (ts.isExpressionStatement(parent)) return res("skip", "expression-statement");
  if (ts.isPropertyAccessExpression(parent)) {
    const method = parent.name.text;
    if (["slice", "substring", "trim", "trimEnd", "trimStart", "padEnd", "padStart", "toUpperCase", "toLowerCase", "normalize"].includes(method)) {
      return res("wrap", `transformed:${method}`, "text", [`.${method}()`]);
    }
    return res("review", `method-receiver:${method}`, "logic-key");
  }
  if (ts.isTypeOfExpression?.(parent)) return res("skip", "typeof");
  if (ts.isExportAssignment(parent)) return res("wrap", "export-default", "text");
  if (ts.isSwitchStatement(parent)) return res("review", "switch-discriminant", "logic-key");
  return res("review", `unhandled:${ts.SyntaxKind[parent.kind]}`, "text");
}

/**
 * Where a string sits in the entries of `new Map([[key, value], …])` (or WeakMap): the pair is a two-element array
 * literal inside the array literal that is the constructor's first argument. Null anywhere else.
 */
function mapEntryOf(parent, child) {
  if (!ts.isArrayLiteralExpression(parent) || parent.elements.length !== 2) return null;
  const position = parent.elements[0] === child ? "key" : parent.elements[1] === child ? "value" : null;
  if (!position) return null;
  const pair = climb(parent);
  if (!pair.parent || !ts.isArrayLiteralExpression(pair.parent)) return null;
  const list = climb(pair.parent);
  const call = list.parent;
  if (!call || !ts.isNewExpression(call) || call.arguments?.[0] !== list.child) return null;
  const ctor = calleeInfo(call.expression).name;
  return ctor === "Map" || ctor === "WeakMap" ? { position, ctor, map: call } : null;
}
