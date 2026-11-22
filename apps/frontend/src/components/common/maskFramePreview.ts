import { indexCatalog, useStableCatalog } from "@/api/catalog";
import type { FileRef, StudioWorkOrigin } from "@/api/generated/contracts";
import { useCreateRun, useRun } from "@/api/runs";
import { asTypedValue, type WireRun } from "@/api/types";
import { errorText } from "@/lib/errors";
import { isRecord } from "@/lib/json";

export type FrameAddress = { frame_index: number; time_us?: never } | { time_us: number; frame_index?: never };

export function natural(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function matches(run: WireRun, name: string, source: FileRef, address: FrameAddress) {
  const input = run.request.inputs[name];
  const params = run.request.pipeline.steps.find(step => step.step_id === name)?.parameters;
  return input !== undefined && "file" in input && input.file.sha256 === source.sha256 &&
    (address.frame_index !== undefined
      ? params?.["position"] === "index" && params["frame_index"] === address.frame_index
      : params?.["position"] === "time_us" && params["time_us"] === address.time_us);
}

export function extractedFrame(run: WireRun | undefined, name: string, source: FileRef, address: FrameAddress) {
  if (run?.state !== "succeeded" || !matches(run, name, source, address)) return null;
  const output = asTypedValue(run.outputs[name]);
  if (output?.type_id !== "media.image.v1" || !("file" in output) || output.file.media_type !== "image/png") return null;
  const meta = output.file.metadata;
  const index = meta["frame_index"], count = meta["source_frame_count"];
  const width = meta["width"], height = meta["height"];
  if (meta["source_sha256"] !== source.sha256 || !natural(index) || !natural(count, index + 1)
    || !natural(width, 1) || !natural(height, 1)) return null;
  if (address.frame_index !== undefined ? index !== address.frame_index : meta["requested_time_us"] !== address.time_us) return null;
  return { file: output.file, index, count, width, height };
}

export function useMaskFramePreview(measureClock: boolean, pipelineId?: string) {
  const catalog = useStableCatalog();
  const target = indexCatalog(catalog.data).entries.find(({ node, descriptor }) => {
    const schema = descriptor.settings.parameters_schema["properties"];
    return !node.stale && descriptor.provider_id === "media.frame" && ["ready", "busy"].includes(descriptor.state)
      && (!measureClock || (isRecord(schema) && "frame_clock" in schema && "time_us" in schema));
  });
  const create = useCreateRun();
  const run = useRun(create.data?.run_id ?? null);
  function inspect(files: Record<string, FileRef>, address: FrameAddress, label: string, work?: StudioWorkOrigin) {
    if (!target || !natural(address.frame_index ?? address.time_us)) return;
    const parameters = {
      ...address, position: address.frame_index === undefined ? "time_us" : "index", ...(measureClock ? { frame_clock: true } : {}),
    };
    const names = Object.keys(files);
    create.mutate({
      pipeline: {
        pipeline_id: pipelineId ?? (measureClock ? "studio-mask-annotation-frame" : "studio-mask-preview"), label,
        inputs: names.map(name => ({ name, type_id: "media.video.v1", transport: "file", required: true, description: name })),
        steps: names.map(name => ({ step_id: name, node_id: target.node.node_id, component_id: target.descriptor.component_id,
          inputs: { video_file: { from_input: name } }, parameters })),
        outputs: Object.fromEntries(names.map(name => [name, { from_step: name, output: "image" }])),
      },
      ...(work ? { origin: { studio_work: work } } : {}),
      inputs: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { type_id: "media.video.v1", file }])), label,
    });
  }
  const error = create.error ?? run.error ?? run.data?.error;
  return { available: Boolean(target), inspect, run: run.data, busy: create.isPending || run.data?.state === "running",
    error: error ? errorText(error) : null };
}
