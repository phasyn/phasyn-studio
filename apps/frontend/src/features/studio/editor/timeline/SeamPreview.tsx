import { useRef, useState } from "react";
import type { TimelineCommandRangeCandidate } from "@/api/generated/contracts";
import { contractJson, mediaUrl } from "@/api/http";
import { useCreateRun, useRun, useRunList } from "@/api/runs";
import { fetchProject } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { isRecord, valuesEqual } from "@/lib/json";
import { pathSegment } from "@/lib/url";
import { useStudio } from "../../studioContext";
import { publishedMedia } from "../../model/runMedia";
import { RetakeMonitor } from "../../retake/RetakeMonitor";

export function SeamPreview({ command }: { command: TimelineCommandRangeCandidate }) {
  const { project, flush, runBlockedReason } = useStudio();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fps = project.timeline ? project.timeline.fps.num / project.timeline.fps.den : project.format.fps.num / project.format.fps.den;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const create = useCreateRun();
  const history = useRunList(25, "include", { project_id: project.project_id, operation_kind: "seam" }, "summary");
  const matches = (note?: string) => {
    try {
      const data: unknown = JSON.parse(note ?? "null");
      return isRecord(data) && data["revision"] === project.revision && valuesEqual(data["command"], command);
    } catch { return false; }
  };
  const latest = [create.data, ...(history.data?.pages.flatMap(page => page.items) ?? [])]
    .find(item => item != null && matches(item.request.origin?.note));
  const run = useRun(latest?.run_id ?? null);
  const output = run.data && publishedMedia(run.data).find(item => item.kind === "video");
  async function preview() {
    setPending(true);
    setError("");
    try {
      await flush();
      const current = await fetchProject(project.project_id);
      if (!valuesEqual(current.timeline, project.timeline)) throw new Error(t("剪輯版本已變更，請重新檢視重製範圍。"));
      const plan = await contractJson("WireRunRequest", `/api/studio/projects/${pathSegment(project.project_id)}/timeline/seam-plan`, {
        method: "POST", json: { revision: current.revision, command },
      });
      await create.mutateAsync(plan);
    } catch (cause) {
      setError(errorText(cause));
    } finally { setPending(false); }
  }
  const failed = run.data?.error ?? run.error;
  return <div className="grid gap-2">
    <Button size="sm" variant="secondary" disabled={pending || (runBlockedReason != null && runBlockedReason.length > 0)} title={runBlockedReason ?? undefined} onClick={() => void preview()}>{t("試看候選與原片接縫")}</Button>
    {history.hasNextPage && <Button size="sm" variant="quiet" onClick={() => void history.fetchNextPage()}>{t("讀取較早的執行紀錄")}</Button>}
    {latest && !output && !failed && <span role="status" className="text-caption text-fg-secondary">{t("正在產生接縫預覽…")}</span>}
    {output && <RetakeMonitor src={mediaUrl(output.file.node_id, output.file.file_id)} fps={fps} label={t("接縫預覽")} videoRef={videoRef} height="min(30vh, 14rem)" />}
    {(error || failed) && <p role="alert" className="text-caption text-warning">{error || errorText(failed)}</p>}
  </div>;
}
