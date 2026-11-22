import type { WireRun } from "@/api/types";
import { isRecord } from "@/lib/json";
import { publishedMedia } from "../model/runMedia";

export interface AnimaticJob {
  id: string;
  label: string;
  port: string | null;
}

export function animaticJob(run: WireRun, projectId: string, shotId: string): AnimaticJob | undefined {
  if (!Object.values(run.request.inputs).some(input => input.type_id === "media.previs-frames.v1")) return;
  try {
    const note: unknown = JSON.parse(run.request.origin?.note ?? "");
    if (!isRecord(note) || note["project_id"] !== projectId || note["shot_id"] !== shotId ||
      !Number.isInteger(note["start"]) || !Number.isInteger(note["end"])) return;
    const media = publishedMedia(run).filter(output => output.kind === "video");
    const primary = media.find(output => output.port === "final") ?? (media.length === 1 ? media[0] : undefined);
    return { id: run.run_id, label: run.request.label ?? run.request.pipeline.label,
      port: typeof note["output"] === "string" ? note["output"] : primary?.port ?? null };
  } catch {
    return;
  }
}
