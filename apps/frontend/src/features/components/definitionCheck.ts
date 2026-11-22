// Why the Node refuses a component's stored definition: last_error UNSUPPORTED_SETTING from the provider check
// (packages/node phasyn_node/settings_check.py, the rules of a settings PATCH). Its details come in three shapes
// (phasyn_components.contracts and .settings):
//   {errors: ["<path>: <message>", …]} (sometimes with "schema"): the path is "/"-joined inside the settings, "(root)"
//     for the whole object; the message is jsonschema's own text;
//   {selector, part, rejected_fields, index}: part override `index` sets fields its part does not accept;
//   {selector, index, matched: 0}: part override `index` matches no part.
// Fields the provider does not know cannot be removed with a settings PATCH (null is a value); only a full definition
// (PUT, while stopped) can drop them. Every other problem is a value the settings editor can change. Pure.
import type { ApiErrorBody, InstanceSettings } from "@/api/generated/contracts";
import { cloneJson, isRecord } from "@/lib/json";
import { t } from "@/i18n";

/** A key inside the settings, from the root (array positions as numbers). */
export type SettingsPath = readonly (string | number)[];

export interface ValueProblem {
  /** Dotted path as reported ("" = the settings as a whole). */
  path: string;
  /** Where the settings editor should open for it (a settings root such as "load", or the part overrides). */
  jump: string;
  /** The checker's own text, shown as is. */
  message: string;
}

export interface DefinitionProblems {
  unknownFields: readonly SettingsPath[];
  values: readonly ValueProblem[];
}

const SETTINGS_ROOTS: ReadonlySet<string> = new Set(["load", "invoke", "recording"]);
const PART_OVERRIDES = "load.part_overrides";
/** jsonschema's text for additionalProperties / unevaluatedProperties false. */
const NOT_ALLOWED = /^(?:Additional|Unevaluated) properties are not allowed \((.*) (?:was|were) unexpected\)$/s;
/** Python repr of each unexpected name. */
const QUOTED = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

function segments(raw: string): (string | number)[] {
  if (raw === "" || raw === "(root)") return [];
  return raw.split("/").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** "load.part_overrides[0].settings.x" style. */
export function dottedPath(path: SettingsPath): string {
  return path.reduce<string>((out, part) => (typeof part === "number" ? `${out}[${String(part)}]` : out ? `${out}.${part}` : part), "");
}

function jumpFor(path: SettingsPath): string {
  const [root, next] = path;
  if (root === "load" && next === "part_overrides") return PART_OVERRIDES;
  // A path outside the settings roots comes from a part's own values (checked after the overrides are resolved).
  return typeof root === "string" && SETTINGS_ROOTS.has(root) ? dottedPath(path) : PART_OVERRIDES;
}

function readErrors(errors: readonly unknown[], unknown: SettingsPath[], values: ValueProblem[]): void {
  for (const entry of errors) {
    if (typeof entry !== "string") continue;
    const cut = entry.indexOf(": ");
    const base = segments(cut === -1 ? "" : entry.slice(0, cut));
    const message = cut === -1 ? entry : entry.slice(cut + 2);
    const listed = NOT_ALLOWED.exec(message);
    const names = listed ? [...(listed[1] ?? "").matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1")) : [];
    const inSettings = base.length === 0 || (typeof base[0] === "string" && SETTINGS_ROOTS.has(base[0]));
    if (names.length > 0 && inSettings) {
      for (const name of names) unknown.push([...base, name]);
    } else {
      values.push({ path: dottedPath(base), jump: jumpFor(base), message });
    }
  }
}

/** The problems a refused definition reports, or null when the last error is not a refused definition. */
export function definitionProblems(error: ApiErrorBody | null | undefined): DefinitionProblems | null {
  if (error?.code !== "UNSUPPORTED_SETTING") return null;
  const details = isRecord(error.details) ? error.details : {};
  const unknownFields: SettingsPath[] = [];
  const values: ValueProblem[] = [];
  if (Array.isArray(details["errors"])) readErrors(details["errors"], unknownFields, values);
  const index = typeof details["index"] === "number" && Number.isInteger(details["index"]) ? details["index"] : null;
  if (index !== null && Array.isArray(details["rejected_fields"])) {
    for (const field of details["rejected_fields"]) if (typeof field === "string") unknownFields.push(["load", "part_overrides", index, "settings", field]);
  } else if (index !== null && details["matched"] === 0 && typeof details["selector"] === "string") {
    values.push({ path: `${PART_OVERRIDES}[${String(index)}].selector`, jump: PART_OVERRIDES, message: t("selector「{selector}」沒有命中任何子部件", { selector: details["selector"] }) });
  }
  return { unknownFields, values };
}

/** A copy of `settings` without the given keys (keys that are not there are ignored). */
export function withoutFields(settings: InstanceSettings, paths: readonly SettingsPath[]): InstanceSettings {
  const copy = cloneJson(settings);
  for (const path of paths) {
    let node: unknown = copy;
    for (const part of path.slice(0, -1)) {
      node = Array.isArray(node) && typeof part === "number" ? (node as unknown[])[part] : isRecord(node) && typeof part === "string" && Object.hasOwn(node, part) ? node[part] : undefined;
    }
    const last = path.at(-1);
    if (isRecord(node) && typeof last === "string" && Object.hasOwn(node, last)) Reflect.deleteProperty(node, last);
  }
  return copy;
}
