// Short tag for the device a component runs on. The catalog carries no GPU model names, only device.kind and
// resource_group, so the tag is derived from the resource-group naming convention: `gpu-<name>` for GPUs
// (gpu-0, gpu-1, gpu-uma) and `cpu` / `cpu-*` for CPU components. Used in place text such as
// "[GPU 0] Node A（GPU 0 + GPU 1）" so components on one Node show which device they use.
import type { ComponentDescriptor } from "@/api/generated/contracts";

type Device = Pick<ComponentDescriptor["device"], "kind" | "resource_group">;

/** resource group → tag: gpu-0 → GPU 0, gpu-uma → GPU UMA, cpu / cpu-* → CPU; any other name is shown as is. */
export function groupTag(resourceGroup: string | null | undefined): string | null {
  if (!(resourceGroup != null && resourceGroup !== "")) return null;
  if (/^cpu(-|$)/i.test(resourceGroup)) return "CPU";
  const gpu = /^gpu-(.+)$/i.exec(resourceGroup);
  return (gpu?.[1] != null && gpu[1] !== "") ? `GPU ${gpu[1].toUpperCase()}` : resourceGroup;
}

/** The component's device tag; CPU components are always CPU. */
export function deviceTag(device: Device | null | undefined): string | null {
  if (!device) return null;
  if (device.kind === "cpu") return "CPU";
  return groupTag(device.resource_group) ?? device.kind.toUpperCase();
}

/** Place text "[GPU 0] Node A（…）"; without a device only the Node label. */
export function placeLabel(device: Device | null | undefined, nodeLabel: string): string {
  const tag = deviceTag(device);
  return (tag != null && tag !== "") ? `[${tag}] ${nodeLabel}` : nodeLabel;
}
