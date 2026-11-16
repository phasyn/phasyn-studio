// AST helpers over the TypeScript compiler API: names, callees, wrappers to climb, holders and usage of string constants,
// t()/<T> contexts and the i18n imports of a file.
import { CJK_RE, ts } from "./core.mjs";
import { LABEL_MAP_RE, LOGIC_METHODS, MODEL_INPUT_NAME_RE } from "./rules.mjs";

export function nameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName?.(name)) return `${name.namespace.text}:${name.name.text}`;
  return null;
}

/** The callee's last name segment and its full text (console.log → log / console.log). */
export function calleeInfo(expr, sf) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return { name: e.text, full: e.text };
  if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, full: e.getText(sf) };
  if (ts.isElementAccessExpression(e)) return { name: "[]", full: e.getText(sf) };
  return { name: "?", full: e.getText(sf).slice(0, 40) };
}

export function jsxTagName(node, sf) {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return "<>";
  return opening.tagName.getText(sf);
}

/** Climbs past wrappers that keep the meaning (parentheses, as, satisfies, !, operands of ?? / || / &&, conditional branches). */
export function climb(node) {
  let child = node;
  let parent = node.parent;
  const via = [];
  for (;;) {
    if (!parent) break;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      if (ts.isAsExpression(parent) && parent.type.getText() === "const") via.push("as-const");
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== child) {
      via.push("conditional");
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
        parent.operatorToken.kind,
      )
    ) {
      via.push("logical");
      child = parent;
      parent = parent.parent;
      continue;
    }
    break;
  }
  return { child, parent, via };
}

/** The name of what holds an array or object: const X = [...], { x: [...] }, f([...]). */
export function holderOf(node) {
  const { child, parent } = climb(node);
  if (!parent) return { kind: "none", name: null, child };
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) return { kind: "var", name: nameText(parent.name), child, decl: parent };
  if (ts.isPropertyAssignment(parent) && parent.initializer === child) return { kind: "prop", name: nameText(parent.name), child };
  if (ts.isPropertyDeclaration(parent) && parent.initializer === child) return { kind: "prop", name: nameText(parent.name), child };
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return { kind: "call", name: calleeInfo(parent.expression).name, child, call: parent };
  if (ts.isArrayLiteralExpression(parent)) return { kind: "array", name: null, child, array: parent };
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return { kind: "return", name: null, child };
  return { kind: ts.SyntaxKind[parent.kind], name: null, child };
}

/**
 * Name hints along the ancestor chain (up to the file's top level):
 *  - labelMap: a variable or property holding the object is named like a label map (*_LABELS, *Hints…)
 *  - modelInput: the name looks like a model instruction (INSTRUCTION, prompt, parameters…)
 *  - apiPayload: inside an API request body (body / payload / pipeline, build*Run functions)
 */
export function ancestry(node) {
  const out = { labelMap: null, modelInput: null, apiPayload: null };
  let cur = node;
  let direct = true;
  while (cur && cur.parent) {
    const p = cur.parent;
    let name = null;
    if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === cur) name = nameText(p.name);
    else if (ts.isVariableDeclaration(p) && p.initializer === cur) name = nameText(p.name);
    else if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
      const fname = nameText(p.name) ?? "";
      if (!out.apiPayload && /^(build|make|create|to)\w*(Run|Body|Payload|Request|Pipeline|Wire)\w*$/.test(fname)) out.apiPayload = `${fname}()`;
    } else if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
      const fname = nameText(p.name) ?? "";
      if (!out.apiPayload && /^(build|make|create|to)\w*(Run|Body|Payload|Request|Pipeline|Wire)\w*$/.test(fname)) out.apiPayload = `${fname}()`;
    }
    if (name) {
      if (!out.labelMap && LABEL_MAP_RE.test(name)) out.labelMap = name;
      // Model input: the name directly holding this text looks like a model instruction (prompt, instruction…), or it
      // sits in a parameters object (a run's model parameters)
      if (!out.modelInput && ((direct && (MODEL_INPUT_NAME_RE.test(name) || name === "prompt")) || name === "parameters")) out.modelInput = name;
      if (!out.apiPayload && /^(body|payload|request)$/.test(name)) out.apiPayload = name;
      direct = false;
    }
    if (ts.isFunctionLike(p)) direct = false;
    cur = p;
  }
  return out;
}

/**
 * How a string constant is used: regex = it builds a RegExp (a regex fragment, never translated); compare = it is an
 * argument of startsWith / includes / split… or an operand of === (still wrapped: when both sides use the same
 * constant they stay equal after translation); neither = null.
 */
export function stringUsedAsMatcher(decl, sf) {
  const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
  if (!name) return null;
  let kind = null;
  const visit = (node) => {
    if (kind === "regex") return;
    if (ts.isIdentifier(node) && node.text === name && node !== decl.name) {
      const p = node.parent;
      for (let up = p; up && !ts.isStatement(up); up = up.parent) {
        if ((ts.isNewExpression(up) || ts.isCallExpression(up)) && ts.isIdentifier(up.expression) && up.expression.text === "RegExp") kind = "regex";
      }
      if (kind !== "regex" && p && ts.isCallExpression(p) && p.arguments.includes(node) && LOGIC_METHODS.has(calleeInfo(p.expression, sf).name)) kind = "compare";
      if (kind !== "regex" && p && ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) {
        const other = p.left === node ? p.right : p.left;
        const trivial = other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === "undefined") || ts.isNumericLiteral(other) || ((ts.isStringLiteral(other) || ts.isNoSubstitutionTemplateLiteral(other)) && !CJK_RE.test(other.text));
        if (!trivial) kind = "compare";
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return kind;
}

/** Whether this variable is used for matching in its file (X.includes(…), X.has(…), for (… of X) …): then it is a word list, not UI text. */
export function usedAsMatcher(decl, sf) {
  const name = decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
  if (!name) return false;
  let hit = false;
  const visit = (node) => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      if (["includes", "has", "indexOf", "some", "every", "find", "findIndex", "filter", "test", "exec"].includes(node.name.text)) hit = true;
    }
    if (ts.isForOfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === name) hit = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      if (node.arguments.some((a) => a.getText(sf).includes(name))) hit = true;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["RegExp", "Set", "Map"].includes(node.expression.text)) {
      if ((node.arguments ?? []).some((a) => a.getText(sf).includes(name))) hit = true;
    }
    if (ts.isTemplateExpression(node) && node.parent && ts.isTaggedTemplateExpression(node.parent) && node.getText(sf).includes(name)) hit = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}

/** The context (a string literal) in the third argument of t(…, …, { context: "x" }); null without one. */
export function contextOfCall(call) {
  const options = call.arguments[2];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && nameText(property.name) === "context" && (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer))) {
      return property.initializer.text;
    }
  }
  return null;
}

/** The context of <T … context="x" /> (or context={"x"}). */
export function contextOfJsx(attributes) {
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || nameText(property.name) !== "context" || !property.initializer) continue;
    const init = property.initializer;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) return init.expression.text;
  }
  return null;
}

/** Names this file imports from the i18n module: local name → imported name (t, tServer, T…; possibly aliased, import { t as tr }). */
export function i18nAliases(sf, rel) {
  const map = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const isI18n = /^@\/i18n(\/(index|T|format|server))?$/.test(spec) || (rel.startsWith("src/i18n/") && /^\.\/(index|T|format|server)$/.test(spec));
    const named = stmt.importClause?.namedBindings;
    if (!isI18n || !named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) map.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  return map;
}
