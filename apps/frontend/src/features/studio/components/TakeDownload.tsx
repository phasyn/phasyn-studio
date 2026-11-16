// Download one take's video: a plain link to the file the take already has (the same media URL its players use), so it
// needs no new request or backend support. On the take tiles of the project panel and the render outputs, and in the
// monitor next to the take being watched. Only a succeeded take with a file has one.
import { Download } from "lucide-react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { takeFileName, takeNumber } from "../model/takeDownload";
import { t } from "@/i18n";

/**
 * The link, or nothing when the take has no file yet. iconOnly: just the icon (tiles, the monitor's toolbar). The
 * accessible name says which take; with the text shown it starts with that text, so speech input finds it.
 */
export function TakeDownloadLink({ shot, take, iconOnly = false, className }: { shot: StudioShot; take: StudioTake; iconOnly?: boolean; className?: string }) {
  const file = take.state === "succeeded" ? take.asset?.file : undefined;
  if (!file) return null;
  const label = t("下載 MP4：「{title}」take {take}", { title: shot.title, take: takeNumber(shot, take) });
  return (
    <a href={mediaUrl(file.node_id, file.file_id)} download={takeFileName(shot, take, file.media_type)} aria-label={label} title={label} className={className}>
      <Download aria-hidden />
      {iconOnly ? null : t("下載 MP4")}
    </a>
  );
}
