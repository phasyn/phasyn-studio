// The audio mixer (the 音訊 tab beside Source, and the right dock of the Audio layout): one channel strip per audio
// track, left to right in track order, then the master. The strips share the panel's height and narrow to their minimum
// width before they scroll; with many tracks only the track strips scroll sideways (their own scroll bar), the master
// keeps its own column at the right edge so it never covers a track. The bar above the strips opens the final mix
// audition (the whole sequence's audio mixed as the export mixes it), so the mix is checked where it is made.
import { AudioLines, Plus } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { MixAuditionDialog } from "../../dialogue/MixAuditionDialog";
import { useEditor } from "../editorContext";
import { trackLabel } from "../timelineGeometry";
import { MasterStrip, TrackStrip } from "./mixer/ChannelStrip";

export function AudioMixer() {
  const editor = useEditor();
  const { timeline } = editor;
  const tracks = timeline.tracks.filter((track) => track.kind === "audio");
  const soloed = tracks.some((track) => track.solo);
  const full = editor.canAddTrack ? null : t("軌道數已達上限");
  return (
    <div data-keep-focus="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-b border-line-subtle px-2">
        <MixAuditionDialog />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div role="group" aria-label={t("混音器")} className="flex h-full min-h-72 items-stretch">
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden">
            {tracks.map((track) => (
              <TrackStrip key={track.track_id} track={track} label={trackLabel(track, timeline.tracks)} silent={track.muted || (soloed && !track.solo)} />
            ))}
            {tracks.length === 0 ? (
              <div className="grid min-w-0 flex-1 place-items-center">
                <EmptyState
                  size="compact"
                  icon={<AudioLines />}
                  title={t("沒有音訊軌")}
                  action={
                    <Button size="sm" icon={<Plus aria-hidden />} aria-disabled={(full != null && full !== "") ? true : undefined} title={full ?? undefined} onClick={() => ((full != null && full !== "") ? undefined : void editor.addTrack("audio"))}>
                      {t("新增音訊軌")}
                    </Button>
                  }
                />
              </div>
            ) : null}
          </div>
          <MasterStrip />
        </div>
      </div>
    </div>
  );
}
