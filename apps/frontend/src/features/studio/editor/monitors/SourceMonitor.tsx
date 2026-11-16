// The Source monitor: the media selected in the Project panel (or the source of the selected clip), with In and Out
// marks and the three-point edits. Same anatomy as the Program monitor: viewer, scrub bar, timecode row, transport.
// Which tracks an insert or overwrite lands on is decided by the source patches in the track headers.
import { AudioLines, ArrowLeftToLine, ArrowRightToLine, CornerDownLeft, CornerDownRight, Pause, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import type { TimelineSource } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { detectApplePlatform, modifierLabel } from "@/lib/keyboard";
import { usePlaying } from "../../hooks/playhead";
import { endSourceDrag, writeSourceDrag } from "../dragSource";
import { useEditor, type SourceMonitorHandle } from "../editorContext";
import { chordOf } from "../keymap";
import { useSourceMarks, type SourceRange } from "../sourceMarks";
import { MarkGlyph, MonitorButton, ScrubBar, TimecodeRow, TransportRow, ZoomMenu } from "./MonitorChrome";
import { useSourcePlayback } from "./useSourcePlayback";
import { ViewerFrame, type ViewerZoom } from "./ViewerFrame";

/** The file the monitor plays: the verified proxy while proxy playback is on, else the original. */
function previewFile(source: TimelineSource, useProxy: boolean, fps: { num: number; den: number }) {
  const proxy = source.proxy;
  const verified = proxy?.complete && proxy.frame_count === source.duration_frames && proxy.fps?.num === fps.num && proxy.fps.den === fps.den && source.proxy_source_sha256 === source.file?.sha256;
  return useProxy && verified ? proxy.file : source.file;
}

interface LoadedSourceProps {
  source: TimelineSource;
  /** The file that plays (the original or its proxy); null while the shot is not rendered. */
  url: string | null;
  range: SourceRange;
  onRange: (range: SourceRange) => void;
}

function LoadedSource({ source, url, range, onRange }: LoadedSourceProps) {
  const editor = useEditor();
  const { fps, sourceMonitor, ui } = editor;
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState<ViewerZoom>("fit");
  const total = source.duration_frames;
  const hasAudio = source.kind === "audio" || source.has_audio;
  const { attachMedia, frame, playing, problem, seek, toggle, shuttle, fail } = useSourcePlayback({
    total,
    fps,
    range,
    onPlay: () => editor.playhead.setPlaying(false),
    onProblem: editor.warn,
  });
  const sequencePlaying = usePlaying(editor.playhead);
  const stopForSequence = useEffectEvent(() => shuttle(0, false));
  useEffect(() => {
    if (sequencePlaying) stopForSequence();
  }, [sequencePlaying]);

  const mark = (edge: "in" | "out") => onRange(edge === "in" ? { inFrame: frame, outFrame: Math.max(range.outFrame, frame + 1) } : { inFrame: Math.min(range.inFrame, frame), outFrame: frame + 1 });
  const seekEdge = (edge: "start" | "end" | "in" | "out") => seek(edge === "start" ? 0 : edge === "end" ? total - 1 : edge === "in" ? range.inFrame : range.outFrame - 1);
  const place = (mode: "insert" | "overwrite") => {
    shuttle(0, false);
    editor.place(source, range.inFrame, range.outFrame, mode);
  };

  // The key map drives this monitor while its panel has the focus
  const live = useEffectEvent((): SourceMonitorHandle => ({ toggle, step: (frames) => seek(frame + frames), seekEdge, mark, shuttle }));
  useEffect(
    () =>
      sourceMonitor.register({
        toggle: () => live().toggle(),
        step: (frames) => live().step(frames),
        seekEdge: (edge) => live().seekEdge(edge),
        mark: (edge) => live().mark?.(edge),
        shuttle: (direction, slow) => live().shuttle?.(direction, slow),
      }),
    [sourceMonitor],
  );
  // Match frame: show the frame that was asked for
  const matched = ui.intent?.panel === "source" && ui.intent.frame !== undefined ? ui.intent : null;
  const showMatch = useEffectEvent((target: number) => seek(target));
  useEffect(() => {
    if (matched?.frame !== undefined) showMatch(matched.frame);
  }, [matched]);

  const noMedia = !url || problem !== null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
      <ViewerFrame
        width={source.width || 16}
        height={source.height || 9}
        zoom={zoom}
        className="rounded-lg"
        drag={{
          title: t("拖到時間軸：放下覆寫，按住 {key} 插入", { key: modifierLabel("Mod", detectApplePlatform()) }),
          onStart: (event) => {
            shuttle(0, false);
            writeSourceDrag(event.dataTransfer, { sourceId: source.source_id, inFrame: range.inFrame, outFrame: range.outFrame });
          },
          onEnd: endSourceDrag,
        }}
      >
        {url && source.kind === "image" ? (
          <img src={url} alt={source.name} draggable={false} onError={fail} className="absolute inset-0 size-full object-contain animate-fade-in" />
        ) : null}
        {url && source.kind === "video" ? (
          <video ref={attachMedia} src={url} muted={muted} preload="metadata" playsInline onError={fail} aria-label={t("來源影片預覽")} className="absolute inset-0 size-full object-contain animate-fade-in" />
        ) : null}
        {url && source.kind === "audio" ? (
          <>
            <audio ref={attachMedia} src={url} muted={muted} preload="metadata" onError={fail} aria-label={t("來源聲音預覽")} />
            <div className="absolute inset-0 grid place-items-center">
              <AudioLines aria-hidden className="size-10 text-clip-audio-edge" />
            </div>
          </>
        ) : null}
        {noMedia ? (
          <div role="status" className="absolute inset-0 grid place-items-center bg-stage p-3 text-center text-data text-fg-secondary">
            {problem ?? t("等待素材：這個鏡頭還沒有渲染完成")}
          </div>
        ) : null}
      </ViewerFrame>
      <ScrubBar frame={frame} total={total} fps={fps} range={{ start: range.inFrame, end: range.outFrame }} label={t("來源播放位置")} onSeek={seek} />
      <TimecodeRow frame={frame} total={source.kind === "image" ? range.outFrame - range.inFrame : total} fps={fps}>
        <ZoomMenu zoom={zoom} onZoom={setZoom} />
      </TimecodeRow>
      <TransportRow label={t("來源播放控制")}>
        <MonitorButton label={t("標記入點")} shortcut={chordOf("markIn")} onClick={() => mark("in")}>
          <MarkGlyph edge="in" />
        </MonitorButton>
        <MonitorButton label={t("標記出點")} shortcut={chordOf("markOut")} onClick={() => mark("out")}>
          <MarkGlyph edge="out" />
        </MonitorButton>
        <MonitorButton label={t("到入點")} shortcut={chordOf("goIn")} onClick={() => seekEdge("in")}>
          <ArrowLeftToLine aria-hidden />
        </MonitorButton>
        <MonitorButton label={t("上一影格")} shortcut={chordOf("stepBack")} onClick={() => seek(frame - 1)}>
          <StepBack aria-hidden />
        </MonitorButton>
        <MonitorButton label={playing ? t("停止") : t("播放")} shortcut={chordOf("playToggle")} onClick={toggle} primary disabledReason={source.kind === "image" ? t("靜態圖片沒有播放") : noMedia ? t("素材還不能播放") : null}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </MonitorButton>
        <MonitorButton label={t("下一影格")} shortcut={chordOf("stepForward")} onClick={() => seek(frame + 1)}>
          <StepForward aria-hidden />
        </MonitorButton>
        <MonitorButton label={t("到出點")} shortcut={chordOf("goOut")} onClick={() => seekEdge("out")}>
          <ArrowRightToLine aria-hidden />
        </MonitorButton>
        <MonitorButton label={muted ? t("取消靜音") : t("靜音")} onClick={() => setMuted(!muted)} pressed={muted} disabledReason={hasAudio ? null : t("這個素材沒有聲音")}>
          {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </MonitorButton>
        <span aria-hidden className="mx-1.5 h-5 w-px bg-line-subtle" />
        <MonitorButton label={t("插入")} text={t("插入")} shortcut={chordOf("insert")} onClick={() => place("insert")}>
          <CornerDownRight aria-hidden className="rotate-90" />
        </MonitorButton>
        <MonitorButton label={t("覆寫")} text={t("覆寫")} shortcut={chordOf("overwrite")} onClick={() => place("overwrite")}>
          <CornerDownLeft aria-hidden className="-rotate-90" />
        </MonitorButton>
      </TransportRow>
    </div>
  );
}

/** The 來源 tab: the loaded source, or what to do when there is none. */
export function SourceMonitor() {
  const { source, project, timeline, proxy } = useEditor();
  const { range, setRange } = useSourceMarks(project.project_id, source, timeline.fps);
  const file = source ? previewFile(source, proxy, timeline.fps) : null;
  const url = file ? mediaUrl(file.node_id, file.file_id) : null;
  if (!source || !range) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
        <EmptyState size="compact" illustration="frames" title={t("沒有來源素材")} description={t("在「專案」面板按兩下素材，或選取時間軸上的片段。")} />
      </div>
    );
  }
  // Keyed by the media that plays: another source, a finished render or switching to the proxy starts a fresh monitor
  return <LoadedSource key={`${source.source_id}:${url ?? "pending"}`} source={source} url={url} range={range} onRange={setRange} />;
}
