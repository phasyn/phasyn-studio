// Track header. Full timeline (184 px): source patch (which source channel lands here), track targeting, lock, sync
// lock, output (eye for video, M / S for audio), the name (double-click renames) and a menu with the rest. Compact
// timeline: the track's label and name only.
import { focusOpenedControl } from "@/lib/dom";
import { Ellipsis, Eye, EyeOff, Link2, LockKeyhole, LockKeyholeOpen, Unlink2 } from "lucide-react";
import { useState, type MouseEvent, type PointerEvent } from "react";
import type { TimelineTrack } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import type { Editor } from "../editorContext";
import { TRACK_HEIGHTS, TRACK_SIZES, type TrackSize } from "../timelineGeometry";

const CHIP = "pressable grid h-6 min-w-6 shrink-0 place-items-center rounded-[5px] border px-1 font-mono text-[11px] leading-none";
const CHIP_ON = "border-brand-blue/60 bg-brand-gradient-soft text-fg";
const CHIP_OFF = "border-line-subtle text-fg-tertiary hover:border-line-strong hover:text-fg-secondary";
const ICON = "pressable grid size-6 shrink-0 place-items-center rounded-[5px] text-fg-tertiary hover:bg-raised hover:text-fg [&_svg]:size-3.5";
const ICON_ON = "bg-brand-gradient-soft text-brand-cyan ring-1 ring-brand-blue/45 ring-inset";

export function CompactTrackHeader({ track, label, width, height }: { track: TimelineTrack; label: string; width: number; height: number }) {
  return (
    <div className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-line-strong bg-surface px-2" style={{ width, height }}>
      <span className={cn(CHIP, "pointer-events-none border-line-subtle text-fg-secondary")}>{label}</span>
      {track.name !== label ? (
        <span className="min-w-0 truncate text-caption text-fg-tertiary" title={track.name}>
          {track.name}
        </span>
      ) : null}
      {track.locked ? <LockKeyhole aria-label={t("已鎖定")} className="ml-auto size-3 shrink-0 text-fg-tertiary" /> : null}
    </div>
  );
}

export interface TrackHeaderProps {
  track: TimelineTrack;
  label: string;
  editor: Editor;
  width: number;
  size: TrackSize;
  /** Mounted to rename (the track menu's "rename"). */
  startRenaming?: boolean;
  onRenamed?: () => void;
  onResize: (size: TrackSize) => void;
  onMenu: (event: MouseEvent<HTMLElement>) => void;
}

