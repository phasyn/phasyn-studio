// Waiting for a component to reach the state a control request asked for, by polling the catalog (lite catalog with the
// parts cache and pending writes). Nothing is ever resent; a timeout means the remote outcome is unknown.
import { fetchCatalog } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { sleep } from "@/lib/async";
import { formatMs } from "@/lib/format";
import { t } from "@/i18n";
import { observeStart, StartCancelled, watchStart } from "./startWatch";
import { failureText } from "@/lib/errors";

/** How long to wait for a load or stop before reporting an unknown outcome. */
export const WAIT_TIMEOUT_MS = 30 * 60 * 1000;
/** Catalog poll interval while waiting (the Node reports a new snapshot at most every few seconds). */
export const POLL_MS = 1500;

/** Waited longer than the timeout: the Node may still be working. The message names what was awaited and the limit used. */
export class WaitTimeout extends Error {
  constructor(awaited: "ready" | "stopped", timeoutMs: number) {
    const limit = formatMs(timeoutMs);
    super(
      awaited === "ready"
        ? t("等待就緒逾時（{limit}）：遠端結果未知，請查看元件狀態", { limit })
        : t("等待停止逾時（{limit}）：遠端結果未知，請查看元件狀態", { limit }),
    );
    this.name = "WaitTimeout";
  }
}

export type ComponentRef = Pick<ComponentDescriptor, "node_id" | "component_id">;

/** Reads the component's current descriptor; null while the catalog does not list it. */
export type ReadComponent = (target: ComponentRef, signal: AbortSignal) => Promise<ComponentDescriptor | null>;

export function findIn(catalog: { nodes: readonly { node_id: string; components: readonly ComponentDescriptor[] }[] }, target: ComponentRef): ComponentDescriptor | null {
  return catalog.nodes.find((node) => node.node_id === target.node_id)?.components.find((item) => item.component_id === target.component_id) ?? null;
}

export const readFromCatalog: ReadComponent = async (target, signal) => findIn(await fetchCatalog(signal), target);

export interface WaitOptions {
  signal: AbortSignal;
  read?: ReadComponent;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

/**
 * After a start (or restart) request: resolves once the component is ready or busy. `before` is the descriptor seen
 * before sending, so an old error still in the snapshot is not taken as this load's result (see startWatch).
 * Throws Error (load failed), StartCancelled, WaitTimeout or an AbortError.
 */
export async function waitUntilReady(before: ComponentDescriptor, options: WaitOptions): Promise<void> {
  const { signal, read = readFromCatalog, timeoutMs = WAIT_TIMEOUT_MS, pollMs = POLL_MS, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  let watch = watchStart(before, now());
  while (now() < deadline) {
    await sleep(pollMs, signal);
    const observed = observeStart(watch, await read(before, signal), now());
    watch = observed.watch;
    const outcome = observed.outcome;
    if (outcome.kind === "ready") return;
    if (outcome.kind === "failed") throw new Error(outcome.message);
    if (outcome.kind === "cancelled") throw new StartCancelled(outcome.message, outcome.unknown);
  }
  throw new WaitTimeout("ready", timeoutMs);
}

/** After a stop request: resolves once stopped. Stop is only sent from a loaded state, so an error state is this stop's failure. */
export async function waitUntilStopped(target: ComponentRef, options: WaitOptions): Promise<void> {
  const { signal, read = readFromCatalog, timeoutMs = WAIT_TIMEOUT_MS, pollMs = POLL_MS, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs, signal);
    const current = await read(target, signal);
    if (current?.state === "stopped") return;
    if (current?.state === "error") throw new Error(current.last_error ? failureText(current.last_error.code, current.last_error.message) : t("元件進入錯誤狀態"));
  }
  throw new WaitTimeout("stopped", timeoutMs);
}
