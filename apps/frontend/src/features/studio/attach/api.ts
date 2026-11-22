import { studioWrite } from "@/api/studioWrite";
import { asAsset, type WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";

export function postRunTake(projectId: string, shotId: string, revision: number, runId: string, outputKey: string) {
  return studioWrite("StudioTakeAttachResult",
    projectId,
    `/api/studio/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/takes/from-run`,
    {
      method: "POST",
      json: { expected_revision: revision, run_id: runId, output_key: outputKey },
    },
  );
}

function publishesGenerationReceipt(run: WireRun, outputKey: string): boolean {
  const output = run.request.pipeline.outputs[outputKey];
  if (!output) return false;
  const step = run.steps[output.from_step];
  if (!isRecord(step) || !isRecord(step["outputs"])) return false;
  return Object.values(step["outputs"]).some((item) =>
    isRecord(item) && item["type_id"] === "studio.generation-receipt.v1" &&
    isRecord(item["value"]) && item["value"]["output_port"] === output.output,
  );
}

export function finishedGenerationOutputs(run: WireRun) {
  if (run.state !== "succeeded" || run.request.origin !== undefined) return [];
  return Object.entries(run.outputs).flatMap(([key, output]) => {
    const asset = isRecord(output) && output["type_id"] === "media.asset.v1" ? asAsset(output["value"]) : null;
    if (
      !(asset?.complete === true) ||
      (asset.kind !== "final" && asset.kind !== "video") ||
      !asset.file.media_type.startsWith("video/") ||
      (asset.source_latent === null && !publishesGenerationReceipt(run, key))
    )
      return [];
    return [{ key, asset, run }];
  });
}

export function postAdoptedMedia(project: string, shot: string, revision: number, run: string, output: string, parent: string | null) {
  return studioWrite("StudioTakeAttachResult", project,
    `/api/studio/projects/${encodeURIComponent(project)}/shots/${encodeURIComponent(shot)}/takes/adopt-media`,
    { method: "POST", json: { expected_revision: revision, run_id: run, output_key: output, parent_take_id: parent } });
}
