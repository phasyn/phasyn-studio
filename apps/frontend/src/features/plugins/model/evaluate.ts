// 規則評估器：把專案選用的插件規則套用到一個鏡頭的 prompt。它要通過
// contracts/examples/plugin-rules 的共用案例。
//   1. 沒有選任何東西：prompt 照原樣送出，不需要登錄表。
//   2. 選了東西而登錄表讀不到（或還沒讀到）：擋下，prompt 不動。
//   3. 引用依專案順序解析：登錄表裡沒有（unknown）、所屬的包不是 ok（plugin_disabled／plugin_incompatible／
//      plugin_invalid）、或同組已經有較前面的規則（group_conflict）的引用不套用，並回報原因。
//   4. 套用的規則要加進 prompt 的文字合計（UTF-8）不得超過登錄表的 limits.max_project_inject_bytes。
//   5. 每條套用的規則：forbid 命中就回報（連同命中的文字）；require 沒命中就回報。內建包用正規表示式（不分 ASCII 大小寫），
//      其他包只有詞組清單（./phrases）。規則的 shots 是逐鏡的同類檢查（鏡頭的切法在 ./shots）：forbid 在每個鏡頭各查一次、
//      require 只查點名 <Subject N> 的鏡頭，every_subject 回報沒有任何鏡頭點名的角色；這些結果帶著鏡頭或角色的編號。
//   6. 要加的文字依 style、effect、constraint 排序（同類依專案順序），加在 detailed_description: 那一行之後；沒有這一行
//      就放最前面、後面空一行；prompt 已有同一段就不重複加。
// 任何一項回報都擋下渲染：從不默默略過一條限制（fail closed）。登錄表給了這個介面看不懂的規則（新版主控才有的欄位）時，
// 規則不套用、回報 rule_unusable。
import type { StudioPlugin, StudioPluginRef, StudioPluginRule } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { firstMatchingPhrase, normalizePhraseText, preparePhrases } from "./phrases";
import { pluginUsable, registryLimits, resolveRef, type PluginRegistry, type RegistryGeneration, type RegistryRule } from "./registry";
import { uniqueRefs } from "./refs";
import { namedSubjects, scanShots, type ShotScan } from "./shots";
import { pluginText, type PluginLocalizedText } from "./text";

export type SelectionProblemCode =
  | "registry_unavailable"
  | "unknown"
  | "plugin_disabled"
  | "plugin_incompatible"
  | "plugin_invalid"
  | "group_conflict"
  | "inject_too_large"
  /** 這個介面自己的防線：登錄表給了評估不了的規則（非內建包的正規表示式、編譯不過的 pattern、不認得的格式）。 */
  | "rule_unusable";

export interface SelectionProblem {
  code: SelectionProblemCode;
  /** 哪個引用的問題；null＝整個選取（登錄表讀不到、文字超過上限）。 */
  ref: StudioPluginRef | null;
  /** 已翻譯的一句話。 */
  text: string;
  /** 與共用案例相同的欄位：plugin_id、group／other、bytes／limit。 */
  details: Readonly<Record<string, string | number>>;
}

export interface PluginSelection {
  /** 可以套用的規則，依專案順序。 */
  rules: readonly RegistryRule[];
  /** 可以檢查的生成設定，依專案順序。 */
  generation: readonly RegistryGeneration[];
  problems: readonly SelectionProblem[];
}

const EMPTY_SELECTION: PluginSelection = { rules: [], generation: [], problems: [] };

export function pluginName(plugin: StudioPlugin): string {
  return pluginText(plugin.name, plugin.plugin_id);
}

export function ruleLabel(entry: RegistryRule): string {
  return pluginText(entry.rule.label, entry.ref);
}

export function generationLabel(entry: RegistryGeneration): string {
  return pluginText(entry.generation.label, entry.ref);
}

/** 登錄表不能用時的原因（可以用時為 null）。 */
export function registryProblem(registry: PluginRegistry): SelectionProblem | null {
  if (registry.status === "ready") return null;
  const text = registry.status === "loading" ? t("還在讀取插件登錄表") : t("讀不到插件登錄表：{reason}", { reason: errorText(registry.error) });
  return { code: "registry_unavailable", ref: null, text, details: {} };
}

