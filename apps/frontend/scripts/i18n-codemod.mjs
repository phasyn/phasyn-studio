#!/usr/bin/env node
// i18n codemod：把使用者看得到的繁中字串包成 t()／<T>，可以重複執行（已包好的不再處理、import 不重複）。
//   node scripts/i18n-codemod.mjs --dry-run   列出會改的檔案與數量（預設，不寫檔）
//   node scripts/i18n-codemod.mjs --apply     寫回檔案
//   node scripts/i18n-codemod.mjs --check     完整性檢查（同 node scripts/i18n-check.mjs）
//   選項：--only <路徑前綴>（可重複，例如 src/features/studio/）、--verbose（列出每一處與需要人工確認的位置）、
//         --no-types（不建 TypeScript program：JSX 內含值的句子一律用 <T>）
// 判斷「哪些字串要包」與 dry-run 抽取共用 scripts/i18n-scan.mjs；不改測試、fixtures、src/i18n 與 i18n-ignore 標記的地方。
// 改寫規則：
//   "文字"                    → t("文字")            （JSX 屬性 title="文字" → title={t("文字")}）
//   `已選 ${n} 個`、"已選 " + n → t("已選 {n} 個", { n })
//   <p>已選 {n} 個</p>         → <p>{t("已選 {n} 個", { n })}</p>（值不全是字串／數字時改用 <T>，保留 React 的顯示規則）
//   <p>顯示 <b>{x}</b> 個</p>  → <p><T source={"顯示 <0>{x}</0> 個"} values={{ x }} slots={[<b />]} /></p>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, bundledFiles, i18nAliases, listSourceFiles, scanSource, ts } from "./i18n-scan.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const only = args.flatMap((arg, index) => (arg === "--only" && args[index + 1] ? [args[index + 1]] : []));

