// Exclusive groups (contract `exclusive_group`): components that must never be loaded together on one Node. The example
// configs put every DiT in group "dit" because each one needs a lot of host memory. Only the Node enforces the rule, on
// start/restart: a busy member (loading, stopping or running a call) → 409 EXCLUSIVE_GROUP_BUSY; idle members only →
// 409 EXCLUSIVE_GROUP_CONFLICT, unless the request carries `replace_exclusive: true` and the Node stops them first.
// The client reads the catalog only to warn before the click, asks the user before sending `replace_exclusive`, and never
// stops other components itself. Every request is sent once; a conflict the catalog did not show is confirmed with the
// user before the second request (a user decision, not an automatic retry).
import type { Catalog, ComponentDescriptor, ComponentState, ControlRequest } from "@/api/generated/contracts";
import { controlComponent } from "@/api/components";
import { isApiError } from "@/api/http";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export interface ExclusiveHolder {
  component_id: string;
  state: ComponentState;
  active_call_id: string | null;
}

/** Other members of the target's exclusive group, on the target's Node, that currently hold a model. */
export interface ExclusiveConflict {
  group: string;
  holders: readonly ExclusiveHolder[];
}

export type ExclusiveTarget = Pick<ComponentDescriptor, "node_id" | "component_id" | "exclusive_group">;

/** States in which a member holds (or may still hold) a model; mirrors the Node's rule. */
const HOLDING: ReadonlySet<ComponentState> = new Set(["loading", "ready", "busy", "stopping"]);
/** States in which the Node refuses to replace the member (EXCLUSIVE_GROUP_BUSY). */
const BUSY: ReadonlySet<ComponentState> = new Set(["loading", "busy", "stopping"]);

const CONFLICT_CODES: ReadonlySet<string> = new Set(["EXCLUSIVE_GROUP_CONFLICT", "EXCLUSIVE_GROUP_BUSY"]);

/** The holders the catalog snapshot shows (advisory: the Node decides when the request arrives). Pure. */
export function exclusiveConflict(target: ExclusiveTarget, catalog: Pick<Catalog, "nodes"> | undefined): ExclusiveConflict | null {
  const group = target.exclusive_group;
  if (!group || !catalog) return null;
  const node = catalog.nodes.find((item) => item.node_id === target.node_id);
  const holders = (node?.components ?? [])
    .filter((item) => item.exclusive_group === group && item.component_id !== target.component_id && HOLDING.has(item.state))
    .map(({ component_id, state, active_call_id }) => ({ component_id, state, active_call_id }));
  return holders.length > 0 ? { group, holders } : null;
}

function busyHolder(conflict: ExclusiveConflict | null): ExclusiveHolder | null {
  return conflict?.holders.find((holder) => BUSY.has(holder.state) || holder.active_call_id !== null) ?? null;
}

/** Why a start cannot be sent now (a holder is busy), or null. Pure. */
export function exclusiveBlockReason(conflict: ExclusiveConflict | null): string | null {
  const busy = busyHolder(conflict);
  if (!conflict || !busy) return null;
  const values = { group: conflict.group, component_id: busy.component_id };
  if (busy.state === "loading") return t("同一台 Node 的互斥群組 {group} 中，{component_id} 正在載入；一次只能載入一個，等它載入完成後再切換", values);
  if (busy.state === "stopping") return t("同一台 Node 的互斥群組 {group} 中，{component_id} 正在停止；等它停止後再啟動", values);
  return t("同一台 Node 的互斥群組 {group} 中，{component_id} 正在執行呼叫；一次只能載入一個，等它完成或先停止它", values);
}

/** What starting will do to the idle holders (shown next to the start button and in the confirmation). Pure. */
export function exclusiveReplaceNote(conflict: ExclusiveConflict): string {
  return t("啟動會先停止 {holders}：同一台 Node 的互斥群組 {group} 一次只能載入一個元件（大型模型需要大量主記憶體）。", {
    holders: formatList(conflict.holders.map((holder) => holder.component_id)),
    group: conflict.group,
  });
}

