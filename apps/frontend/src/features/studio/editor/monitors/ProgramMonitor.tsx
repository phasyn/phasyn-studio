// The Program monitor of the Edit workspace: the sequence at the playhead (the same compositor the Shots monitor
// uses), a scrub bar with the sequence In / Out range, the timecode row and the transport. The transform box of the
// selected layer shows only while it is switched on here or the Motion group of Effect Controls is selected.
// The monitor can move into its own window (a second screen): the same component rendered there through a portal,
// while the panel shows where it went and how to bring it back.
import { AppWindow, ArrowLeftToLine, ArrowRightToLine, CornerDownLeft, CornerDownRight, ExternalLink, Flag, Gauge, Maximize, MonitorPlay, Move, Pause, Play, StepBack, StepForward, Undo2 } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { PANEL_RAISED, TOOL_BUTTON, TOOL_BUTTON_ON } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { usePlayheadFrame, usePlaying } from "../../hooks/playhead";
import { useEditor } from "../editorContext";
import { chordOf } from "../keymap";
import { MarkGlyph, MonitorButton, ScrubBar, TimecodeRow, TransportRow, ZoomMenu } from "./MonitorChrome";
import { useProgramPopout } from "./popout";
import { ProgramViewer } from "./ProgramViewer";
import type { ViewerZoom } from "./ViewerFrame";

function ProgramBody({ zoom, setZoom }: { zoom: ViewerZoom; setZoom: (zoom: ViewerZoom) => void }) {
  const editor = useEditor();
  const { transport, playhead, timeline, totalFrames, fps, ui } = editor;
  const frame = usePlayheadFrame(playhead);
  const playing = usePlaying(playhead);
  const area = timeline.work_area;
  const noRange = area ? null : t("還沒有標記序列的入點和出點");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
      <ProgramViewer zoom={zoom} transform={ui.transform} className="rounded-lg" />
      <ScrubBar frame={frame} total={totalFrames} fps={fps} range={area ? { start: area.start_frame, end: area.end_frame } : null} label={t("序列播放位置")} end={totalFrames} onSeek={transport.seek} />
      <TimecodeRow frame={frame} total={totalFrames} fps={fps}>
        <ZoomMenu zoom={zoom} onZoom={setZoom} />
      </TimecodeRow>
      <TransportRow label={t("節目播放控制")}>
        <MonitorButton label={t("標記入點")} shortcut={chordOf("markIn")} onClick={() => editor.markRange("in")}>
          <MarkGlyph edge="in" />
        </MonitorButton>
        <MonitorButton label={t("標記出點")} shortcut={chordOf("markOut")} onClick={() => editor.markRange("out")}>
          <MarkGlyph edge="out" />
        </MonitorButton>
        <MonitorButton label={t("到入點")} shortcut={chordOf("goIn")} disabledReason={noRange} onClick={() => transport.seek(area?.start_frame ?? 0)}>
          <ArrowLeftToLine aria-hidden />
        </MonitorButton>
        <MonitorButton label={t("上一影格")} shortcut={chordOf("stepBack")} onClick={() => transport.step(-1)}>
          <StepBack aria-hidden />
        </MonitorButton>
        <MonitorButton label={playing ? t("停止") : t("播放")} shortcut={chordOf("playToggle")} onClick={transport.toggle} primary disabledReason={totalFrames === 0 ? t("時間軸是空的") : null}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </MonitorButton>
        <MonitorButton label={t("下一影格")} shortcut={chordOf("stepForward")} onClick={() => transport.step(1)}>
          <StepForward aria-hidden />
        </MonitorButton>
        <MonitorButton label={t("到出點")} shortcut={chordOf("goOut")} disabledReason={noRange} onClick={() => transport.seek((area?.end_frame ?? 1) - 1)}>
          <ArrowRightToLine aria-hidden />
        </MonitorButton>
        <span aria-hidden className="mx-1.5 h-5 w-px bg-line-subtle" />
        <MonitorButton label={t("提升")} text={t("提升")} shortcut={chordOf("lift")} disabledReason={noRange} onClick={() => editor.removeRange(false)}>
          <CornerDownLeft aria-hidden className="rotate-90" />
        </MonitorButton>
        <MonitorButton label={t("擷取")} text={t("擷取")} shortcut={chordOf("extract")} disabledReason={noRange} onClick={() => editor.removeRange(true)}>
          <CornerDownRight aria-hidden className="-rotate-90" />
        </MonitorButton>
        <MonitorButton label={t("新增標記")} shortcut={chordOf("addMarker")} onClick={() => void editor.addMarker()}>
          <Flag aria-hidden />
        </MonitorButton>
      </TransportRow>
    </div>
  );
}

const WIDE_TOOL = "h-8 w-auto gap-1.5 px-2 text-caption [&_svg]:size-4";

