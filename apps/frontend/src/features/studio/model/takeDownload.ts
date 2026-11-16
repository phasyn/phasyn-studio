// The file name offered when a take's video is downloaded (components/TakeDownload.tsx). Pure.
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { extensionFor } from "@/lib/download";

/** Characters file systems reject (and control characters) in a suggested file name. */
const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}]+/gu;

/** 1-based number of the take within its shot (as 「take 2」 reads everywhere). */
export function takeNumber(shot: StudioShot, take: StudioTake): number {
  return shot.takes.findIndex((item) => item.take_id === take.take_id) + 1;
}

/** 「<shot title> take 2.mp4」; characters a file system rejects become 「-」, an empty title 「shot」. */
export function takeFileName(shot: StudioShot, take: StudioTake, mediaType: string): string {
  const title = shot.title.replace(UNSAFE_NAME, "-").trim() || "shot";
  return `${title} take ${takeNumber(shot, take)}.${extensionFor(mediaType)}`;
}
