// Start or stop components: one request each, then wait for the catalog to show the result (never resent).
// Components on the same Node and resource group run one after another, different groups in parallel, and later clicks
// queue behind the group's earlier work, so one device never gets two loads at once. A failure stops its group and the
// rest of that group are marked as not sent. Replacing loaded members of an exclusive group is confirmed with the user
// first (render `dialog` once). Unmounting stops the waiting; requests already sent are not withdrawn.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fetchCatalog } from "@/api/catalog";
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { qk } from "@/api/keys";
import { instanceKey } from "@/api/types";
import { isAbortError } from "@/lib/async";
import { t, tServer } from "@/i18n";
import { planControlBatches } from "./batches";
import { requestStart, sendControl } from "./exclusive";
import { StartCancelled } from "./startWatch";
import { useExclusiveConfirm } from "./useExclusiveConfirm";
import { findIn, waitUntilReady, waitUntilStopped, WaitTimeout, type ReadComponent } from "./wait";

export type ControlAction = "start" | "stop";
export type ControlPhase = "queued" | "starting" | "stopping";

export interface ControlFailure {
  action: ControlAction;
  message: string;
  /** Timeout or lost connection: the Node may still be working. */
  unknown: boolean;
  /** An earlier component of the same group failed, so this one was not sent. */
  skipped?: boolean;
}

export type ControlOutcome = { kind: "done"; replaced: readonly string[] } | { kind: "failed"; failure: ControlFailure };

export interface ControlEvent {
  target: ComponentDescriptor;
  action: ControlAction;
  outcome: ControlOutcome;
}

export interface ComponentControl {
  /** Per instanceKey(node_id, component_id): waiting in its group's queue, or being started／stopped. */
  phase: Readonly<Record<string, ControlPhase>>;
  /** Per instanceKey: why the last start／stop did not complete (cleared when it is tried again). */
  failures: Readonly<Record<string, ControlFailure>>;
  /** Start or stop these components; resolves when every group has finished (never rejects). */
  run: (components: readonly ComponentDescriptor[], action: ControlAction) => Promise<void>;
  dismiss: (key: string) => void;
  /** The exclusive-group confirmation dialog: render it once. */
  dialog: ReactNode;
}

/** The user declined to stop the other members of the exclusive group: nothing was sent. */
class Declined extends Error {}

function failureOf(action: ControlAction, error: unknown): ControlFailure {
  if (error instanceof Declined) return { action, message: t("沒有送出：沒有確認停止互斥群組的其他元件"), unknown: false, skipped: true };
  if (error instanceof WaitTimeout) return { action, message: error.message, unknown: true };
  if (error instanceof StartCancelled) return { action, message: error.message, unknown: error.unknown };
  if (isApiError(error)) return { action, message: t("{code}：{message}", { code: error.code, message: tServer(error.message) }), unknown: error.status === 0 || error.remoteOutcomeUnknown };
  return { action, message: error instanceof Error ? error.message : String(error), unknown: false };
}

interface Unit {
  key: string;
  nodeId: string;
  resourceGroup: string;
  target: ComponentDescriptor;
}

