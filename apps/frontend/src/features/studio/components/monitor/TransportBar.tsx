import { hasSlotContent } from "@/lib/dom";
// The transport of the Shots monitor as its own row under the picture (never over it): the scrub bar across the full
// width, then the timecode, the playback buttons (and the caller's extra ones) and the length. The same parts as the
// Edit workspace's monitors (editor/monitors/MonitorChrome); the buttons keep the focus where it was, so Space keeps
// playing after a click.
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/i18n";
import { chordOf } from "../../editor/keymap";
import { MonitorButton, ScrubBar, TransportRow } from "../../editor/monitors/MonitorChrome";
import { formatTimecode } from "../../model/frames";

export interface TransportBarProps {
  frame: number;
  total: number;
  fps: number;
  playing: boolean;
  /** Why nothing can play (no video yet); the controls stay in place and say so. */
  disabledReason?: string | null;
  labels: { group: string; scrub: string; play: string };
  onSeek: (frame: number) => void;
  onToggle: () => void;
  onStep: (frames: number) => void;
  /** Extra buttons after the playback ones (loop, mute). */
  children?: ReactNode;
}

export function TransportBar({ frame, total, fps, playing, disabledReason = null, labels, onSeek, onToggle, onStep, children }: TransportBarProps) {
  const last = Math.max(0, total - 1);
  const at = Math.min(frame, last);
  return (
    <div className="@container grid shrink-0 gap-0.5">
      <ScrubBar frame={at} total={total} fps={fps} label={labels.scrub} onSeek={onSeek} />
      <div className="flex min-h-9 items-center gap-2">
        <span className="machine w-24 shrink-0 text-data text-brand-cyan" title={t("目前位置")}>
          {formatTimecode(at, fps)}
        </span>
        <div className="flex min-w-0 flex-1 justify-center">
          <TransportRow label={labels.group}>
            <MonitorButton label={t("到開頭")} shortcut={chordOf("goStart")} disabledReason={disabledReason} onClick={() => { onSeek(0); }}>
              <SkipBack aria-hidden />
            </MonitorButton>
            <MonitorButton label={t("上一影格")} shortcut={chordOf("stepBack")} disabledReason={disabledReason} onClick={() => { onStep(-1); }}>
              <StepBack aria-hidden />
            </MonitorButton>
            <MonitorButton label={playing ? t("暫停") : labels.play} shortcut={chordOf("playToggle")} disabledReason={disabledReason} onClick={onToggle} primary>
              {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            </MonitorButton>
            <MonitorButton label={t("下一影格")} shortcut={chordOf("stepForward")} disabledReason={disabledReason} onClick={() => { onStep(1); }}>
              <StepForward aria-hidden />
            </MonitorButton>
            <MonitorButton label={t("到結尾")} shortcut={chordOf("goEnd")} disabledReason={disabledReason} onClick={() => { onSeek(last); }}>
              <SkipForward aria-hidden />
            </MonitorButton>
            {hasSlotContent(children) ? (
              <>
                <span aria-hidden className="mx-1 h-5 w-px bg-line-subtle" />
                {children}
              </>
            ) : null}
          </TransportRow>
        </div>
        <span className="machine hidden w-24 shrink-0 text-right text-caption text-fg-tertiary @[34rem]:inline" title={t("長度")}>
          {formatTimecode(total, fps)}
        </span>
      </div>
    </div>
  );
}
