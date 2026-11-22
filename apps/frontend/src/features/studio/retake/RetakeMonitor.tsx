// A small Studio monitor for the range dialog: the picture letterboxed on the stage at its own aspect ratio (so an
// overlay laid over it maps 1:1 to the picture), and the Studio transport (scrub bar, timecode, step, play) under it —
// never the browser's own <video controls>. Used to mark a mask on the picture, preview a candidate and play a seam.
import { useState, type ReactNode, type RefObject } from "react";
import { AssetVideo } from "@/components/common/AssetMedia";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { firstFrameCount } from "@/lib/json";
import { TransportBar } from "../components/monitor/TransportBar";
import { useVideoClock } from "../hooks/useVideoClock";

export interface RetakeMonitorProps {
  src: string;
  /** Sequence frames per second (the transport counts in these). */
  fps: number;
  /** Known length in frames, when the media says so. */
  frames?: number | null;
  /** Known picture aspect (width / height) before the metadata loads. */
  aspect?: number | null;
  label: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Laid over the picture (exactly its box). */
  overlay?: ReactNode;
  /** Height of the stage (CSS length). */
  height?: string;
  /** Called after any transport action (the overlay may drop what it showed for an older frame). */
  onTransport?: () => void;
  className?: string;
}

export function RetakeMonitor({ src, fps, frames, aspect, label, videoRef, overlay, height = "min(42vh, 22rem)", onTransport, className }: RetakeMonitorProps) {
  const clock = useVideoClock(videoRef, src, fps);
  const [measured, setMeasured] = useState<number | null>(null);
  const ratio = measured ?? (aspect != null && aspect > 0 ? aspect : 16 / 9);
  const total = firstFrameCount([Math.round(clock.duration * fps), frames], 0);
  const frame = Math.min(clock.frame, Math.max(0, total - 1));
  const seek = (next: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(total - 1, next)) / fps;
    onTransport?.();
  };
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
    onTransport?.();
  };
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <div className="grid place-items-center overflow-hidden rounded-lg bg-stage" style={{ height }}>
        <div className="relative max-h-full max-w-full" style={{ aspectRatio: String(ratio), width: `min(100%, calc(${height} * ${String(ratio)}))` }}>
          <AssetVideo
            ref={videoRef}
            src={src}
            playsInline
            preload="auto"
            aria-label={label}
            className="absolute inset-0 size-full object-contain animate-fade-in"
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) setMeasured(videoWidth / videoHeight);
            }}
          />
          {overlay}
        </div>
      </div>
      <TransportBar
        frame={frame}
        total={total}
        fps={fps}
        playing={clock.playing}
        labels={{ group: t("預覽播放控制"), scrub: t("預覽播放位置"), play: t("播放") }}
        onSeek={seek}
        onToggle={toggle}
        onStep={(step) => { seek(frame + step); }}
      />
    </div>
  );
}
