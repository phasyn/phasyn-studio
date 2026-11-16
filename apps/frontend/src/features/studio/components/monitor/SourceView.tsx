// Take view of the Shots monitor: the take shown in A (alone, or with the pinned B by a split line or side by side), a
// slate in place of a take without video, and the transport as its own row under the picture. While a take of the
// shot renders, the picture's frame glows and carries the measured DiT share. Trimming lives in the Edit workspace
// (the timeline is the one edit state), so there are no In/Out points here.
import { Repeat, Volume2, VolumeX } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { GeneratingFrame } from "@/components/common/GeneratingFrame";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import { useVideoClock } from "../../hooks/useVideoClock";
import { useEditor, type SourceMonitorHandle } from "../../editor/editorContext";
import { MonitorButton } from "../../editor/monitors/MonitorChrome";
import { useRenderActivity } from "../../renderActivityContext";
import { CompareLayer, type CompareChips } from "./CompareLayer";
import { takeUrl } from "./media";
import type { CompareMode } from "./monitorTakes";
import { ditFraction } from "./renderStage";
import { Slate } from "./Slate";
import { TransportBar } from "./TransportBar";
import { useTakeRender } from "./useTakeRender";

export function SourceView({
  shot,
  take,
  compare,
  compareMode,
  chips,
}: {
  shot: StudioShot;
  take: StudioTake | null;
  compare: StudioTake | null;
  compareMode: CompareMode;
  /** What the A and B chips add for a variant take (its number and badge); null for another take. */
  chips: CompareChips;
}) {
  const { project, sourceMonitor } = useEditor();
  const activity = useRenderActivity();
  const fps = project.format.fps.num / project.format.fps.den;
  const ref = useRef<HTMLVideoElement>(null);
  const src = takeUrl(take);
  const srcB = src ? takeUrl(compare) : null;
  const clock = useVideoClock(ref, src, fps);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const total = Math.round(clock.duration * fps) || take?.asset?.frame_count || 0;
  const frame = Math.min(clock.frame, Math.max(0, total - 1));

  const seek = (next: number) => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(total - 1, next)) / fps;
  };
  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  // The take preview answers the key map's transport keys while the monitor shows it (editor/useEditorKeys)
  const keys = useEffectEvent((): SourceMonitorHandle => ({
    toggle,
    step: (frames) => seek(Math.round((ref.current?.currentTime ?? 0) * fps) + frames),
    seekEdge: (edge) => seek(edge === "start" || edge === "in" ? 0 : total - 1),
  }));
  useEffect(
    () => sourceMonitor.register({ toggle: () => keys().toggle(), step: (frames) => keys().step(frames), seekEdge: (edge) => keys().seekEdge(edge) }),
    [sourceMonitor],
  );

  // A take of this shot renders: the picture's frame glows (it still shows the take in A, or the slate)
  const renderingTake = shot.takes.find((item) => item.state === "rendering") ?? null;
  const live = useTakeRender(renderingTake);
  const side = srcB !== null && compareMode === "side";
  const noVideo = src ? null : t("這個 take 還沒有影片");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-1.5">
      <GeneratingFrame active={renderingTake !== null} progress={renderingTake ? ditFraction(renderingTake, activity, live) : null} className="flex min-h-0 flex-1 flex-col">
        <div data-monitor-stage="" className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-stage">
          {src ? (
            <>
              {/* 換鏡頭／take 時（SourceView 重新掛載）影像在黑場上淡入，不硬切；換 B 或比較方式時 A 不重新載入 */}
              <video
                ref={ref}
                src={src}
                loop={loop}
                muted={muted}
                playsInline
                preload="auto"
                className={cn("absolute object-contain animate-fade-in", side ? "inset-y-0 left-0 h-full w-1/2" : "inset-0 size-full")}
                aria-label={t("{title} 的 take", { title: shot.title })}
              />
              {srcB ? <CompareLayer primary={ref} src={srcB} mode={compareMode} fps={fps} chips={chips} /> : null}
            </>
          ) : (
            <Slate shot={shot} take={take} />
          )}
        </div>
      </GeneratingFrame>
      {shot.takes.length > 0 ? (
        <TransportBar
          frame={frame}
          total={src ? total : 0}
          fps={fps}
          playing={clock.playing}
          disabledReason={noVideo}
          labels={{ group: t("來源播放控制"), scrub: t("來源播放位置"), play: t("播放") }}
          onSeek={seek}
          onToggle={toggle}
          onStep={(frames) => seek(frame + frames)}
        >
          <MonitorButton label={t("循環播放")} disabledReason={noVideo} onClick={() => setLoop((value) => !value)} pressed={loop}>
            <Repeat aria-hidden />
          </MonitorButton>
          <MonitorButton label={muted ? t("取消靜音") : t("靜音")} disabledReason={noVideo} onClick={() => setMuted((value) => !value)} pressed={muted}>
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
          </MonitorButton>
        </TransportBar>
      ) : null}
    </div>
  );
}