/** 一個包的貢獻不能套用的原因（status 不是 ok）；可以套用時為 null。 */
export function pluginUnusableReason(plugin: StudioPlugin): string | null {
  if (plugin.status === "ok") return null;
  const name = pluginName(plugin);
  if (plugin.status === "disabled") return t("插件「{name}」已停用", { name });
  if (plugin.status === "incompatible") return t("插件「{name}」與這個版本不相容", { name });
  return t("插件「{name}」的內容讀不到", { name });
}

/** 所屬的包不是 ok：它的貢獻不能套用。label＝貢獻的名稱（登錄表沒有列出這個貢獻時用引用本身）。 */
function pluginProblem(ref: StudioPluginRef, label: string, plugin: StudioPlugin): SelectionProblem {
  const code = plugin.status === "disabled" ? "plugin_disabled" : plugin.status === "incompatible" ? "plugin_incompatible" : "plugin_invalid";
  const text = t("{reason}，「{label}」無法套用", { reason: pluginUnusableReason(plugin) ?? pluginName(plugin), label });
  return { code, ref, text, details: { plugin_id: plugin.plugin_id } };
}

function unknownProblem(ref: StudioPluginRef, plugin: StudioPlugin | null): SelectionProblem {
  const text = plugin ? t("插件「{plugin}」裡沒有「{id}」", { plugin: pluginName(plugin), id: ref }) : t("找不到插件「{id}」", { id: ref });
  return { code: "unknown", ref, text, details: {} };
}

// ---------------------------------------------------------------- 規則的比對條件

interface CompiledItem {
  id: string;
  message: PluginLocalizedText;
  /** 命中的文字（pattern：prompt 裡的原文；詞組：清單裡的寫法）；沒有命中為 null。normalized 只在用到詞組清單時才計算。 */
  find: (prompt: string, normalized: () => string) => string | null;
}

interface CompiledChecks {
  forbid: CompiledItem[];
  require: CompiledItem[];
}

interface CompiledShots extends CompiledChecks {
  /** 每個定義的角色都要在某個鏡頭被點名；沒有這項檢查時為 null。 */
  everySubject: { id: string; message: PluginLocalizedText } | null;
}

interface CompiledRule extends CompiledChecks {
  /** 逐鏡檢查；規則沒有 shots 時為 null。 */
  shots: CompiledShots | null;
  /** 這條規則無法評估的原因（不能評估＝擋下渲染）。 */
  problem: string | null;
}

export type RuleItem = NonNullable<StudioPluginRule["forbid"]>[number] | NonNullable<StudioPluginRule["require"]>[number];

/** 這個評估器認得的規則欄位與 shots 欄位；多出來的（新版主控的檢查）＝無法評估。 */
const RULE_KEYS: ReadonlySet<string> = new Set(["id", "kind", "group", "label", "description", "forbid", "require", "shots", "inject"]);
const SHOT_KEYS: ReadonlySet<string> = new Set(["forbid", "require", "every_subject"]);

/** 一個 forbid／require 項目用什麼比對：正規表示式（內建規則）或詞組清單（word＝完整的詞才算）。 */
export type RuleItemCheck = { kind: "regex"; source: string } | { kind: "phrases"; terms: readonly string[]; word: boolean };

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 項目的比對條件；格式不認得時為 null。評估器與規則預覽都讀這一個。 */
export function ruleItemCheck(item: RuleItem): RuleItemCheck | null {
  if ("pattern" in item && typeof item.pattern === "string") return { kind: "regex", source: item.pattern };
  if ("any_of" in item && typeof item.any_of === "string") return { kind: "regex", source: item.any_of };
  const terms: unknown = "terms" in item ? item.terms : "any_terms" in item ? item.any_terms : null;
  if (!isStrings(terms) || terms.length === 0) return null;
  return { kind: "phrases", terms, word: "word" in item && item.word === true };
}