if (has("--check")) {
  const script = fileURLToPath(new URL("./i18n-check.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, ...args.filter((arg) => arg !== "--check")], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

const apply = has("--apply");
const verbose = has("--verbose");
const useTypes = !has("--no-types");

// ───────────────────────────── 型別（決定 t() 或 <T>） ─────────────────────────────

let checker = null;
let program = null;
if (useTypes) {
  const configPath = join(APP_ROOT, "tsconfig.app.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (parsed) {
    program = ts.createProgram(parsed.fileNames, parsed.options);
    checker = program.getTypeChecker();
  }
}

/** 值是字串或數字（含其聯集）：在 JSX 裡與 String(x) 顯示相同，可以用 t()。boolean／null／物件 → 用 <T>。 */
function stringish(type) {
  if (type.isUnion()) return type.types.every(stringish);
  if (type.isIntersection()) return type.types.some(stringish);
  return (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0;
}

function allStringish(nodes) {
  if (!checker) return false;
  return nodes.every((node) => {
    try {
      return stringish(checker.getTypeAtLocation(node));
    } catch {
      return false;
    }
  });
}

// ───────────────────────────── 編輯 ─────────────────────────────

const json = (text) => JSON.stringify(text);

/** 檔案裡已宣告的名稱（避免 import 的 t／T 被區域變數遮蔽）。 */
function declaredNames(sf) {
  const values = new Set();
  const types = new Set();
  const visit = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) values.add(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) values.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) values.add(node.name.text);
    if (ts.isImportClause(node) && node.name) values.add(node.name.text);
    if (ts.isTypeParameterDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) types.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { values, types };
}

/** 一個檔案的所有改寫（巢狀的改寫在外層的參數裡一起套用）。 */
function rewriteFile(rel, text, sf) {
  const sites = scanSource(text, rel, { sourceFile: sf }).sites.filter((site) => site.decision === "wrap");
  if (sites.length === 0) return null;
  const aliases = i18nAliases(sf, rel);
  const declared = declaredNames(sf);
  const existing = (canonical) => [...aliases.entries()].find(([, name]) => name === canonical)?.[0] ?? null;
  const pick = (canonical, candidates, avoidTypes) =>
    existing(canonical) ?? candidates.find((name) => !declared.values.has(name) && !(avoidTypes && declared.types.has(name))) ?? candidates[candidates.length - 1];
  const tName = pick("t", ["t", "tr", "i18nT"], false);
  const TName = pick("T", ["T", "Trans", "I18nText"], true);
  const listName = pick("formatList", ["formatList", "formatI18nList"], false);
  let usesT = false;
  let usesRich = false;
  let usesList = false;
  const counts = { string: 0, template: 0, concat: 0, "jsx-text": 0, "jsx-t": 0, "jsx-rich": 0, list: 0 };

  const edits = [];
  /** 取代範圍；`"文字" as const` 連同 as const 一起取代（as const 不能套在函式呼叫上）。 */
  const range = (node) => {
    const parent = node.parent;
    const asConst = parent && ts.isAsExpression(parent) && parent.expression === node && parent.type.getText(sf) === "const";
    const target = asConst ? parent : node;
    return { start: target.getStart(sf), end: target.getEnd() };
  };

  const paramsText = (names, nodes, render) =>
    names
      .map((name, index) => {
        const node = nodes[index];
        const value = node.group ? `(${render(node.group[0].getStart(sf), node.group[node.group.length - 1].getEnd())})` : render(node.getStart(sf), node.getEnd());
        return value === name ? name : `${name}: ${value}`;
      })
      .join(", ");

  for (const site of sites) {
    if (site.kind === "string" && site.reason === "join-list") {
      // items.join("、") → formatList(items)：zh-Hant 輸出不變，ja／en 依 Intl.ListFormat
      counts.list += 1;
      usesList = true;
      const call = site.node.parent;
      const receiver = call.expression.expression;
      const options = site.source === "、" ? "" : site.source === "／" ? `, { type: "disjunction", separator: ${json(site.source)} }` : `, { separator: ${json(site.source)} }`;
      edits.push({ start: call.getStart(sf), end: call.getEnd(), build: (render) => `${listName}(${render(receiver.getStart(sf), receiver.getEnd())}${options})` });
    } else if (site.kind === "string") {
      counts.string += 1;
      usesT = true;
      edits.push({ ...range(site.node), build: () => (site.bareJsxAttr ? `{${tName}(${json(site.source)})}` : `${tName}(${json(site.source)})`) });
    } else if (site.kind === "template") {
      counts.template += 1;
      usesT = true;
      edits.push({ ...range(site.node), build: (render) => `${tName}(${json(site.source)}, { ${paramsText(site.placeholders, site.exprNodes, render)} })` });
    } else if (site.kind === "concat") {
      counts.concat += 1;
      usesT = true;
      const nodes = site.chainPieces.filter((piece) => piece.expr || piece.group).map((piece) => (piece.group ? { group: piece.group } : piece.expr));
      edits.push({ ...range(site.node), build: (render) => `${tName}(${json(site.source)}, { ${paramsText(site.placeholders, nodes, render)} })` });
    } else if (site.kind === "jsx-text" || site.kind === "jsx-rich") {
      const { valueNodes, names, slotNodes, rich } = site.jsx;
      const values = (render) => paramsText(names, valueNodes, render);
      if (!rich && valueNodes.length === 0) {
        counts["jsx-text"] += 1;
        usesT = true;
        edits.push({ start: site.start, end: site.end, build: () => `{${tName}(${json(site.source)})}` });
      } else if (!rich && allStringish(valueNodes)) {
        counts["jsx-t"] += 1;
        usesT = true;
        edits.push({ start: site.start, end: site.end, build: (render) => `{${tName}(${json(site.source)}, { ${values(render)} })}` });
      } else {
        counts["jsx-rich"] += 1;
        usesRich = true;
        edits.push({
          start: site.start,
          end: site.end,
          build: (render) => {
            const parts = [`source={${json(site.source)}}`];
            if (valueNodes.length > 0) parts.push(`values={{ ${values(render)} }}`);
            if (slotNodes.length > 0) {
              const slots = slotNodes.map((slot) => {
                if (ts.isJsxSelfClosingElement(slot)) return render(slot.getStart(sf), slot.getEnd());
                const opening = slot.openingElement;
                const tag = opening.tagName.getText(sf);
                const attrs = render(opening.tagName.getEnd(), opening.getEnd() - 1);
                return `<${tag}${attrs.trimEnd()} />`;
              });
              parts.push(`slots={[${slots.join(", ")}]}`);
            }
            return `<${TName} ${parts.join(" ")} />`;
          },
        });
      }
    }
  }

  // 依位置排序；完全包在別的改寫範圍裡的，交給外層在 render 子範圍時套用。重疊但不包含的（不應發生）略過並回報。
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const skipped = [];
  const render = (from, to) => {
    let out = "";
    let cursor = from;
    for (const edit of edits) {
      if (edit.start < cursor || edit.start < from || edit.end > to) continue;
      out += text.slice(cursor, edit.start) + edit.build(render);
      cursor = edit.end;
    }
    return out + text.slice(cursor, to);
  };
  for (let i = 1; i < edits.length; i += 1) {
    const previous = edits[i - 1];
    const current = edits[i];
    if (current.start < previous.end && current.end > previous.end) skipped.push(current);
  }
  for (const edit of skipped) edits.splice(edits.indexOf(edit), 1);

  let output = render(0, text.length);
  output = ensureImports(output, rel, { tName: usesT ? tName : null, TName: usesRich ? TName : null, listName: usesList ? listName : null });
  return { output, counts, skipped: skipped.length, sites };
}

function hasNamedImport(sf, spec, name, local) {
  return sf.statements.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === spec &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings) &&
      stmt.importClause.namedBindings.elements.some((element) => (element.propertyName ?? element.name).text === name && element.name.text === local),
  );
}