export function TrackHeader({ track, label, editor, width, size, startRenaming = false, onRenamed, onResize, onMenu }: TrackHeaderProps) {
  const [renaming, setRenaming] = useState(startRenaming);
  const endRenaming = () => {
    setRenaming(false);
    onRenamed?.();
  };
  const video = track.kind === "video";
  const patched = (video ? editor.videoTarget : editor.audioTarget) === track.track_id;
  const patchOn = patched && (video ? editor.patchVideo : editor.patchAudio);
  const targeted = editor.targets.has(track.track_id);
  const height = TRACK_HEIGHTS[size];
  const patch = (value: Partial<Pick<TimelineTrack, "locked" | "muted" | "solo" | "sync_lock" | "name">>) => editor.command({ type: "patchTrack", trackId: track.track_id, patch: value });
  const togglePatch = () => {
    // A click on the lit chip switches the patch off; on another track it moves the patch there and switches it on
    if (patched) (video ? editor.setPatchVideo : editor.setPatchAudio)(!patchOn);
    else {
      (video ? editor.setVideoTarget : editor.setAudioTarget)(track.track_id);
      (video ? editor.setPatchVideo : editor.setPatchAudio)(true);
    }
  };
  const drag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const origin = event.clientY;
    target.setPointerCapture(event.pointerId);
    const move = (moved: globalThis.PointerEvent) => {
      const wanted = height + moved.clientY - origin;
      const next = TRACK_SIZES.reduce((best, item) => (Math.abs(TRACK_HEIGHTS[item] - wanted) < Math.abs(TRACK_HEIGHTS[best] - wanted) ? item : best), size);
      if (next !== size) onResize(next);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const patchTitle = video ? t("來源視訊放到 {name}", { name: track.name }) : t("來源音訊放到 {name}", { name: track.name });
  const controls = (
    <>
      <button type="button" className={cn(ICON, track.locked ? ICON_ON : "text-fg-secondary")} aria-pressed={track.locked} aria-label={t("鎖定 {name}", { name: track.name })} title={t("鎖定 {name}", { name: track.name })} onClick={() => void patch({ locked: !track.locked })}>
        {track.locked ? <LockKeyhole aria-hidden /> : <LockKeyholeOpen aria-hidden />}
      </button>
      <button
        type="button"
        className={cn(ICON, track.sync_lock ? "text-fg-secondary" : "text-fg-disabled")}
        aria-pressed={track.sync_lock}
        aria-label={t("同步鎖定 {name}", { name: track.name })}
        title={track.sync_lock ? t("{name} 同步鎖定中：波紋編輯時跟著移動", { name: track.name }) : t("{name} 未同步鎖定：波紋編輯時留在原位", { name: track.name })}
        onClick={() => void patch({ sync_lock: !track.sync_lock })}
      >
        {track.sync_lock ? <Link2 aria-hidden /> : <Unlink2 aria-hidden />}
      </button>
      {video ? (
        <button type="button" className={cn(ICON, track.muted ? "text-warning" : "text-fg-secondary")} aria-pressed={!track.muted} aria-label={t("輸出 {name}", { name: track.name })} title={track.muted ? t("{name} 不輸出（隱藏）", { name: track.name }) : t("{name} 輸出中", { name: track.name })} onClick={() => void patch({ muted: !track.muted })}>
          {track.muted ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </button>
      ) : (
        <>
          <button type="button" className={cn(CHIP, "border-transparent", track.muted ? "bg-warning/20 text-warning" : "text-fg-secondary hover:bg-raised hover:text-fg")} aria-pressed={track.muted} aria-label={t("靜音 {name}", { name: track.name })} title={t("靜音 {name}", { name: track.name })} onClick={() => void patch({ muted: !track.muted })}>
            M
          </button>
          <button type="button" className={cn(CHIP, "border-transparent", track.solo ? "bg-brand-gradient-soft text-brand-cyan" : "text-fg-secondary hover:bg-raised hover:text-fg")} aria-pressed={track.solo} aria-label={t("獨奏 {name}", { name: track.name })} title={t("獨奏 {name}", { name: track.name })} onClick={() => void patch({ solo: !track.solo })}>
            S
          </button>
        </>
      )}
    </>
  );
  const name = renaming ? (
    <input
      ref={focusOpenedControl}
      defaultValue={track.name}
      maxLength={40}
      aria-label={t("軌道名稱")}
      className="h-6 min-w-0 flex-1 rounded-sm border border-line-control bg-sunken px-1 text-caption text-fg outline-none focus-visible:border-focus"
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next && next !== track.name) patch({ name: next });
        endRenaming();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") endRenaming();
      }}
    />
  ) : (
    <button onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setRenaming(true); } }} type="button" className="min-w-0 flex-1 truncate text-caption text-fg-secondary" title={t("{name}（按兩下重新命名）", { name: track.name })} onDoubleClick={() => { setRenaming(true); }}>
      {track.name === label ? "" : track.name}
    </button>
  );
  const head = (
    <>
      <button type="button" className={cn(CHIP, patchOn ? CHIP_ON : patched ? "border-line-control text-fg-tertiary" : "border-dashed border-line-subtle text-transparent hover:text-fg-tertiary")} aria-pressed={patchOn} aria-label={patchTitle} title={patchTitle} onClick={togglePatch}>
        {video ? "V" : "A"}
      </button>
      <button type="button" className={cn(CHIP, targeted ? CHIP_ON : CHIP_OFF)} aria-pressed={targeted} aria-label={t("目標軌道 {name}", { name: track.name })} title={t("目標軌道 {name}", { name: track.name })} onClick={() => { editor.toggleTarget(track.track_id); }}>
        {label}
      </button>
    </>
  );
  const menu = (
    <button type="button" className={cn(ICON, "ml-auto")} aria-haspopup="menu" aria-label={t("{name} 的軌道選單", { name: track.name })} title={t("{name} 的軌道選單", { name: track.name })} onClick={onMenu}>
      <Ellipsis aria-hidden />
    </button>
  );
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- The track context menu also opens from its keyboard-operable actions button. */  data-keep-focus="" className="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 border-r border-line-strong bg-surface px-1.5" style={{ width, height }} onContextMenu={onMenu}>
      {size === "s" ? (
        <div className="flex min-w-0 items-center gap-0.5">
          {head}
          {controls}
          {name}
          {menu}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1">
            {head}
            {name}
            {menu}
          </div>
          <div className="flex min-w-0 items-center gap-0.5">
            {controls}
            {!video ? <span className="machine ml-auto pr-1 text-[11px] text-fg-secondary">{t("{gain} dB", { gain: `${track.gain_db > 0 ? "+" : ""}${String(track.gain_db)}` })}</span> : null}
          </div>
        </>
      )}
      <span aria-hidden onPointerDown={drag} className="absolute inset-x-0 -bottom-0.5 h-1.5 cursor-row-resize touch-none" />
    </div>
  );
}