function compileItem(item: RuleItem, builtin: boolean): CompiledItem | string {
  const base = { id: item.id, message: item.message };
  const check = ruleItemCheck(item);
  if (check === null) return t("比對條件的格式不認得");
  if (check.kind === "regex") {
    if (!builtin) return t("只有內建插件可以使用正規表示式");
    try {
      // 沒有 u／v 旗標的 "i"：只折疊 ASCII 大小寫，\b、\w、\d 是 ASCII 的（Python 那邊是 re.IGNORECASE | re.ASCII）
      const regex = new RegExp(check.source, "i");
      return { ...base, find: (prompt) => regex.exec(prompt)?.[0] ?? null };
    } catch {
      return t("正規表示式無法編譯");
    }
  }
  const prepared = preparePhrases(check.terms);
  return { ...base, find: (_prompt, normalized) => firstMatchingPhrase(prepared, normalized(), check.word) };
}

function compileChecks(checks: Pick<StudioPluginRule, "forbid" | "require">, builtin: boolean): CompiledChecks | string {
  const compiled: CompiledChecks = { forbid: [], require: [] };
  for (const section of ["forbid", "require"] as const) {
    for (const item of checks[section] ?? []) {
      const result = compileItem(item, builtin);
      if (typeof result === "string") return result;
      compiled[section].push(result);
    }
  }
  return compiled;
}

function compileShots(shots: StudioPluginRule["shots"], builtin: boolean): CompiledShots | null | string {
  if (shots === undefined) return null;
  if (Object.keys(shots).some((key) => !SHOT_KEYS.has(key))) return t("逐鏡檢查有這個版本不認得的項目");
  const checks = compileChecks(shots, builtin);
  if (typeof checks === "string") return checks;
  const every = shots.every_subject;
  return { ...checks, everySubject: every ? { id: every.id, message: every.message } : null };
}

function compileRule(entry: RegistryRule): CompiledRule {
  const unusable = (problem: string): CompiledRule => ({ forbid: [], require: [], shots: null, problem });
  if (Object.keys(entry.rule).some((key) => !RULE_KEYS.has(key))) return unusable(t("規則有這個版本不認得的檢查"));
  const builtin = entry.plugin.source === "builtin";
  const checks = compileChecks(entry.rule, builtin);
  if (typeof checks === "string") return unusable(checks);
  const shots = compileShots(entry.rule.shots, builtin);
  if (typeof shots === "string") return unusable(shots);
  return { ...checks, shots, problem: null };
}

const compiledRules = new WeakMap<RegistryRule, CompiledRule>();

function compiledRule(entry: RegistryRule): CompiledRule {
  let compiled = compiledRules.get(entry);
  if (!compiled) {
    compiled = compileRule(entry);
    compiledRules.set(entry, compiled);
  }
  return compiled;
}

// ---------------------------------------------------------------- 選取

const encoder = new TextEncoder();
/**
 * 文字前後要去掉的空白：與 Python 的 str.strip() 相同的字元（另一個評估器用它），所以兩邊去掉的範圍一樣。
 * JavaScript 的 trim() 多去掉 U+FEFF、少去掉 U+0085 與 U+001C–U+001F。
 */
const EDGE_SPACE = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+";
const EDGES = new RegExp(`^${EDGE_SPACE}|${EDGE_SPACE}$`, "g");

function trimmed(text: string): string {
  return text.replace(EDGES, "");
}

/** 這些規則會加進 prompt 的文字合計（去掉前後空白後的 UTF-8 bytes）。 */
export function injectBytes(rules: readonly RegistryRule[]): number {
  return rules.reduce((sum, entry) => sum + encoder.encode(trimmed(entry.rule.inject ?? "")).length, 0);
}

/**
 * 專案選用的引用對到登錄表的結果：可以套用的規則與生成設定，以及每個不能套用的原因。
 * 沒有選任何東西時不看登錄表（沒選插件的專案不受登錄表影響）。專案文件的引用不重複；重複的只算第一次。
 */
