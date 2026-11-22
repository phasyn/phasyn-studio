// Reading a JSON Schema (2020-12 subset) the way the forms need it: local $ref resolution, one field's description
// (type, nullability, options, range, default, texts) and an object's properties. The server stays the authority.
import { tServer } from "@/i18n/server";
import { isRecord, stableStringify, type JsonObject } from "@/lib/json";

export type JsonSchema = JsonObject;

/** `null` is a field that only accepts null (for example a provider's {"type":"null"} for "no setting offered"). */
export type FieldKind = "enum" | "boolean" | "integer" | "number" | "string" | "object" | "array" | "const" | "null" | "json";

export interface FieldInfo {
  kind: FieldKind;
  nullable: boolean;
  /** The schema with its null branch removed and $ref resolved. */
  schema: JsonSchema;
  enumValues: unknown[];
  constValue: unknown;
  minimum: number | null;
  maximum: number | null;
  exclusiveMinimum: number | null;
  exclusiveMaximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  hasDefault: boolean;
  defaultValue: unknown;
  description: string | null;
  title: string | null;
  readOnly: boolean;
}

function lookupPointer(ref: string, root: JsonSchema | undefined): JsonSchema | null {
  if (!root || !ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "") return root;
  let current: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return isRecord(current) ? current : null;
}

/** Resolves a local `$ref` (`#/$defs/X`, `#/definitions/X`); sibling keywords override the target's. */
export function resolveSchema(node: unknown, root?: JsonSchema): JsonSchema | null {
  let current: unknown = node;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!isRecord(current)) return null;
    const ref = current["$ref"];
    if (typeof ref !== "string") return current;
    const target = lookupPointer(ref, root);
    if (!target) return current;
    const { $ref: _ref, ...rest } = current;
    current = Object.keys(rest).length > 0 ? { ...target, ...rest } : target;
  }
  return isRecord(current) ? current : null;
}

/**
 * A dedicated control the provider asks for with the `x-phasyn-control` keyword (on the schema or one of its
 * anyOf / oneOf branches, e.g. a nullable list), or null. Unknown names fall back to the generic controls.
 */
export function schemaControl(node: unknown, root?: JsonSchema): string | null {
  const schema = resolveSchema(node, root);
  if (!schema) return null;
  const own = schema["x-phasyn-control"];
  if (typeof own === "string") return own;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = resolveSchema(branch, root)?.["x-phasyn-control"];
      if (typeof found === "string") return found;
    }
  }
  return null;
}

export function typeList(schema: JsonSchema): string[] | null {
  const type = schema["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string");
  return null;
}

export function isNullSchema(schema: JsonSchema): boolean {
  const types = typeList(schema);
  if (types !== null && types.length === 1 && types[0] === "null") return true;
  if (Object.hasOwn(schema, "const") && schema["const"] === null) return true;
  return Array.isArray(schema["enum"]) && schema["enum"].length > 0 && (schema["enum"] as unknown[]).every((value) => value === null);
}

const STRUCTURAL_KEYS = ["properties", "items", "anyOf", "oneOf", "allOf", "$ref", "additionalProperties", "prefixItems"];

/**
 * When every non-null branch is only a const or an enum (for example anyOf: [{const:"a"},{const:"b"},{type:"null"}]),
 * merges them into one option list; any branch with structure (object, array, nested union) returns null (JSON editing).
 */
function mergedEnumValues(variants: readonly JsonSchema[]): { values: unknown[]; hasNull: boolean } | null {
  const values: unknown[] = [];
  const seen = new Set<string>();
  let hasNull = false;
  for (const variant of variants) {
    if (STRUCTURAL_KEYS.some((key) => Object.hasOwn(variant, key))) return null;
    let options: unknown[];
    if (Object.hasOwn(variant, "const")) options = [variant["const"]];
    else if (Array.isArray(variant["enum"])) options = variant["enum"] as unknown[];
    else return null;
    for (const option of options) {
      if (option === null) {
        hasNull = true;
        continue;
      }
      const key = stableStringify(option);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(option);
    }
  }
  return values.length > 0 ? { values, hasNull } : null;
}

