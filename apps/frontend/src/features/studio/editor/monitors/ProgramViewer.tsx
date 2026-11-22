// The Program picture: every clip under the playhead as one layer (three.js effect pipeline per video layer, audio
// through the transport's audio graph), captions on top. Both workspaces mount this same component, so the Shots
// monitor and the Edit workspace's Program monitor always show the same frame. An adjustment layer's picture is the
// composite of the tracks under it (layerStack): its own pipeline runs its effects on that, and it is blended back over
// them like any layer, with its opacity, mask, fades and blend mode.
import { AssetVideo } from "@/components/common/AssetMedia";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { StudioTimeline, TimelineCaption, TimelineClip, TimelineSource, TimelineTrack } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { usePlayheadFrame, usePlaying } from "../../hooks/playhead";
import { clipSourceFrame, dbToGain } from "../../model/clipEffects";
import { exportGeometry } from "../../model/project";
import { canvasMeasure, drawTitle, layoutTitle } from "../../model/titleLayout";
import { isAdjustment } from "../adjustment";
import { useEditor } from "../editorContext";
import { clipDuration, clipEnabled, clipEnd, motionAt, processedDuration, toProcessingFrame, trackClips } from "../model";
import { audioFadeFactor, PREVIEW_DISCLAIMER } from "../previewMath";
import type { LookMask, MovingLook } from "../transitionLook";
import { useClipRenderer } from "../useClipRenderer";
import { transitionAt, washFilter } from "./layerMix";
import { composeBelow, createLayerStack, type LayerStack } from "./layerStack";
import { TransformOverlay } from "./TransformOverlay";
import { ViewerFrame, type ViewerZoom } from "./ViewerFrame";

function CaptionImage({ caption, width, height }: { caption: TimelineCaption; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const paint = () => {
      context.clearRect(0, 0, width, height);
      drawTitle(context, layoutTitle(caption, width, height, canvasMeasure(context)));
    };
    paint();
    let live = true;
    // The fonts of the document the canvas is in (the Program window has its own)
    void canvas.ownerDocument.fonts.ready.then(() => {
      if (live) paint();
    });
    return () => {
      live = false;
    };
  }, [caption, width, height]);
  return <canvas ref={ref} width={width} height={height} className="pointer-events-none absolute inset-0 size-full" aria-label={caption.text} />;
}

const percent = (value: number) => `${(value * 100).toFixed(4)}%`;

/** A mask of a moving transition as CSS masking of the layer (in the layer's own box, before its transform). */
function maskStyle(mask: LookMask): CSSProperties {
  if (mask.kind === "edge") {
    const stops = mask.stops.map(([position, alpha]) => `rgb(0 0 0 / ${alpha.toFixed(4)}) ${percent(position)}`).join(", ");
    return { maskImage: `linear-gradient(to ${mask.to}, ${stops})` };
  }
  // The solid layer minus the rectangle's: 1 − gain inside the centred rectangle, 1 around it
  const rectangle = `rgb(0 0 0 / ${mask.gain.toFixed(4)})`;
  return {
    maskImage: `linear-gradient(#000, #000), linear-gradient(${rectangle}, ${rectangle})`,
    maskSize: `100% 100%, ${percent(mask.size)} ${percent(mask.size)}`,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskComposite: "subtract",
  };
}

/** Where a moving transition draws a layer: moved and scaled about the canvas centre, masked, its opacity. */
function lookStyle(look: MovingLook): CSSProperties {
  const moved = look.x !== 0 || look.y !== 0 || look.scale !== 1;
  return {
    ...(moved ? { transform: `translate(${percent(look.x)}, ${percent(look.y)}) scale(${String(look.scale)})` } : {}),
    ...(look.mask ? maskStyle(look.mask) : {}),
  };
}

interface LayerProps {
  clip: TimelineClip;
  source: TimelineSource;
  track: TimelineTrack;
  frame: number;
  playing: boolean;
  /** The monitor's video layers, for the adjustment layers above this one. */
  stack: LayerStack;
  /** The place of the layer's track among the monitor's tracks, bottom first. */
  order: number;
  /** An adjustment layer reads the layers' pictures: they are kept in their canvases after they are shown. */
  readable: boolean;
  /** For an adjustment layer: the visible video tracks under it, bottom to top. */
  below: readonly TimelineTrack[];
  /** The timeline as the monitor shows it (a clip whose transform is being dragged where the drag has it). */
  shown: StudioTimeline;
  /** A video layer already says why this source has no picture: an audio layer of it does not say it again. */
  quiet: boolean;
}

