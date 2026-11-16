// Control batches: the components of one Node and resource group (one device) must load one after another — the Node
// answers DEVICE_BUSY to parallel loads on one device — while different groups may run in parallel. Pure.

export interface ControlUnit {
  nodeId: string;
  resourceGroup: string;
}

/** Each array holds the units of one Node + resource group (run in order); arrays may run in parallel. Input order is kept. */
export function planControlBatches<T extends ControlUnit>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = `${item.nodeId}::${item.resourceGroup}`;
    const list = groups.get(group);
    if (list) list.push(item);
    else groups.set(group, [item]);
  }
  return [...groups.values()];
}