export function variantsOf(schema: JsonSchema): unknown[] | null {
  if (Array.isArray(schema["anyOf"])) return schema["anyOf"] as unknown[];
  if (Array.isArray(schema["oneOf"])) return schema["oneOf"] as unknown[];
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One field as a form sees it: type, nullability, options, range, default and texts.
 * A nullable union (anyOf / oneOf with {type:"null"}, a type array with "null", an enum with null) becomes "main type +
 * nullable"; a field that only accepts null is kind="null"; only a genuinely complex union is kind="json".
 */
export function describeField(node: unknown, root?: JsonSchema): FieldInfo {
  const outer = resolveSchema(node, root) ?? {};
  let schema: JsonSchema = outer;
  let nullable = false;
  let nullOnly = false;
  let unionKind = false;
  const variants = variantsOf(outer);
  if (variants) {
    const resolved = variants.map((variant) => resolveSchema(variant, root)).filter((v): v is JsonSchema => v !== null);
    const nonNull = resolved.filter((variant) => !isNullSchema(variant));
    nullable = nonNull.length < resolved.length;
    const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = outer;
    const only = nonNull.length === 1 ? nonNull[0] : undefined;
    if (only) {
      schema = { ...only, ...siblings };
    } else if (nonNull.length === 0 && resolved.length > 0) {
      nullOnly = true;
      schema = siblings;
    } else {
      const merged = mergedEnumValues(nonNull);
      if (merged) {
        schema = { ...siblings, enum: merged.values };
        if (merged.hasNull) nullable = true;
      } else {
        unionKind = true;
      }
    }
  }
  const types = typeList(schema);
  if (types?.includes("null") === true) {
    nullable = true;
    const rest = types.filter((type) => type !== "null");
    if (rest.length === 0) nullOnly = true;
    schema = { ...schema, type: rest.length === 1 ? rest[0] : rest };
  }
  let enumValues: unknown[] = [];
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"] as unknown[];
    if (values.includes(null)) nullable = true;
    enumValues = values.filter((value) => value !== null);
    if (values.length > 0 && enumValues.length === 0) nullOnly = true;
  }
  const info: FieldInfo = {
    kind: "json",
    nullable,
    schema,
    enumValues,
    constValue: schema["const"],
    minimum: num(schema["minimum"]),
    maximum: num(schema["maximum"]),
    exclusiveMinimum: num(schema["exclusiveMinimum"]),
    exclusiveMaximum: num(schema["exclusiveMaximum"]),
    minLength: num(schema["minLength"]),
    maxLength: num(schema["maxLength"]),
    pattern: typeof schema["pattern"] === "string" ? schema["pattern"] : null,
    hasDefault: Object.hasOwn(outer, "default") || Object.hasOwn(schema, "default"),
    defaultValue: Object.hasOwn(outer, "default") ? outer["default"] : schema["default"],
    // A provider schema's description and title are fixed server texts: show the translation when there is one (display
    // only; the submitted settings do not change).
    description: tServer(str(outer["description"]) ?? str(schema["description"])) ?? null,
    title: tServer(str(outer["title"]) ?? str(schema["title"])) ?? null,
    readOnly: outer["readOnly"] === true || schema["readOnly"] === true,
  };
  if (unionKind) return info;
  if (Object.hasOwn(schema, "const")) return { ...info, kind: "const" };
  if (nullOnly) return { ...info, kind: "null", nullable: true };
  if (enumValues.length > 0) return { ...info, kind: "enum" };
  const nonNullTypes = typeList(schema)?.filter((type) => type !== "null") ?? null;
  if (nonNullTypes?.length === 1) {
    switch (nonNullTypes[0]) {
      case "boolean":
        return { ...info, kind: "boolean" };
      case "integer":
        return { ...info, kind: "integer" };
      case "number":
        return { ...info, kind: "number" };
      case "string":
        return { ...info, kind: "string" };
      case "object":
        return { ...info, kind: "object" };
      case "array":
        return { ...info, kind: "array" };
      case undefined:
      default:
        return info;
    }
  }
  if (nonNullTypes && nonNullTypes.length > 1) return info;
  if (isRecord(schema["properties"])) return { ...info, kind: "object" };
  if (schema["items"] !== undefined) return { ...info, kind: "array" };
  return info;
}

/** An object schema's properties in declaration order; [] when it is not an object or declares none. */
export function objectProperties(node: unknown, root?: JsonSchema): [string, unknown][] {
  const info = describeField(node, root);
  const properties = info.schema["properties"];
  return isRecord(properties) ? Object.entries(properties) : [];
}

export function hasDeclaredProperties(node: unknown, root?: JsonSchema): boolean {
  const info = describeField(node, root);
  return isRecord(info.schema["properties"]);
}

export function requiredKeys(node: unknown, root?: JsonSchema): Set<string> {
  const info = describeField(node, root);
  const required = info.schema["required"];
  return new Set(Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : []);
}

/** The schema of one property of an object schema; null when it does not exist. */
export function propertySchema(node: unknown, key: string, root?: JsonSchema): unknown {
  const info = describeField(node, root);
  const properties = info.schema["properties"];
  if (!isRecord(properties) || !Object.hasOwn(properties, key)) return null;
  return properties[key];
}

export function additionalPropertiesAllowed(node: unknown, root?: JsonSchema): boolean {
  const info = describeField(node, root);
  return info.schema["additionalProperties"] !== false;
}

/** The starting value of a field that is not set yet: its default → its first option → the empty value of its type. */
export function initialValueFor(info: FieldInfo): unknown {
  if (info.hasDefault) return info.defaultValue;
  switch (info.kind) {
    case "enum":
      return info.enumValues[0] ?? null;
    case "const":
      return info.constValue;
    case "boolean":
      return false;
    case "integer":
    case "number":
      return info.minimum ?? 0;
    case "string":
      return "";
    case "object":
      return {};
    case "array":
      return [];
    case "null":
      return null;
    case "json":
    default:
      return null;
  }
}

/** The starting value when a nullable field switches back to a value: a non-null default → the empty value of its type (never null again). */
export function initialNonNullValue(info: FieldInfo): unknown {
  if (info.hasDefault && info.defaultValue !== null && info.defaultValue !== undefined) return info.defaultValue;
  return initialValueFor({ ...info, hasDefault: false, nullable: false });
}

/** Defaults of an object schema's top-level properties (only the ones that declare a default). */
export function schemaDefaults(node: unknown, root?: JsonSchema): JsonObject {
  const out: JsonObject = {};
  for (const [key, child] of objectProperties(node, root)) {
    const info = describeField(child, root);
    if (info.hasDefault) out[key] = info.defaultValue;
  }
  return out;
}