function Layer({ clip, source, track, frame, playing, stack, order, readable, below, shown, quiet }: LayerProps) {
  const editor = useEditor();
  const { timeline, proxy, project, playhead, warn } = editor;
  const { audio, rate } = editor.transport;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const adjustment = source.kind === "adjustment";
  // An adjustment layer's picture: the composite of the tracks under it, drawn here before each of its draws
  const [composite] = useState(() => (adjustment ? document.createElement("canvas") : null));
  const geometry = exportGeometry(project);
  const fps = timeline.fps.num / timeline.fps.den;
  const local = frame - clip.start_frame;
  const active = local >= 0 && local < clipDuration(clip);
  const processing = toProcessingFrame(clip, local);
  const complete = processedDuration(clip);
  const motion = motionAt(clip, frame);
  const transition = transitionAt(clip, timeline.clips, frame, geometry.width, geometry.height);
  const fx = clip.effects;
  const proxyValid = source.proxy?.complete === true && source.proxy_source_sha256 === source.file?.sha256 && source.proxy.frame_count === source.duration_frames;
  const file = proxy && proxyValid ? source.proxy?.file : source.file;
  const url = file ? mediaUrl(file.node_id, file.file_id) : undefined;
  const isAudio = track.kind === "audio";
  const textSource = source.kind === "text";
  const compose = composite ? { canvas: composite, compose: () => { composeBelow(composite, stack, { timeline: shown, tracks: below, frame, width: geometry.width, height: geometry.height }); } } : null;
  const { failure: renderFailure, requestDraw } = useClipRenderer(
    canvasRef,
    videoRef,
    imageRef,
    url,
    geometry.width,
    geometry.height,
    !isAudio,
    { clip, localFrame: processing, fit: geometry.fit ?? "contain", transitionBlur: transition.look?.blur ?? null },
    { picture: textSource ? "text" : adjustment ? "composite" : "media", composite: compose, readable, onDraw: () => { stack.drawn(order); } },
  );
  // An adjustment layer draws again when a layer under it drew a new picture (a video that seeked, a font that loaded)
  useEffect(() => {
    if (!adjustment) return undefined;
    return stack.listen((from) => {
      if (from < order) requestDraw();
    });
  }, [adjustment, stack, order, requestDraw]);
  // The picture this layer shows, for the adjustment layers above it (while it is mounted)
  const attach = useCallback(
    (element: HTMLCanvasElement | null) => {
      canvasRef.current = element;
      if (!element) return undefined;
      const remove = stack.register(clip.clip_id, element);
      return () => {
        remove();
        if (canvasRef.current === element) canvasRef.current = null;
      };
    },
    [stack, clip.clip_id],
  );
  const sourceEffects = isAudio && fx ? { ...fx, frame_step: 1 } : fx;
  const sourceFrame = clip.in_frame + clipSourceFrame(sourceEffects, clip.out_frame - clip.in_frame, processing);
  const holdStart = fx?.hold?.start ?? 0;
  const held = processing < holdStart || processing >= complete - (fx?.hold?.end ?? 0);
  const speed = fx?.speed_percent ?? 100;
  const silent = !active || held || fx?.mute;
  const level = dbToGain(motion.gain_db + track.gain_db + timeline.master_gain_db + (fx?.volume_db ?? 0));
  const gain = (silent === true) ? 0 : level * audioFadeFactor(fx, complete, processing) * transition.gain;
  const left = (1 - Math.max(0, motion.pan)) * (1 - Math.max(0, track.pan));
  const right = (1 + Math.min(0, motion.pan)) * (1 + Math.min(0, track.pan));
  const steps = fx?.frame_step ?? 1;

  useEffect(() => {
    const media = videoRef.current;
    if (!media || !(url != null && url !== "")) return;
    if (isAudio) audio.update(media, { gain, left, right });
    const audioFrame = clip.in_frame + Math.max(0, Math.min(clip.out_frame - clip.in_frame, ((processing - holdStart) * speed) / 100));
    const target = (isAudio ? audioFrame : sourceFrame + 0.5) / fps;
    const moving = active && playing && rate > 0 && !held && (isAudio || steps === 1);
    // While playing the media runs on its own clock and is only corrected when it drifts; paused, it shows the exact frame
    const drift = Math.abs(media.currentTime - target);
    if (moving ? drift > 0.1 : drift > 0.0005) media.currentTime = Math.max(0, target);
    media.playbackRate = Math.max(0.25, Math.min(4, (rate * speed) / 100));
    if (!moving) {
      media.pause();
      return;
    }
    if (!media.paused) return;
    void media.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      playhead.setPlaying(false);
      warn(t("瀏覽器無法播放這個素材，請確認媒體格式"));
    });
  }, [active, audio, clip.in_frame, clip.out_frame, fps, gain, held, holdStart, isAudio, left, playhead, playing, processing, rate, right, sourceFrame, speed, steps, url, warn]);

  useEffect(() => {
    const media = videoRef.current;
    return () => {
      if (!media) return;
      media.pause();
      audio.release(media);
    };
  }, [audio]);

  if (!active) return null;
  if ((!(url != null && url !== "") && !textSource && !adjustment) || failed || (renderFailure != null && renderFailure !== "")) {
    if (quiet) return null;
    const message = renderFailure ?? (!(url != null && url !== "") ? t("「{name}」尚未完成渲染", { name: source.name }) : t("無法讀取「{name}」", { name: source.name }));
    return (
      <div role="status" className={cn("absolute inset-0 grid place-items-center bg-sunken p-4 text-center text-caption text-warning", isAudio && "inset-auto bottom-2 left-2 z-30 rounded-md")}>
        {message}
      </div>
    );
  }
  // The transition acts on the picture as the clip's motion left it: the outer layer moves, masks and fades it in canvas
  // space and adds it to the track (the export's premultiplied sum); the inner one carries the clip's own motion.
  const outer: CSSProperties | undefined = isAudio
    ? undefined
    : {
        opacity: transition.alpha * (transition.look?.opacity ?? 1),
        mixBlendMode: "plus-lighter",
        filter: washFilter(transition),
        ...(transition.look ? lookStyle(transition.look) : {}),
      };
  const inner: CSSProperties | undefined = isAudio
    ? undefined
    : {
        opacity: motion.opacity,
        transform: `translate(${String(motion.x * 100)}%, ${String(motion.y * 100)}%) rotate(${String(motion.rotation)}deg) scale(${String(motion.scale)})`,
      };
  return (
    <div className={cn("absolute inset-0 origin-center", isAudio && "pointer-events-none opacity-0")} style={outer}>
      <div className="absolute inset-0 origin-center" style={inner}>
        {textSource || adjustment ? null : source.kind === "image" ? (
          <img ref={imageRef} src={url} alt="" aria-hidden className="pointer-events-none absolute size-full opacity-0" onError={() => { setFailed(true); }} />
        ) : (
          <AssetVideo ref={videoRef} src={url} muted={!isAudio} playsInline preload="auto" aria-hidden className="pointer-events-none absolute size-full opacity-0" onError={() => { setFailed(true); }} />
        )}
        {/* A canvas keeps its context's settings: a new one when the pictures must be readable or need not be */}
        {!isAudio ? <canvas key={readable ? "readable" : "shown"} ref={attach} className="absolute inset-0 size-full" aria-label={clip.name} /> : null}
      </div>
    </div>
  );
}

