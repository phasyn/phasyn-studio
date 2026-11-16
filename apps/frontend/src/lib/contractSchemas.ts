// The parts of the authoritative contract (contracts/component.schema.json) the forms fall back to when a provider
// declares no schema. They come from src/api/generated/contracts.subset.json, the $defs closure gen-contracts extracts,
// so the bundle carries a few KB instead of the whole contract.
import contract from "@/api/generated/contracts.subset.json";
import { isRecord } from "./json";
import type { JsonSchema } from "./schema";

const ROOT: JsonSchema = isRecord(contract) ? contract : {};
const DEFS = isRecord(ROOT.$defs) ? ROOT.$defs : {};

function def(name: string): JsonSchema {
  const value = DEFS[name];
  return isRecord(value) ? value : { type: "object" };
}

/** The recording section belongs to the Recorder: providers usually declare only {type: object}, so forms use the contract's RecorderConfig. */
export const RECORDER_CONFIG_SCHEMA: JsonSchema = def("RecorderConfig");
/** The root that `#/$defs/...` references resolve against. */
export const CONTRACT_ROOT: JsonSchema = ROOT;