export function ProgramMonitor({ className }: { className?: string }) {
  const editor = useEditor();
  const { transport, playhead, timeline, focus, ui } = editor;
  const playing = usePlaying(playhead);
  const [zoom, setZoom] = useState<ViewerZoom>("fit");
  const [blocked, setBlocked] = useState(false);
  const popout = useProgramPopout(`${t("節目")} — ${editor.project.title}`);
  const rate = playing && transport.rate !== 1 ? `${transport.rate}×` : null;
  const proxies = timeline.sources.some((source) => source.proxy?.complete);
  const openWindow = () => void popout.open().then((opened) => setBlocked(!opened));
  const fullscreen = () => void popout.popup?.document.documentElement.requestFullscreen().catch(() => undefined);
  return (
    <section
      data-editor-panel="program"
      aria-label={t("節目監看器")}
      onPointerDownCapture={() => focus.setPanel("program")}
      className={cn(PANEL_RAISED, focus.panel === "program" && "border-brand-cyan/70", className)}
    >
      <header data-keep-focus="" className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        <MonitorPlay aria-hidden className="size-4 shrink-0 text-brand-cyan" />
        <h2 className="shrink-0 text-body font-semibold text-fg">{t("節目")}</h2>
        <span className="min-w-0 flex-1 truncate text-data text-fg-tertiary" title={editor.project.title}>
          {editor.project.title}
        </span>
        {rate ? <span className="machine shrink-0 rounded-md bg-raised px-1.5 text-caption text-brand-cyan">{rate}</span> : null}
        <button
          type="button"
          className={cn(TOOL_BUTTON, "h-8 w-auto gap-1.5 px-2 text-caption [&_svg]:size-4", editor.proxy && TOOL_BUTTON_ON)}
          aria-pressed={editor.proxy}
          title={proxies ? t("以代理檔播放（匯出一律使用原始媒體）") : t("以代理檔播放；還沒有素材建立代理（在「專案」面板的項目選單建立）")}
          onClick={() => editor.setProxy(!editor.proxy)}
        >
          <Gauge aria-hidden />
          {t("代理")}
        </button>
        <button
          type="button"
          className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", ui.transform && TOOL_BUTTON_ON)}
          aria-pressed={ui.transform}
          aria-label={t("變形控制框")}
          title={t("在畫面上移動、縮放、旋轉選取的圖層")}
          onClick={() => ui.setTransform(!ui.transform)}
        >
          <Move aria-hidden />
        </button>
        <button
          type="button"
          className={cn(TOOL_BUTTON, "size-8 [&_svg]:size-4", popout.container && TOOL_BUTTON_ON)}
          aria-pressed={popout.container !== null}
          aria-label={t("在獨立視窗顯示節目監看")}
          title={popout.container ? t("節目監看正在獨立視窗；按一下收回") : t("把節目監看移到獨立視窗，可以拖到第二個螢幕；兩邊即時同步")}
          onClick={popout.container ? popout.close : openWindow}
        >
          <ExternalLink aria-hidden />
        </button>
      </header>
      {popout.container ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <AppWindow aria-hidden className="size-8 text-brand-cyan" />
            <p className="text-body text-fg-secondary">{t("節目監看正在獨立視窗中顯示")}</p>
            <div className="flex gap-2">
              <button type="button" className={cn(TOOL_BUTTON, WIDE_TOOL)} onClick={() => popout.popup?.focus()}>
                <ExternalLink aria-hidden />
                {t("切到獨立視窗")}
              </button>
              <button type="button" className={cn(TOOL_BUTTON, WIDE_TOOL)} onClick={popout.close}>
                <Undo2 aria-hidden />
                {t("收回")}
              </button>
            </div>
          </div>
          {createPortal(
            <section aria-label={t("節目監看器")} className="flex min-h-0 flex-1 flex-col">
              <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
                <MonitorPlay aria-hidden className="size-4 shrink-0 text-brand-cyan" />
                <h2 className="shrink-0 text-body font-semibold text-fg">{t("節目")}</h2>
                <span className="min-w-0 flex-1 truncate text-data text-fg-tertiary">{editor.project.title}</span>
                {rate ? <span className="machine shrink-0 rounded-md bg-raised px-1.5 text-caption text-brand-cyan">{rate}</span> : null}
                <button type="button" className={cn(TOOL_BUTTON, WIDE_TOOL)} title={t("全螢幕顯示（Esc 離開）")} onClick={fullscreen}>
                  <Maximize aria-hidden />
                  {t("全螢幕")}
                </button>
                <button type="button" className={cn(TOOL_BUTTON, WIDE_TOOL)} title={t("把節目監看收回主視窗")} onClick={popout.close}>
                  <Undo2 aria-hidden />
                  {t("收回")}
                </button>
              </header>
              <ProgramBody zoom={zoom} setZoom={setZoom} />
            </section>,
            popout.container,
          )}
        </>
      ) : (
        <>
          {blocked ? (
            <p role="alert" className="mx-2 mt-2 rounded-md bg-raised px-2 py-1 text-caption text-fg-secondary">
              {t("瀏覽器擋下了新視窗；請允許這個網站開啟彈出式視窗後再試一次")}
            </p>
          ) : null}
          <ProgramBody zoom={zoom} setZoom={setZoom} />
        </>
      )}
    </section>
  );
}
