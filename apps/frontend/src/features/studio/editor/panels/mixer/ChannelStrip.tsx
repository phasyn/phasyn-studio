// The channel strips of the mixer. A track strip carries, from the top: the track (double-click its name to rename
// it), pan, mute and solo, the gain fader and the typed gain. The master strip has the same rows so the faders line
// up; where a track has pan it shows the output's loudest peak and clipping lamp, and its fader stands beside a pair
// of output meters. Every change is one edit: tracks through the patchTrack command, the master gain through a commit.
import { useRef, useState } from "react";
import type { TimelineTrack } from "@/api/generated/contracts";
import { LevelMeter } from "@/components/workbench/LevelMeter";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useEditor } from "../../editorContext";
import { formatDb } from "./decibels";
import { Fader } from "./Fader";
import { GainField } from "./GainField";
import { PanKnob } from "./PanKnob";
import { useLevelMeters } from "./useLevelMeters";

const STRIP = "flex shrink-0 flex-col items-stretch gap-2 px-2 pt-2 pb-2.5";
const TOGGLE = "pressable grid h-7 w-8 place-items-center rounded-md border font-mono text-caption leading-none";
const TOGGLE_OFF = "border-line-subtle text-fg-tertiary hover:border-line-strong hover:text-fg";
/** Longest track name (the same limit as the track header's rename). */
const NAME_LIMIT = 40;

/** The rename field of a strip: Enter or leaving it hands over the text, Esc hands over null. */
function NameField({ value, onDone }: { value: string; onDone: (next: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      defaultValue={value}
      maxLength={NAME_LIMIT}
      aria-label={t("軌道名稱")}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => onDone(cancelled.current ? null : event.target.value.trim())}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancelled.current = true;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
      className="h-6 w-full min-w-0 rounded border border-line-control bg-sunken px-1 text-center text-caption text-fg outline-none focus-visible:border-focus"
    />
  );
}

export interface TrackStripProps {
  track: TimelineTrack;
  /** The track's position label (A1, A2…). */
  label: string;
  /** Another track is soloed, or this one is muted: its controls are drawn back. */
  silent: boolean;
}

export function TrackStrip({ track, label, silent }: TrackStripProps) {
  const editor = useEditor();
  const [renaming, setRenaming] = useState(false);
  const patch = (value: Partial<Pick<TimelineTrack, "name" | "gain_db" | "pan" | "muted" | "solo">>) => editor.command({ type: "patchTrack", trackId: track.track_id, patch: value });
  const rename = (next: string | null) => {
    setRenaming(false);
    if (next && next !== track.name) patch({ name: next });
  };
  return (
    <div role="group" aria-label={t("{name} 聲道", { name: track.name })} className={cn(STRIP, "max-w-32 min-w-[76px] flex-1 border-r border-line-subtle")}>
      {renaming ? (
        <NameField value={track.name} onDone={rename} />
      ) : (
        <div className="flex h-6 min-w-0 items-center justify-center gap-1" title={t("{name}（按兩下重新命名）", { name: track.name })} onDoubleClick={() => setRenaming(true)}>
          <span className="machine shrink-0 text-caption font-semibold text-fg">{label}</span>
          {track.name !== label ? <span className="min-w-0 truncate text-caption text-fg-secondary">{track.name}</span> : null}
        </div>
      )}
      <PanKnob label={t("{name} 的聲像", { name: track.name })} value={track.pan} onCommit={(pan) => patch({ pan })} className={cn("transition-opacity duration-(--duration-fast)", silent && "opacity-50")} />
      <div className="flex justify-center gap-1">
        <button
          type="button"
          aria-pressed={track.muted}
          aria-label={t("靜音 {name}", { name: track.name })}
          title={t("靜音 {name}", { name: track.name })}
          onClick={() => patch({ muted: !track.muted })}
          className={cn(TOGGLE, track.muted ? "border-warning/50 bg-warning/20 text-warning" : TOGGLE_OFF)}
        >
          M
        </button>
        <button
          type="button"
          aria-pressed={track.solo}
          aria-label={t("獨奏 {name}", { name: track.name })}
          title={t("獨奏 {name}", { name: track.name })}
          onClick={() => patch({ solo: !track.solo })}
          className={cn(TOGGLE, track.solo ? "border-brand-blue/60 bg-brand-gradient-soft text-brand-cyan" : TOGGLE_OFF)}
        >
          S
        </button>
      </div>
      <Fader label={t("{name} 的音量", { name: track.name })} value={track.gain_db} onCommit={(gain_db) => patch({ gain_db })} className={cn("flex-1 transition-opacity duration-(--duration-fast)", silent && "opacity-50")} />
      <GainField label={t("{name} 的音量", { name: track.name })} value={track.gain_db} onCommit={(gain_db) => patch({ gain_db })} />
    </div>
  );
}

/** The clipping lamp and the loudest output peak; a click clears both. */
function OutputPeak({ loudest, clipped, onReset }: { loudest: number; clipped: boolean; onReset: () => void }) {
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label={clipped ? t("輸出曾經削波，最大峰值 {value} dBFS；按一下清除", { value: formatDb(loudest) }) : t("輸出最大峰值 {value} dBFS；按一下重設", { value: formatDb(loudest) })}
      title={clipped ? t("輸出曾經削波（達到 0 dBFS）；按一下清除") : t("輸出的最大峰值（dBFS）；按一下重設")}
      className="pressable grid h-[54px] place-content-center justify-items-center gap-1 rounded-md hover:bg-raised"
    >
      <span aria-hidden className={cn("h-1.5 w-7 rounded-full transition-colors duration-(--duration-fast)", clipped ? "bg-danger" : "bg-line-strong")} />
      <span className={cn("machine text-caption leading-none", clipped ? "text-danger" : "text-fg-secondary")}>{formatDb(loudest)}</span>
      <span aria-hidden className="text-[10px] leading-none text-fg-tertiary">dBFS</span>
    </button>
  );
}

const MASTER_TICKS: readonly number[] = [0, -6, -12, -24, -48];

export function MasterStrip() {
  const editor = useEditor();
  const { timeline } = editor;
  const { leftRef, rightRef, clipped, loudest, reset } = useLevelMeters();
  const setGain = (master_gain_db: number) => editor.commit({ ...timeline, master_gain_db });
  return (
    <div role="group" aria-label={t("主輸出聲道")} className={cn(STRIP, "w-24 border-l border-line-strong bg-surface")}>
      <div className="flex h-6 items-center justify-center text-caption font-semibold text-fg">{t("主輸出")}</div>
      <OutputPeak loudest={loudest} clipped={clipped.left || clipped.right} onReset={reset} />
      <div aria-hidden className="h-7" />
      <div className="flex min-h-0 flex-1 items-stretch gap-1.5">
        <Fader label={t("主輸出音量")} value={timeline.master_gain_db} onCommit={setGain} className="flex-1" />
        <div className="flex shrink-0 gap-0.5 py-[7px]" title={t("輸出電平（左、右）")}>
          <LevelMeter ref={leftRef} ticks={MASTER_TICKS} className="w-2" />
          <LevelMeter ref={rightRef} ticks={MASTER_TICKS} className="w-2" />
        </div>
      </div>
      <GainField label={t("主輸出音量")} value={timeline.master_gain_db} onCommit={setGain} />
    </div>
  );
}