/** 加上（或補進既有的）import；已經有就不動。 */
function ensureImports(text, rel, { tName, TName, listName }) {
  if (!tName && !TName && !listName) return text;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = i18nAliases(sf, rel);
  const needed = [];
  if (tName && aliases.get(tName) !== "t") needed.push({ spec: "@/i18n", name: "t", local: tName });
  if (TName && aliases.get(TName) !== "T") needed.push({ spec: "@/i18n/T", name: "T", local: TName });
  if (listName && !hasNamedImport(sf, "@/i18n/format", "formatList", listName)) needed.push({ spec: "@/i18n/format", name: "formatList", local: listName });
  if (needed.length === 0) return text;
  const imports = sf.statements.filter((stmt) => ts.isImportDeclaration(stmt));
  let out = text;
  const additions = [];
  for (const need of needed) {
    const specifier = need.local === need.name ? need.name : `${need.name} as ${need.local}`;
    const target = imports.find(
      (stmt) => ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === need.spec && !stmt.importClause?.isTypeOnly && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings),
    );
    if (target) {
      // 重組 named imports：`{ a, b }` → `{ a, b, t }`（保留既有項目的原文，例如 type 修飾）
      // 前一個 import 可能已經改過 out：在目前的文字裡依模組名稱重新找這個 import
      const current = ts.createSourceFile(rel, out, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const stmt = current.statements.find(
        (node) =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === need.spec &&
          !node.importClause?.isTypeOnly &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings),
      );
      const named = stmt.importClause.namedBindings;
      const items = [...named.elements.map((element) => element.getText(current)), specifier];
      out = `${out.slice(0, named.getStart(current))}{ ${items.join(", ")} }${out.slice(named.getEnd())}`;
    } else {
      additions.push(`import { ${specifier} } from "${need.spec}";`);
    }
  }
  if (additions.length > 0) {
    const reparsed = ts.createSourceFile(rel, out, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lastImport = [...reparsed.statements].reverse().find((stmt) => ts.isImportDeclaration(stmt));
    const at = lastImport ? lastImport.getEnd() : 0;
    const block = additions.join("\n");
    out = lastImport ? `${out.slice(0, at)}\n${block}${out.slice(at)}` : `${block}\n${out}`;
  }
  return out;
}

// ───────────────────────────── 主程式 ─────────────────────────────

const files = listSourceFiles();
const bundled = bundledFiles(files);
const targets = files.filter((rel) => bundled.has(rel) && !rel.startsWith("src/i18n/") && (only.length === 0 || only.some((prefix) => rel.startsWith(prefix))));
const totals = { files: 0, changed: 0, string: 0, template: 0, concat: 0, "jsx-text": 0, "jsx-t": 0, "jsx-rich": 0, list: 0, skipped: 0 };
const review = new Map();
for (const rel of targets) {
  const abs = join(APP_ROOT, rel);
  const text = readFileSync(abs, "utf8");
  const sf = program?.getSourceFile(abs) ?? ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  totals.files += 1;
  for (const site of scanSource(text, rel, { sourceFile: sf }).sites) {
    if (site.decision !== "review" || site.context !== "logic-key") continue;
    const key = site.reason.replace(/:.*/, "");
    review.set(key, [...(review.get(key) ?? []), `${rel}:${site.line}  ${JSON.stringify(site.source.slice(0, 70))}`]);
  }
  const result = rewriteFile(rel, text, sf);
  if (!result || result.output === text) continue;
  totals.changed += 1;
  for (const [kind, count] of Object.entries(result.counts)) totals[kind] += count;
  totals.skipped += result.skipped;
  if (verbose) console.log(`${apply ? "改寫" : "會改寫"} ${rel}：${Object.entries(result.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join("、")}`);
  if (apply) writeFileSync(abs, result.output);
}

console.log(`${apply ? "已改寫" : "dry-run（加 --apply 才會寫檔）"}：${totals.changed}／${totals.files} 個檔案`);
console.log(
  `  字串 ${totals.string}・樣板 ${totals.template}・字串連接 ${totals.concat}・JSX 文字 ${totals["jsx-text"]}・JSX 含值（t）${totals["jsx-t"]}・<T> ${totals["jsx-rich"]}・清單 formatList ${totals.list}` +
    (totals.skipped ? `・重疊略過 ${totals.skipped}` : ""),
);
if (!checker) console.log("  （沒有型別資訊：JSX 內含值的句子一律用 <T>）");
const reviewTotal = [...review.values()].reduce((n, list) => n + list.length, 0);
console.log(`需要人工確認（中文當邏輯值，不會自動包）：${reviewTotal} 處${verbose ? "" : "（--verbose 列出）"}`);
if (verbose) for (const [reason, list] of review) console.log(`  ${reason}：\n    ${list.join("\n    ")}`);
console.log("下一步：pnpm typecheck && pnpm lint && pnpm test（含 i18n 完整性）；伺服器文字用 pnpm i18n:check。");