export function resolveSelection(registry: PluginRegistry, refs: readonly StudioPluginRef[] | null | undefined): PluginSelection {
  const selected = uniqueRefs(refs);
  if (selected.length === 0) return EMPTY_SELECTION;
  const unavailable = registryProblem(registry);
  if (unavailable) return { rules: [], generation: [], problems: [unavailable] };

  const problems: SelectionProblem[] = [];
  const rules: RegistryRule[] = [];
  const generation: RegistryGeneration[] = [];
  const groups = new Map<string, RegistryRule>();
  for (const ref of selected) {
    const resolved = resolveRef(registry, ref);
    if (resolved.kind === "missing") {
      problems.push(resolved.plugin && !pluginUsable(resolved.plugin) ? pluginProblem(ref, ref, resolved.plugin) : unknownProblem(ref, resolved.plugin));
      continue;
    }
    const label = resolved.kind === "rule" ? ruleLabel(resolved.entry) : generationLabel(resolved.entry);
    if (!pluginUsable(resolved.entry.plugin)) {
      problems.push(pluginProblem(ref, label, resolved.entry.plugin));
      continue;
    }
    if (resolved.kind === "generation") {
      generation.push(resolved.entry);
      continue;
    }
    const rule = resolved.entry;
    const group = rule.rule.group;
    const holder = group ? groups.get(group) : undefined;
    if (group && holder) {
      const text = t("插件「{a}」與「{b}」同一組，只能選一個", { a: ruleLabel(holder), b: label });
      problems.push({ code: "group_conflict", ref, text, details: { group, other: holder.ref } });
      continue;
    }
    const unusable = compiledRule(rule).problem;
    if (unusable) {
      problems.push({ code: "rule_unusable", ref, text: t("規則「{label}」無法評估：{problem}", { label, problem: unusable }), details: {} });
      continue;
    }
    if (group) groups.set(group, rule);
    rules.push(rule);
  }
  const limit = registryLimits(registry)?.max_project_inject_bytes;
  const bytes = injectBytes(rules);
  if (limit !== undefined && bytes > limit) {
    const text = t("插件加進 prompt 的文字合計 {used}，超過上限 {limit}", { used: formatBytes(bytes), limit: formatBytes(limit) });
    problems.push({ code: "inject_too_large", ref: null, text, details: { bytes, limit } });
  }
  return { rules, generation, problems };
}

// ---------------------------------------------------------------- 套用到 prompt

export interface RuleFinding {
  /** 規則的引用。 */
  ref: StudioPluginRef;
  /** forbid／require 項目的 id。 */
  itemId: string;
  kind: "forbid" | "require";
  /** 規則的標籤（已依介面語言取出）。 */
  label: string;
  /** 項目的說明（已依介面語言取出）。 */
  message: string;
  /** forbid：命中的文字；require：null。 */
  match: string | null;
  /** 逐鏡檢查的結果：是哪一個鏡頭（[Shot N] 的 N）；整份 prompt 的檢查與角色覆蓋為 null。 */
  shot: number | null;
  /** 角色覆蓋的結果：沒有任何鏡頭點名的角色（<Subject N> 的 N）；其他為 null。 */
  subject: number | null;
}

/** 逐鏡結果在 prompt 裡的寫法（[Shot 2]、<Subject 2>）；整份 prompt 的結果為 null。 */
export function findingPlace(finding: Pick<RuleFinding, "shot" | "subject">): string | null {
  if (finding.shot !== null) return `[Shot ${finding.shot}]`;
  if (finding.subject !== null) return `<Subject ${finding.subject}>`;
  return null;
}

export interface PromptEvaluation {
  /** 套用 inject 之後要送出的 prompt。 */
  prompt: string;
  findings: RuleFinding[];
  problems: readonly SelectionProblem[];
  /** 有任何問題或違反的規則：不能渲染。 */
  blocked: boolean;
}

const DETAILED = "detailed_description:";
const KIND_RANK = { style: 0, effect: 1, constraint: 2 } as const;

/**
 * detailed_description: 那一行的結尾在哪裡（文字要插在它後面）。行以換行（LF）結尾，緊接在換行前的 CR 屬於換行、留在原處
 * （後面沒有 LF 的 CR 只是這一行的內容，例如最後一行結尾的 CR）；這一行在冒號後只能有空格或 tab，而且必須從行首開始。
 * 找不到為 -1。
 */