function parseHolders(value: unknown): ExclusiveHolder[] | null {
  if (!Array.isArray(value)) return null;
  const holders: ExclusiveHolder[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.component_id !== "string" || typeof record.state !== "string") return null;
    holders.push({
      component_id: record.component_id,
      state: record.state as ComponentState,
      active_call_id: typeof record.active_call_id === "string" ? record.active_call_id : null,
    });
  }
  return holders;
}

/** The conflict a 409 EXCLUSIVE_GROUP_CONFLICT / EXCLUSIVE_GROUP_BUSY response describes (contract ExclusiveGroupDetails). */
export function conflictFromError(error: unknown): { conflict: ExclusiveConflict; busy: boolean } | null {
  if (!isApiError(error) || !CONFLICT_CODES.has(error.code)) return null;
  const group = error.details.group;
  const holders = parseHolders(error.details.holders);
  if (typeof group !== "string" || holders === null) return null;
  return { conflict: { group, holders }, busy: error.code === "EXCLUSIVE_GROUP_BUSY" };
}

/** A holder is busy: nothing was sent (from the catalog) or the Node refused (EXCLUSIVE_GROUP_BUSY). */
export class ExclusiveBusy extends Error {
  readonly conflict: ExclusiveConflict;

  constructor(conflict: ExclusiveConflict, message: string) {
    super(message);
    this.name = "ExclusiveBusy";
    this.conflict = conflict;
  }
}

/** Asks the user whether the Node may stop the idle holders; resolves false when they decline. */
export type ConfirmReplace = (conflict: ExclusiveConflict, target: ExclusiveTarget) => Promise<boolean>;

export type SendControl = (body: ControlRequest) => Promise<ComponentDescriptor>;

export type ExclusiveStartResult = { kind: "sent"; descriptor: ComponentDescriptor; replaced: readonly string[] } | { kind: "declined" };

export interface RequestStartOptions {
  action?: Extract<ControlRequest["action"], "start" | "restart">;
  /** The latest catalog snapshot (for the warning before sending). */
  catalog: Pick<Catalog, "nodes"> | undefined;
  confirm: ConfirmReplace;
  /** Sends one control request (default: POST …/control). */
  send?: SendControl;
}

/** POST …/control for this component, once. */
export function sendControl(target: Pick<ComponentDescriptor, "node_id" | "component_id">, body: ControlRequest): Promise<ComponentDescriptor> {
  return controlComponent(target.node_id, target.component_id, body);
}

/**
 * Start (or restart) `target`, respecting its exclusive group: holders the catalog already shows are confirmed before
 * the request (a busy one throws ExclusiveBusy and nothing is sent); a conflict only the Node knew about is confirmed and
 * then sent once more with `replace_exclusive`. Other errors propagate unchanged.
 */
export async function requestStart(target: ExclusiveTarget, options: RequestStartOptions): Promise<ExclusiveStartResult> {
  const action = options.action ?? "start";
  const send = options.send ?? ((body: ControlRequest) => sendControl(target, body));
  const known = exclusiveConflict(target, options.catalog);
  const blocked = exclusiveBlockReason(known);
  if (known && blocked) throw new ExclusiveBusy(known, blocked);
  if (known && !(await options.confirm(known, target))) return { kind: "declined" };
  try {
    const descriptor = await send(known ? { action, replace_exclusive: true } : { action });
    return { kind: "sent", descriptor, replaced: known ? known.holders.map((holder) => holder.component_id) : [] };
  } catch (error) {
    const found = known ? null : conflictFromError(error);
    if (!found || found.busy) throw error;
    if (!(await options.confirm(found.conflict, target))) return { kind: "declined" };
    const descriptor = await send({ action, replace_exclusive: true });
    return { kind: "sent", descriptor, replaced: found.conflict.holders.map((holder) => holder.component_id) };
  }
}
