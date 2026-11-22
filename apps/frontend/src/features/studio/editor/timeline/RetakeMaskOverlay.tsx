import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { extractedFrame, natural, useMaskFramePreview } from "@/components/common/maskFramePreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";

/**
 * Checks a mask version on one native frame: the source frame and the same frame of the matte, laid over each other
 * with an adjustable opacity. `revision` keys the version (never shown); `frameIndex` starts on the frame being marked.
 */
export function RetakeMaskOverlay({ source, mask, revision, frameIndex = 0 }: { source: FileRef; mask: FileRef; revision: string; frameIndex?: number }) {
  const [index, setIndex] = useState(frameIndex);
  const [opacity, setOpacity] = useState(0.5);
  const preview = useMaskFramePreview(false);
  const address = { frame_index: index };
  const picture = extractedFrame(preview.run, "source", source, address);
  const matte = extractedFrame(preview.run, "mask", mask, address);
  const ready = picture !== null && matte !== null && picture.count === matte.count && picture.width === matte.width && picture.height === matte.height;
  const limit = mask.metadata["frame_count"];
  const valid = natural(index) && index <= 100000 && (!natural(limit) || index < limit);
  return <div className="grid gap-2" data-revision={revision}>
    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
      <label className="grid gap-1 text-caption text-fg-tertiary">{t("檢查影格")}
        <Input compact type="number" min="0" step="1" value={Number.isNaN(index) ? "" : index} onChange={e => { setIndex(e.target.valueAsNumber); }} /></label>
      <Button size="sm" disabled={!preview.available || !valid || preview.busy} title={!preview.available ? t("請先啟動取影格元件") : undefined}
        onClick={() => { preview.inspect({ source, mask }, address, t("逐幀遮罩疊圖")); }}>{t("顯示原片與遮罩疊圖")}</Button>
    </div>
    {ready && <figure key={picture.file.sha256 + matte.file.sha256} className="grid gap-1.5 animate-fade-in">
      <div className="relative overflow-hidden rounded-md bg-stage"><img className="block w-full" src={mediaUrl(picture.file.node_id, picture.file.file_id)} alt={t("原片影格")} />
        <img className="absolute inset-0 size-full mix-blend-screen" style={{ opacity }} src={mediaUrl(matte.file.node_id, matte.file.file_id)} alt={t("同影格的遮罩")} /></div>
      <figcaption className="flex items-center gap-2 text-caption text-fg-secondary">
        <span className="machine shrink-0">{t("影格")} {picture.index}</span>
        <label className="flex min-w-0 flex-1 items-center gap-2">{t("遮罩不透明度")}
          <input className="min-w-0 flex-1 accent-(--color-action)" type="range" min="0" max="1" step="0.05" value={opacity} onChange={e => { setOpacity(e.target.valueAsNumber); }} /></label>
      </figcaption>
    </figure>}
    {preview.busy && <span role="status" className="text-caption text-fg-secondary">{t("載入預覽…")}</span>}
    {preview.error !== null && <p role="alert" className="text-caption text-warning">{preview.error}</p>}
    {preview.run?.state === "succeeded" && !ready && preview.run.request.pipeline.steps[0]?.parameters["frame_index"] === index &&
      <p role="alert" className="text-caption text-warning">{t("預覽影格與目前的來源或版本不符。")}</p>}
  </div>;
}