function detailedLineEnd(prompt: string): number {
  for (let start = 0; start <= prompt.length; ) {
    const feed = prompt.indexOf("\n", start);
    const lineEnd = feed < 0 ? prompt.length : feed;
    const contentEnd = feed > start && prompt[feed - 1] === "\r" ? feed - 1 : lineEnd;
    const line = prompt.slice(start, contentEnd);
    if (line.startsWith(DETAILED) && /^[ \t]*$/.test(line.slice(DETAILED.length))) return contentEnd;
    start = lineEnd + 1;
  }
  return -1;
}

/** 把 inject 段落加在 detailed_description: 那一行之後（沒有就放最前面、後面空一行）；空的或 prompt 已包含的段落跳過。 */
export function injectText(prompt: string, blocks: readonly string[]): string {
  const missing = blocks.map(trimmed).filter((block) => block !== "" && !prompt.includes(block));
  if (missing.length === 0) return prompt;
  const text = missing.join("\n");
  const at = detailedLineEnd(prompt);
  return at < 0 ? `${text}\n\n${prompt}` : `${prompt.slice(0, at)}\n${text}${prompt.slice(at)}`;
}

interface FindingBase {
  ref: StudioPluginRef;
  label: string;
  shot: number | null;
  subject: number | null;
}

/** forbid 命中的與 require 沒命中的項目（比對一段文字：整份 prompt 或一個鏡頭）。 */
function checkFindings(checks: CompiledChecks, base: FindingBase, text: string, normalized: () => string, required: boolean): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const item of checks.forbid) {
    const match = item.find(text, normalized);
    if (match !== null) findings.push({ ...base, itemId: item.id, kind: "forbid", message: pluginText(item.message, item.id), match });
  }
  if (!required) return findings;
  for (const item of checks.require) {
    if (item.find(text, normalized) === null) findings.push({ ...base, itemId: item.id, kind: "require", message: pluginText(item.message, item.id), match: null });
  }
  return findings;
}

/** 正規化的寫法只在用到詞組清單時才算，而且只算一次。 */
function lazyNormalized(text: string): () => string {
  let cache: string | null = null;
  return () => (cache ??= normalizePhraseText(text));
}

/** 逐鏡檢查：一個鏡頭接一個（forbid 在前、require 只查點名角色的鏡頭），最後是沒有任何鏡頭點名的角色。 */
function shotFindings(shots: CompiledShots, base: Omit<FindingBase, "shot" | "subject">, scan: ShotScan): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const named = new Set<number>();
  for (const shot of scan.shots) {
    const tags = namedSubjects(shot.text);
    for (const number of tags) named.add(number);
    findings.push(...checkFindings(shots, { ...base, shot: shot.number, subject: null }, shot.text, lazyNormalized(shot.text), tags.size > 0));
  }
  const every = shots.everySubject;
  if (every) {
    for (const subject of scan.subjects) {
      if (!named.has(subject)) findings.push({ ...base, shot: null, subject, itemId: every.id, kind: "require", message: pluginText(every.message, every.id), match: null });
    }
  }
  return findings;
}

function ruleFindings(entry: RegistryRule, prompt: string, normalized: () => string, scan: () => ShotScan): RuleFinding[] {
  const compiled = compiledRule(entry);
  const base = { ref: entry.ref, label: ruleLabel(entry) };
  const findings = checkFindings(compiled, { ...base, shot: null, subject: null }, prompt, normalized, true);
  if (compiled.shots) findings.push(...shotFindings(compiled.shots, base, scan()));
  return findings;
}

/** 已經解析好的選取套用到一個 prompt。 */
export function evaluateSelection(selection: PluginSelection, prompt: string): PromptEvaluation {
  const normalized = lazyNormalized(prompt);
  let scanned: ShotScan | null = null;
  const scan = () => (scanned ??= scanShots(prompt));
  const findings = selection.rules.flatMap((entry) => ruleFindings(entry, prompt, normalized, scan));
  const ordered = [...selection.rules].sort((a, b) => KIND_RANK[a.rule.kind] - KIND_RANK[b.rule.kind]);
  return {
    prompt: injectText(
      prompt,
      ordered.map((entry) => entry.rule.inject ?? ""),
    ),
    findings,
    problems: selection.problems,
    blocked: selection.problems.length > 0 || findings.length > 0,
  };
}
