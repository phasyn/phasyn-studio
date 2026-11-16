// Typed builders for catalog wire objects (ComponentDescriptor, NodeSnapshot, DirectoryEntry, Catalog,
// CatalogLite). Every builder returns a complete contract object, so tests need no `as unknown as` casts.
import type {
  Catalog,
  CatalogLite,
  ComponentDescriptor,
  ComponentDescriptorLite,
  Device,
  DirectoryEntry,
  NodeSnapshot,
  RecorderConfig,
  SettingsView,
} from "@/api/generated/contracts";
import { FIXED_TIME, gpuUuid, NODE_A_ID, NODE_A_LABEL, NODE_B_ID, NODE_B_LABEL, nodeEndpoint, RESOURCE_GROUP } from "../ids";
import { providerPorts } from "./ports";

const GPU_IDS: Readonly<Record<string, string>> = { [RESOURCE_GROUP.gpu0]: gpuUuid(1), [RESOURCE_GROUP.gpu1]: gpuUuid(2), [RESOURCE_GROUP.uma]: gpuUuid(3) };

/** Device for a resource group: `gpu*` groups are CUDA devices (synthetic GPU UUIDs), anything else is the CPU. */
export function device(resource_group: string = RESOURCE_GROUP.gpu0): Device {
  if (!resource_group.startsWith("gpu")) return { kind: "cpu", id: "cpu", resource_group };
  return { kind: "cuda", id: GPU_IDS[resource_group] ?? gpuUuid(1), resource_group };
}

export interface DescriptorOptions extends Partial<Omit<ComponentDescriptor, "node_id" | "component_id" | "provider_id" | "settings" | "device">> {
  /** Resource group of the device (default `gpu-0`; a non-`gpu*` group means a CPU device). */
  resourceGroup?: string;
  /** settings.stored.invoke (saved invoke defaults). */
  invoke?: Record<string, unknown>;
  /** settings.stored.load.provider_options (variant, adapters…). */
  providerOptions?: Record<string, unknown>;
  /** settings.stored.load.offload. */
  offload?: Record<string, unknown>;
  /** settings.parameters_schema (default: an empty schema). */
  parametersSchema?: Record<string, unknown>;
  /** settings.stored.recording (default `{ mode: "summary" }`). */
  recording?: RecorderConfig;
  /** Merged over the built SettingsView (revisions, loaded, restart_required…). */
  settings?: Partial<SettingsView>;
}

/**
 * A complete ComponentDescriptor; ports default to the provider's real ports (see PROVIDER_PORTS).
 * Example: `descriptor(NODE_A_ID, "dit-gpu0", "h3.dit", { state: "stopped", providerOptions: { variant: "ref2va" } })`.
 */
export function descriptor(node_id: string, component_id: string, provider_id: string, options: DescriptorOptions = {}): ComponentDescriptor {
  const { resourceGroup, invoke, providerOptions, offload, parametersSchema, recording, settings, ...fields } = options;
  const dev = device(resourceGroup);
  const ports = providerPorts(provider_id);
  return {
    component_id,
    label: component_id,
    provider_id,
    runtime_id: "fixture-runtime",
    node_id,
    state: "ready",
    device: dev,
    api_path: `/api/nodes/${node_id}/components/${component_id}`,
    inputs: ports.inputs,
    outputs: ports.outputs,
    parts: [],
    active_call_id: null,
    last_error: null,
    recorder_state: "ok",
    folder: null,
    autostart: false,
    exclusive_group: null,
    limits: null,
    facts: null,
    ...fields,
    settings: {
      stored_revision: 1,
      loaded_revision: null,
      stored: {
        load: { device: dev, ...(providerOptions ? { provider_options: providerOptions } : {}), ...(offload ? { offload } : {}) },
        invoke: invoke ?? {},
        recording: recording ?? { mode: "summary" },
      },
      loaded: null,
      restart_required: false,
      settings_schema: {},
      parameters_schema: parametersSchema ?? {},
      ...settings,
    },
  };
}

/** The lite form GET /api/catalog?parts=false returns (no parts or facts; counts and digests instead). */
export function descriptorLite(full: ComponentDescriptor): ComponentDescriptorLite {
  const { parts, facts, ...rest } = full;
  return {
    ...rest,
    parts_count: parts.length,
    parts_digest: `digest:${parts.map((part) => part.path).join(",")}`,
    facts_digest: facts === null ? null : `digest:${JSON.stringify(facts)}`,
  };
}

export interface NodeSpec {
  node_id: string;
  label?: string;
  /** Directory liveness (default "online"). */
  state?: DirectoryEntry["state"];
  endpoint?: string;
}

/** Nodes A and B, the default node set of `catalog()`. */
export const DEFAULT_NODES: readonly NodeSpec[] = [
  { node_id: NODE_A_ID, label: NODE_A_LABEL, endpoint: nodeEndpoint(1) },
  { node_id: NODE_B_ID, label: NODE_B_LABEL, endpoint: nodeEndpoint(2) },
];

export function nodeSnapshot(spec: NodeSpec, components: ComponentDescriptor[] = []): NodeSnapshot {
  return {
    node_id: spec.node_id,
    process_instance_id: `process-${spec.node_id}`,
    label: spec.label ?? spec.node_id,
    endpoint: spec.endpoint ?? nodeEndpoint(1),
    protocol_version: "4.0",
    platform: "linux-x86_64",
    components,
    observed_at: FIXED_TIME,
  };
}

export function directoryEntry(spec: NodeSpec): DirectoryEntry {
  return { node_id: spec.node_id, label: spec.label ?? spec.node_id, endpoint: spec.endpoint ?? nodeEndpoint(1), state: spec.state ?? "online", last_seen_at: FIXED_TIME };
}

/**
 * A Catalog whose nodes hold the given components (grouped by `node_id`). Nodes default to A and B (both listed even
 * without components); pass `nodes` to set labels, liveness or a different set — a component on an unlisted node
 * adds that node.
 */
export function catalog(components: readonly ComponentDescriptor[] = [], nodes: readonly NodeSpec[] = DEFAULT_NODES): Catalog {
  const specs = [...nodes];
  for (const item of components) if (!specs.some((spec) => spec.node_id === item.node_id)) specs.push({ node_id: item.node_id });
  return {
    nodes: specs.map((spec) => nodeSnapshot(spec, components.filter((item) => item.node_id === spec.node_id))),
    directory: specs.map(directoryEntry),
    observed_at: FIXED_TIME,
  };
}

/** The lite catalog matching `full` (what the 3-second poll receives). */
export function catalogLite(full: Catalog): CatalogLite {
  return { ...full, nodes: full.nodes.map((node) => ({ ...node, components: node.components.map(descriptorLite) })) };
}

/** `(nodeId, componentId) → descriptor | null`, the lookup shape pipeline and graph models take. */
export function lookupFrom(descriptors: readonly ComponentDescriptor[]): (nodeId: string, componentId: string) => ComponentDescriptor | null {
  const map = new Map(descriptors.map((item) => [`${item.node_id}::${item.component_id}`, item]));
  return (nodeId, componentId) => map.get(`${nodeId}::${componentId}`) ?? null;
}
