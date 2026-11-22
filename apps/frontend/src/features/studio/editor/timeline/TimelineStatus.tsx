// The status line under the tracks: while a gesture or a drop is under way, what the release does or why it is
// refused there; otherwise the sequence's length. It is not a live region: what an edit did is said once by the
// editor's announcer (EditAnnouncer), not at every frame a drag passes.
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { formatTimecode } from "../../model/frames";
import type { EffectDropPreview } from "./useEffectDrop";
import type { SourceDropPreview } from "./useSourceDrop";

/** What a source drop would do: the edit, where it lands and the key that switches to an insert. */
function dropHint(drop: SourceDropPreview, fps: number): string {
  const time = formatTimecode(drop.start, fps);
  if (drop.mode === "insert") return t("插入到 {time}，後面的片段往右移", { time });
  return t("覆寫到 {time}；按住 {key} 改為插入", { time, key: modifierLabel("Mod", detectApplePlatform()) });
}

export interface TimelineStatusProps {
  /** Why the pointer gesture under way would be refused. */
  gestureError: string | null;
  drop: SourceDropPreview | null;
  effect: EffectDropPreview | null;
  totalFrames: number;
  fps: number;
}

export function TimelineStatus({ gestureError, drop, effect, totalFrames, fps }: TimelineStatusProps) {
  const error = gestureError ?? drop?.error ?? effect?.error ?? null;
  const text = error ?? (drop ? dropHint(drop, fps) : (effect?.hint ?? formatTimecode(totalFrames, fps)));
  return (
    <span title={text} className={cn("machine min-w-0 max-w-[60%] shrink-0 truncate px-2 text-caption", (error != null && error !== "") ? "text-danger" : drop || effect ? "text-fg-secondary" : "text-fg-tertiary")}>
      {text}
    </span>
  );
}
