// Exclusive group of a new or duplicated instance (definition `exclusive_group`): the
// names the contract accepts, and a prefill taken from instances of the same provider kind on the same resource group of
// that Node. Only the Node enforces the group (on start/restart); this module only helps fill the form. Pure.
import type { ComponentDescriptor, ProviderInfo } from "@/api/generated/contracts";
import { t } from "@/i18n";

/** The contract's pattern for `exclusive_group` (exclusiveGroup.test.ts checks it against contracts/component.schema.json). */
export const EXCLUSIVE_GROUP_PATTERN = "^[a-z0-9][a-z0-9_.-]{0,63}$";
const GROUP_RE = new RegExp(EXCLUSIVE_GROUP_PATTERN, "u");

/** The value to send: surrounding blanks dropped; empty → null (the key is left out of the definition). */
export function groupValue(text: string): string | null {
  const value = text.trim();
  return value === "" ? null : value;
}

/** Why the text is not a group name the contract accepts, or null (an empty field is valid: no group). */
export function exclusiveGroupError(text: string): string | null {
  const value = groupValue(text);
  if (value === null) return null;
  return GROUP_RE.test(value) ? null : t("只能用小寫英文字母、數字與 _ . -，以字母或數字開頭，最多 64 個字元");
}

export type GroupMember = Pick<ComponentDescriptor, "component_id" | "provider_id" | "runtime_id" | "exclusive_group" | "device">;

export interface GroupSuggestion {
  group: string;
  /** The instances (component_id) that already use it. */
  from: readonly string[];
}

/**
 * The group that instances of the same provider kind on the same resource group of the Node use (the most used one;
 * ties by name), or null when there is none. `providers` is the Node's provider list, which knows each provider's kind.
 */
export function suggestExclusiveGroup(
  kind: string | null | undefined,
  resourceGroup: string | null | undefined,
  members: readonly GroupMember[],
  providers: readonly Pick<ProviderInfo, "provider_id" | "runtime_id" | "kind">[],
): GroupSuggestion | null {
  if (!(kind != null && kind !== "") || !(resourceGroup != null && resourceGroup !== "")) return null;
  const kinds = new Map(providers.map((item) => [`${item.runtime_id}::${item.provider_id}`, item.kind]));
  const uses = new Map<string, string[]>();
  for (const member of members) {
    if (!(member.exclusive_group != null && member.exclusive_group !== "") || member.device.resource_group !== resourceGroup) continue;
    if (kinds.get(`${member.runtime_id}::${member.provider_id}`) !== kind) continue;
    uses.set(member.exclusive_group, [...(uses.get(member.exclusive_group) ?? []), member.component_id]);
  }
  const [best] = [...uses].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
  return best ? { group: best[0], from: best[1] } : null;
}

/** Every group already used on the Node (input suggestions), sorted. */
export function groupsInUse(members: readonly Pick<ComponentDescriptor, "exclusive_group">[]): string[] {
  return [...new Set(members.flatMap((member) => ((member.exclusive_group != null && member.exclusive_group !== "") ? [member.exclusive_group] : [])))].sort();
}
