import type { PhasynStudioContracts } from "@/api/generated/contracts";
// The parts of the authoritative contract (contracts/component.schema.json) the forms fall back to when a provider
// declares no schema. They come from src/api/generated/contracts.subset.json, the $defs closure gen-contracts extracts,
// so the bundle carries a few KB instead of the whole contract.
import contract from "@/api/generated/contracts.subset.json";
import { isRecord } from "./json";
import type { JsonSchema } from "./schema";

const ROOT: JsonSchema = isRecord(contract) ? contract : {};
const DEFS = isRecord(ROOT["$defs"]) ? ROOT["$defs"] : {};

function def(name: string): JsonSchema {
  const value = DEFS[name];
  return isRecord(value) ? value : { type: "object" };
}

/** The recording section belongs to the Recorder: providers usually declare only {type: object}, so forms use the contract's RecorderConfig. */
export const RECORDER_CONFIG_SCHEMA: JsonSchema = def("RecorderConfig");
/** The root that `#/$defs/...` references resolve against. */
export const CONTRACT_ROOT: JsonSchema = ROOT;


// Result decoding checks the TypeScript-visible wire shape, including nested references and unions.
// Additional versioned fields remain readable. Numeric limits, date formats and provider policy
// belong to the Controller's authoritative protocol validation.
function wireType(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((part: unknown) => wireType(value, part));
  switch (expected) {
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return false;
  }
}

export function matchesWireShape(value: unknown, schema: unknown, definitions: Record<string, unknown>): boolean {
  if (schema === true) return true;
  if (!isRecord(schema)) return false;
  const reference = schema["$ref"];
  if (typeof reference === "string" && (!reference.startsWith("#/$defs/") || !matchesWireShape(value, definitions[reference.slice(8)], definitions))) return false;
  if (schema["type"] !== undefined && !wireType(value, schema["type"])) return false;
  if ("const" in schema && schema["const"] !== value) return false;
  const values: unknown = schema["enum"];
  if (Array.isArray(values) && !values.includes(value)) return false;
  for (const operator of ["oneOf", "anyOf", "allOf"] as const) {
    const variants: unknown = schema[operator];
    if (Array.isArray(variants)) {
      const ok = (part: unknown) => matchesWireShape(value, part, definitions);
      if (!(operator === "allOf" ? variants.every(ok) : variants.some(ok))) return false;
    }
  }
  if (Array.isArray(value) && schema["items"] !== undefined) return value.every((item: unknown) => matchesWireShape(item, schema["items"], definitions));
  if (!isRecord(value)) return true;
  const required: unknown = schema["required"];
  if (Array.isArray(required) && !required.every((key: unknown) => typeof key === "string" && Object.hasOwn(value, key))) return false;
  const properties = schema["properties"];
  const extra = schema["additionalProperties"];
  return Object.entries(value).every(([key, child]) => {
    if (isRecord(properties) && Object.hasOwn(properties, key)) return matchesWireShape(child, properties[key], definitions);
    return !isRecord(extra) || matchesWireShape(child, extra, definitions);
  });
}

let definitionsRequest: Promise<Record<string, unknown>> | undefined;

/** One promise per schema load: React's use() and parallel Controller requests share the same decoded contract. */
export function wireDefinitions(): Promise<Record<string, unknown>> {
  definitionsRequest ??= import("@contracts/component.schema.json").then((module) => module.default.$defs);
  return definitionsRequest;
}

/** The synchronous settings form already carries the contract’s Device and InstanceSettings definitions. */
export function matchesSetting<K extends "Device" | "InstanceSettings">(name: K, value: unknown): value is Required<PhasynStudioContracts>[K] {
  return matchesWireShape(value, DEFS[name], DEFS);
}
