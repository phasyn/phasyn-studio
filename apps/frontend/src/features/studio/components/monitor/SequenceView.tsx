// Program view of the Shots monitor: the sequence at the playhead, drawn by the same compositor as the Edit workspace's
// Program monitor (editor/monitors/ProgramViewer), with the transport as its own row under the picture.
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { useEditor } from "../../editor/editorContext";
import { ProgramViewer } from "../../editor/monitors/ProgramViewer";
import { usePlayheadFrame, usePlaying } from "../../hooks/playhead";
import { TransportBar } from "./TransportBar";

export function SequenceView() {
  const { playhead, transport, totalFrames, fps, problem } = useEditor();
  const frame = usePlayheadFrame(playhead);
  const playing = usePlaying(playhead);
  if (totalFrames === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-1.5">
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto rounded-lg bg-stage">
          <EmptyState illustration="timeline" size="compact" title={problem ? t("序列無法建立") : t("時間軸是空的")} description={problem ?? t("新增鏡頭後，這裡會播放時間軸上的成片。")} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-1.5">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-stage">
        <ProgramViewer />
      </div>
      <TransportBar
        frame={frame}
        total={totalFrames}
        fps={fps}
        playing={playing}
        labels={{ group: t("序列播放控制"), scrub: t("序列播放位置"), play: t("播放序列") }}
        onSeek={transport.seek}
        onToggle={transport.toggle}
        onStep={transport.step}
      />
    </div>
  );
}