export function useComponentControl(options: { onEvent?: (event: ControlEvent) => void } = {}): ComponentControl {
  const client = useQueryClient();
  const { confirm, dialog } = useExclusiveConfirm();
  const [phase, setPhase] = useState<Record<string, ControlPhase>>({});
  const [failures, setFailures] = useState<Record<string, ControlFailure>>({});
  /** Keys being worked on (checked synchronously, so double clicks never send twice). */
  const inFlight = useRef(new Set<string>());
  /** The tail of each group's queue (runBatch never rejects, so the chain never breaks). */
  const tails = useRef(new Map<string, Promise<void>>());
  const abortRef = useRef<AbortController | null>(null);
  const onEvent = useRef(options.onEvent);

  useEffect(() => {
    onEvent.current = options.onEvent;
  });

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);

  const setPhaseOf = useCallback((key: string, value: ControlPhase | null) => {
    setPhase((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);

  // Reads through the query cache so every view of the catalog sees the new states while we wait.
  const readCatalog = useCallback(() => client.fetchQuery({ queryKey: qk.catalog(), queryFn: ({ signal }) => fetchCatalog(signal), staleTime: 0 }), [client]);
  const read = useCallback<ReadComponent>(async (target) => findIn(await readCatalog(), target), [readCatalog]);

  const runOne = useCallback(
    async (target: ComponentDescriptor, action: ControlAction, signal: AbortSignal): Promise<readonly string[]> => {
      // Writes carry no signal: leaving the page stops the waiting, it does not withdraw a request already sent.
      if (action === "stop") {
        await sendControl(target, { action: "stop" });
        await waitUntilStopped(target, { signal, read });
        return [];
      }
      const result = await requestStart(target, { catalog: await readCatalog(), confirm });
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (result.kind === "declined") throw new Declined();
      await waitUntilReady(target, { signal, read });
      return result.replaced;
    },
    [confirm, read, readCatalog],
  );

  const runBatch = useCallback(
    async (batch: readonly Unit[], action: ControlAction, signal: AbortSignal) => {
      for (let index = 0; index < batch.length; index += 1) {
        const unit = batch[index];
        if (!unit) continue;
        if (signal.aborted) return;
        setPhaseOf(unit.key, action === "start" ? "starting" : "stopping");
        let replaced: readonly string[];
        try {
          replaced = await runOne(unit.target, action, signal);
        } catch (error) {
          const rest = batch.slice(index);
          for (const item of rest) {
            inFlight.current.delete(item.key);
            setPhaseOf(item.key, null);
          }
          if (isAbortError(error)) return;
          const failure = failureOf(action, error);
          const skipped: ControlFailure = {
            action,
            message: t("同一資源群組的 {component_id} 沒有完成，這個元件沒有送出", { component_id: unit.target.component_id }),
            unknown: false,
            skipped: true,
          };
          setFailures((current) => {
            const next = { ...current, [unit.key]: failure };
            for (const item of rest.slice(1)) next[item.key] = skipped;
            return next;
          });
          onEvent.current?.({ target: unit.target, action, outcome: { kind: "failed", failure } });
          return;
        } finally {
          void client.invalidateQueries({ queryKey: qk.catalog() });
        }
        inFlight.current.delete(unit.key);
        setPhaseOf(unit.key, null);
        onEvent.current?.({ target: unit.target, action, outcome: { kind: "done", replaced } });
      }
    },
    [client, runOne, setPhaseOf],
  );

  const run = useCallback(
    async (components: readonly ComponentDescriptor[], action: ControlAction) => {
      const signal = abortRef.current?.signal;
      if (!signal || signal.aborted) return;
      const units: Unit[] = components
        .map((target) => ({ key: instanceKey(target.node_id, target.component_id), nodeId: target.node_id, resourceGroup: target.device.resource_group, target }))
        .filter((unit) => !inFlight.current.has(unit.key));
      if (units.length === 0) return;
      for (const unit of units) {
        inFlight.current.add(unit.key);
        setPhaseOf(unit.key, "queued");
      }
      setFailures((current) => {
        const next = { ...current };
        for (const unit of units) delete next[unit.key];
        return next;
      });
      await Promise.all(
        planControlBatches(units).map((batch) => {
          const first = batch[0];
          const group = first ? `${first.nodeId}::${first.resourceGroup}` : "";
          const previous = tails.current.get(group) ?? Promise.resolve();
          const tail = previous.then(() => runBatch(batch, action, signal));
          tails.current.set(group, tail);
          void tail.then(() => {
            if (tails.current.get(group) === tail) tails.current.delete(group);
          });
          return tail;
        }),
      );
    },
    [runBatch, setPhaseOf],
  );

  const dismiss = useCallback((key: string) => {
    setFailures((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  return { phase, failures, run, dismiss, dialog };
}
