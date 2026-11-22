import { downstreamOf } from "@/api/pipelineGraph";
import { findComponent } from "@/api/catalog";
import type { Catalog, Port } from "@/api/generated/contracts";
import type { WirePipeline, WireStep } from "@/api/types";
import { isRecord } from "@/lib/json";

function publicInput(pipe: WirePipeline, step: WireStep, name: unknown, type: string): Port | undefined {
  if (typeof name !== "string") return undefined;
  const binding = step.inputs[name];
  if (!binding || !("from_input" in binding)) return undefined;
  return pipe.inputs.find(port => port.name === binding.from_input && port.type_id === type && port.transport !== "inline");
}

/** Follow declared media connections so a composed graph can publish a processed animatic. */
function mediaResults(pipe: WirePipeline, catalog: Catalog, step: WireStep, asset: string) {
  const resultPorts = (id: string) => {
    const source = pipe.steps.find(item => item.step_id === id);
    return source && findComponent(catalog, source.node_id, source.component_id)?.descriptor.outputs;
  };
  const mediaType = (id: string, output: string) =>
    resultPorts(id)?.find(port => port.name === output)?.type_id;
  const videoPort = (stepId: string, output: string) =>
    ["media.asset.v1", "media.video.v1"].includes(mediaType(stepId, output) ?? "");
  const reachable = downstreamOf(pipe, step.step_id, videoPort);
  const outputs = Object.entries(pipe.outputs).filter(([, edge]) => reachable.has(edge.from_step) && videoPort(edge.from_step, edge.output));
  const primary = outputs.find(([name]) => name === "final");
  const original = outputs.find(([, edge]) => edge.from_step === step.step_id && edge.output === asset);
  return (primary ?? original ?? (outputs.length === 1 ? outputs[0] : undefined))?.[0];
}

export function animaticRoutes(graphs: WirePipeline[], catalog: Catalog | undefined) {
  if (!catalog) return [];
  return graphs.flatMap(pipe => {
    const steps = pipe.steps.map(step => ({ step, entry: findComponent(catalog, step.node_id, step.component_id) }));
    if (steps.some(({ entry }) => !entry || entry.node.stale || entry.descriptor.state !== "ready")) return [];
    const encoders = steps.flatMap(({ step, entry }) => {
      const facts = entry?.descriptor.facts?.["studio_animatic"];
      return isRecord(facts) && facts["version"] === 1 ? [{ step, facts }] : [];
    });
    if (encoders.length !== 1 || !encoders[0]) return [];
    const { step, facts } = encoders[0];
    const frames = publicInput(pipe, step, facts["frames"], "media.previs-frames.v1");
    const audio = publicInput(pipe, step, facts["audio"], "media.audio.v1");
    if (!frames || typeof facts["asset"] !== "string" || pipe.inputs.some(p => p.required && p.name !== frames.name && p.name !== audio?.name)) return [];
    const port = mediaResults(pipe, catalog, step, facts["asset"]);
    return port === undefined ? [] : [{ pipe, frames: frames.name, audio, port }];
  });
}
