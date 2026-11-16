// The Node this browser last showed in the components area (shared by the explorer and the components page); when
// localStorage is unavailable it is remembered for this session only.
import { createPersistentStore } from "@/lib/persistentStore";

const remembered = createPersistentStore<string | null>({
  key: "phasyn.choice.admin.node",
  initial: null,
  parse: (raw) => (typeof raw === "string" && raw ? raw : null),
  crossTab: false,
});

export function setRememberedNode(nodeId: string): void {
  remembered.set(nodeId);
}

export function useRememberedNode(): string | null {
  return remembered.use();
}