/**
 * transform: show the move / scale / rotate frame of the selected video clip (Edit workspace, while its motion is being
 * edited). The picture alone is what the Shots monitor mounts.
 */
export function ProgramViewer({ zoom = "fit", transform = false, className }: { zoom?: ViewerZoom; transform?: boolean; className?: string }) {
  const editor = useEditor();
  const { timeline, project, playhead, transport, selectedClip, patchClip } = editor;
  const [draft, setDraft] = useState<TimelineClip | null>(null);
  // Parked on the end of the sequence, the monitor keeps showing the last frame
  const frame = Math.min(usePlayheadFrame(playhead), Math.max(0, editor.totalFrames - 1));
  const playing = usePlaying(playhead);
  const geometry = exportGeometry(project);
  const { attach } = transport;
  useEffect(() => attach(), [attach]);
  const visible = useMemo(() => {
    const solo = {
      video: timeline.tracks.some((track) => track.kind === "video" && track.solo),
      audio: timeline.tracks.some((track) => track.kind === "audio" && track.solo),
    };
    return timeline.tracks.filter((track) => !track.muted && (!solo[track.kind] || track.solo));
  }, [timeline.tracks]);
  const selectedTrack = editor.trackOf(selectedClip);
  // An adjustment layer has no picture to move, scale or rotate
  const overlay = transform && selectedClip && selectedTrack?.kind === "video" && !isAdjustment(timeline, selectedClip) ? selectedClip : null;
  const [stack] = useState(createLayerStack);
  const shown = useMemo(() => (draft ? { ...timeline, clips: timeline.clips.map((clip) => (clip.clip_id === draft.clip_id ? draft : clip)) } : timeline), [timeline, draft]);
  // Layers keep their pictures readable while an adjustment layer could read them
  const readable = useMemo(() => {
    const shown = new Set(visible.filter((track) => track.kind === "video").map((track) => track.track_id));
    const adjustments = new Set(timeline.sources.filter((source) => source.kind === "adjustment").map((source) => source.source_id));
    return timeline.clips.some((clip) => clipEnabled(clip) && shown.has(clip.track_id) && adjustments.has(clip.source_id));
  }, [timeline.clips, timeline.sources, visible]);
  // Sources a visible video layer shows under the playhead: their audio layers leave the "not rendered" notice to it
  const pictured = new Set(
    visible
      .filter((track) => track.kind === "video")
      .flatMap((track) => trackClips(timeline, track.track_id).filter((clip) => frame >= clip.start_frame && frame < clipEnd(clip) && clipEnabled(clip)))
      .map((clip) => clip.source_id),
  );
  return (
    <ViewerFrame
      width={geometry.width}
      height={geometry.height}
      zoom={zoom}
      title={PREVIEW_DISCLAIMER}
      {...(className === undefined ? {} : { className })}
      overlay={
        overlay ? (
          <TransformOverlay
            key={overlay.clip_id}
            clip={draft?.clip_id === overlay.clip_id ? draft : overlay}
            original={overlay}
            frame={frame}
            locked={selectedTrack?.locked ?? true}
            onPreview={setDraft}
            onCommit={(clip) => {
              setDraft(null);
              patchClip(clip);
            }}
            onCancel={() => { setDraft(null); }}
            onStart={() => { playhead.setPlaying(false); }}
          />
        ) : null
      }
    >
      {visible.map((track, order) => {
          const clips = trackClips(timeline, track.track_id).filter((clip) => frame >= clip.start_frame && frame < clipEnd(clip) && clipEnabled(clip));
          const mode = clips[0]?.blend_mode ?? "normal";
          const below = visible.slice(0, order).filter((item) => item.kind === "video");
          return (
            <div key={track.track_id} className="pointer-events-none absolute inset-0 isolate" style={{ mixBlendMode: mode === "add" ? "plus-lighter" : mode }}>
              {clips.map((clip) => {
                const source = timeline.sources.find((item) => item.source_id === clip.source_id);
                if (!source) return null;
                const media = editor.proxy ? (source.proxy?.file.sha256 ?? "proxy") : "original";
                return (
                  <Layer
                    key={`${clip.clip_id}:${source.file?.sha256 ?? "pending"}:${media}`}
                    clip={draft?.clip_id === clip.clip_id ? draft : clip}
                    source={source}
                    track={track}
                    frame={frame}
                    playing={playing && transport.rate > 0}
                    stack={stack}
                    order={order}
                    readable={readable}
                    below={below}
                    shown={shown}
                    quiet={track.kind === "audio" && pictured.has(clip.source_id)}
                  />
                );
              })}
            </div>
          );
        })}
      {timeline.captions
        .filter((caption) => frame >= caption.start_frame && frame < caption.end_frame)
        .map((caption) => (
          <CaptionImage key={caption.caption_id} caption={caption} width={geometry.width} height={geometry.height} />
        ))}
    </ViewerFrame>
  );
}
