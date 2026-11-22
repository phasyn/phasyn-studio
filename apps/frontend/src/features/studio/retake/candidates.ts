// What a range edit can drop in: the takes of the shot the range belongs to (「take 3 · seed 42」), the results of this
// shot's runs that are no take yet (a retake candidate comes back here), and — behind 「其他素材」 — the rest of the
// project (other shots' takes, library items). Labels never carry ids.
import type { FileRef, StudioProject, TimelineCommandRangeCandidate } from "@/api/generated/contracts";
import type { WireRun } from "@/api/types";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { publishedMedia } from "../model/runMedia";

export type CandidateMedia = "video" | "image" | "audio";
export type CandidateBinding = Pick<TimelineCommandRangeCandidate, "library_id" | "shot_id" | "take_id" | "run_id" | "output_key">;

export interface Candidate {
  key: string;
  title: string;
  /** Second line of the card (seed, when it was made); empty when there is nothing to add. */
  detail: string;
  media: CandidateMedia;
  file: FileRef;
  binding: CandidateBinding;
}

function make(title: string, detail: string, media: CandidateMedia, file: FileRef, binding: CandidateBinding): Candidate {
  return { key: JSON.stringify([binding, file.sha256]), title, detail, media, file, binding };
}

/** Finished takes of one shot, numbered as the take strip numbers them. */
export function shotTakes(project: StudioProject, shotId: string | null): Candidate[] {
  const shot = project.shots.find((item) => item.shot_id === shotId);
  if (!shot) return [];
  return shot.takes.flatMap((take, index) => take.state !== "succeeded" || take.asset?.complete !== true ? [] : [
    make(t("take {n}", { n: index + 1 }), take.seed !== null ? t("seed {seed}", { seed: take.seed }) : "", "video", take.asset.file,
      { shot_id: shot.shot_id, take_id: take.take_id }),
  ]);
}

function runTitle(run: WireRun): string {
  const kind = run.studio_work?.operation_kind;
  if (kind === "retake") return t("局部重製候選");
  if (kind === "render") return t("渲染結果");
  return t("生成結果");
}

/** Work whose output is no picture to cut in (a seam preview, a matte, an export). */
const SKIPPED = new Set(["seam", "mask", "export"]);

/** Timed results of this shot's runs that are not one of its takes yet (newest first, as the list comes). */
export function shotRuns(project: StudioProject, shotId: string | null, runs: readonly WireRun[]): Candidate[] {
  const takeRuns = new Set(project.shots.flatMap((shot) => shot.takes.map((take) => take.run_id)));
  return runs.flatMap((run) => {
    if (takeRuns.has(run.run_id) || (shotId !== null && run.studio_work?.shot_id !== shotId) || SKIPPED.has(run.studio_work?.operation_kind ?? "")) return [];
    const outputs = publishedMedia(run).filter((output) => output.timed);
    return outputs.map((output, index) => make(
      outputs.length > 1 ? `${runTitle(run)} ${String(index + 1)}` : runTitle(run), formatDateTime(run.created_at), output.kind, output.file,
      { run_id: run.run_id, output_key: output.port },
    ));
  });
}

/** Everything else in the project: other shots' takes, then the library. */
export function otherCandidates(project: StudioProject, shotId: string | null): Candidate[] {
  const takes = project.shots.filter((shot) => shot.shot_id !== shotId).flatMap((shot) =>
    shotTakes(project, shot.shot_id).map((item) => ({ ...item, title: `${shot.title || t("未命名鏡頭")} · ${item.title}` })));
  const library = (project.library ?? []).map((item) => make(item.name, "", item.kind, item.file, { library_id: item.item_id }));
  return [...takes, ...library];
}
