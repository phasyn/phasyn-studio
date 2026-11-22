// 首幀圖片 → 從影片取一格: the second way to give a shot its first frame, next to picking a library image (it replaces the
// old 製作配方「關鍵格確認後生成」). Choose a source video (a library video or a finished take of the project), type the
// frame number, take the native frame out with the frame extractor, look at it, and confirm: the PNG is collected into
// the project library and set as the shot's first frame in one step, so the next 渲染鏡頭 starts from it.
import { ArrowLeft } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { FileRef, StudioProject, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { fetchProject } from "@/api/studioProjects";
import { extractedFrame, natural, useMaskFramePreview } from "@/components/common/maskFramePreview";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { firstFrameImageProblem } from "../../model/continuity";
import { modeChange, routeFitsMode } from "../../model/generationMode";
import { useStudio } from "../../studioContext";

const MAX_FRAME = 100000;

function fileKey(file: FileRef): string {
  return `${file.node_id}/${file.file_id}`;
}

/** Library videos and the finished takes of the project, each file once. */
function sourceVideos(project: StudioProject): { label: string; file: FileRef }[] {
  const unique = new Map<string, { label: string; file: FileRef }>();
  for (const item of project.library ?? []) if (item.kind === "video") unique.set(fileKey(item.file), { label: item.name, file: item.file });
  for (const [index, shot] of project.shots.entries()) {
    for (const [at, take] of shot.takes.entries()) {
      if (take.state !== "succeeded" || take.asset?.complete !== true) continue;
      const title = shot.title || t("鏡頭 {index}", { index: index + 1 });
      unique.set(fileKey(take.asset.file), { label: t("{title} · 第 {take} 個 take", { title, take: at + 1 }), file: take.asset.file });
    }
  }
  return [...unique.values()];
}

export function FrameFromVideo({ shot, onBack, onDone }: { shot: StudioShot; onBack: () => void; onDone: (name: string) => void }) {
  const { project, engine, catalog, dispatch, runTimelineCommands } = useStudio();
  const id = useId();
  const choices = sourceVideos(project);
  const [sourceKey, setSourceKey] = useState("");
  const [frame, setFrame] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = (choices.find((item) => fileKey(item.file) === sourceKey) ?? choices[0])?.file;
  const index = frame.trim() === "" ? Number.NaN : Number(frame);
  const reader = useMaskFramePreview(false, "studio-approved-keyframe");
  const still = source ? extractedFrame(reader.run, "source", source, { frame_index: index }) : null;
  const compatible = engine.routes.some((route) => routeFitsMode(route, "image"));
  const problem = still && firstFrameImageProblem({ kind: "image", width: still.width, height: still.height }, project.format) !== null
    ? t("這一格的比例和專案畫面（{width}×{height}）不同，不能當首幀", { width: project.format.width, height: project.format.height })
    : null;
  const validFrame = natural(index) && index <= MAX_FRAME;

  const extract = () => {
    if (!source || !validFrame) return;
    setError(null);
    reader.inspect({ source }, { frame_index: index }, t("確認生成首幀"), { project_id: project.project_id, shot_id: shot.shot_id, operation_kind: "reference", source_digest: source.sha256 });
  };
  const confirm = async () => {
    const run = reader.run;
    if (!run || !still || problem !== null || !compatible) return;
    setBusy(true);
    setError(null);
    try {
      const name = t("關鍵格 {frame}", { frame: still.index });
      await runTimelineCommands([{ op: "collect_output", name, run_id: run.run_id, output_key: "source", expected_source_sha256: still.file.sha256 }]);
      const saved = await fetchProject(project.project_id);
      const item = (saved.library ?? []).find((entry) => entry.source?.kind === "run_output" && entry.source.run_id === run.run_id && entry.file.file_id === still.file.file_id);
      const target = saved.shots.find((row) => row.shot_id === shot.shot_id);
      if (!item || !target) throw new Error(t("找不到剛加入素材庫的影格或這個鏡頭，請再試一次"));
      const change = modeChange(saved, target, "image", { routes: engine.routes, catalog }, item.item_id);
      if (!change.ok) throw new Error(t("目前沒有能用首幀圖片的路線"));
      dispatch({ type: "updateShot", shotId: target.shot_id, patch: change.patch });
      onDone(item.name);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  const message = error ?? reader.error ?? problem ?? (!reader.available ? t("取影格元件沒有啟動：先在渲染引擎啟動它") : !compatible ? t("目前沒有能用首幀圖片的路線") : null);
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Esc from the fields steps back to the 方式 list. */ className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/8 px-1.5">
        <Button size="icon-sm" variant="quiet" icon={<ArrowLeft aria-hidden />} aria-label={t("回到首幀圖片")} title={t("回到首幀圖片")} onClick={onBack} />
        <p className="text-data font-semibold text-fg">{t("從影片取一格當首幀")}</p>
      </div>
      <fieldset disabled={busy} className="grid min-h-0 gap-2 overflow-y-auto p-3">
        <label htmlFor={`${id}-source`} className="text-caption text-fg-secondary">
          {t("來源影片")}
        </label>
        <Select id={`${id}-source`} compact data-autofocus="" value={source ? fileKey(source) : ""} onChange={(event) => { setSourceKey(event.target.value); setError(null); }}>
          {choices.length === 0 ? <option value="">{t("專案裡還沒有影片")}</option> : null}
          {choices.map((item) => (
            <option key={fileKey(item.file)} value={fileKey(item.file)}>
              {item.label}
            </option>
          ))}
        </Select>
        <label htmlFor={`${id}-frame`} className="text-caption text-fg-secondary">
          {t("第幾格（從 0 起算）")}
        </label>
        <div className="flex items-center gap-2">
          <Input id={`${id}-frame`} compact type="number" min={0} max={MAX_FRAME} step={1} value={frame} onChange={(event) => { setFrame(event.target.value); setError(null); }} className="w-28" />
          <Button size="sm" variant="secondary" pending={reader.busy} disabled={!reader.available || !source || !validFrame} onClick={extract}>
            {t("取出這一格")}
          </Button>
        </div>
        {still ? (
          <img
            key={still.file.file_id}
            src={mediaUrl(still.file.node_id, still.file.file_id)}
            alt={t("第 {index} 格", { index: still.index })}
            className="max-h-40 w-full rounded-md border border-line-subtle bg-stage object-contain animate-fade-in"
          />
        ) : null}
        {message !== null ? <p role="alert" className="text-caption text-warning [overflow-wrap:anywhere]">{message}</p> : null}
        <Button size="sm" pending={busy} disabled={!still || problem !== null || !compatible} onClick={() => void confirm()}>
          {t("設為這個鏡頭的首幀")}
        </Button>
      </fieldset>
    </div>
  );
}
