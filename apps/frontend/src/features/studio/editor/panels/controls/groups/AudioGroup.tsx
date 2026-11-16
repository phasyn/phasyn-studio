// The Audio group: the sound of a clip on an audio track (the selected clip itself, or the sound linked to a selected
// picture). One volume in dB: the clip's gain, with the effect volume of an older document folded in on the first
// edit; pan, mute and the fades of the sound, in frames. Volume and pan can be animated.
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { FADE_MAX_FRAMES, type Fade } from "../../../../model/clipEffects";
import { processedDuration } from "../../../model";
import { NumberField, SwitchField } from "../fields";
import { Group } from "../Group";
import { withFade } from "../fades";
import { useClipPanel } from "../panelContext";
import { formatShown, FRAMES_SUFFIX, UNITS, type AudioProperties } from "../properties";
import { PropertyRow } from "../PropertyRow";
import { Row } from "../rows";

const HINTS = {
  pan: t("−100 是全左，0 是置中，100 是全右"),
  fadeIn: t("聲音從無聲淡入的影格數"),
  fadeOut: t("聲音淡出到無聲的影格數"),
} as const;

export interface AudioGroupProps {
  /** The clip on the audio track. */
  clip: TimelineClip;
  audio: AudioProperties;
}

export function AudioGroup({ clip, audio }: AudioGroupProps) {
  const panel = useClipPanel();
  const { motion } = clip;
  const effects = clip.effects ?? {};
  const fade = effects.fade ?? {};
  const duration = processedDuration(clip);
  const fadeIn = fade.audio_in ?? 0;
  const fadeOut = fade.audio_out ?? 0;
  const keys = (motion.keyframes.gain_db?.length ?? 0) + (motion.keyframes.pan?.length ?? 0);
  const animated = keys > 0;
  const levelled = motion.gain_db !== 0 || motion.pan !== 0 || (effects.volume_db ?? 0) !== 0 || effects.mute === true;
  const change = (patch: Fade): TimelineClip => ({ ...clip, effects: withFade(effects, patch) });
  const reset = () => {
    const { gain_db: _gain, pan: _pan, ...keyframes } = motion.keyframes;
    const { volume_db: _volume, mute: _mute, ...rest } = effects;
    panel.perform({ ...clip, motion: { ...motion, gain_db: 0, pan: 0, keyframes }, effects: withFade(rest, { audio_in: 0, audio_out: 0 }) });
  };
  // An effect volume the gain could not take in is still part of the loudness: the volume's tooltip says so
  const extra = audio.legacy !== 0 ? t("另有舊版的效果音量 {volume} 會再相加", { volume: formatShown(UNITS.decibels, audio.legacy) }) : undefined;
  return (
    <Group id="audio" title={t("音訊")} changed={animated || levelled || fadeIn > 0 || fadeOut > 0} onReset={reset} resetKeys={keys}>
      <PropertyRow property={audio.volume} owner={clip} hint={extra} />
      <PropertyRow property={audio.pan} owner={clip} hint={HINTS.pan} />
      <Row label={t("靜音")}>
        <SwitchField
          label={t("靜音")}
          checked={effects.mute ?? false}
          onChange={(mute) => panel.perform({ ...clip, effects: { ...effects, mute } })}
        />
      </Row>
      <Row label={t("淡入")} hint={HINTS.fadeIn}>
        <NumberField
          label={t("音訊淡入")}
          value={fadeIn}
          min={0}
          max={Math.max(0, Math.min(FADE_MAX_FRAMES, duration - fadeOut))}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.fadeIn}
          onCommit={(audio_in) => panel.apply(change({ audio_in }))}
        />
      </Row>
      <Row label={t("淡出")} hint={HINTS.fadeOut}>
        <NumberField
          label={t("音訊淡出")}
          value={fadeOut}
          min={0}
          max={Math.max(0, Math.min(FADE_MAX_FRAMES, duration - fadeIn))}
          suffix={FRAMES_SUFFIX}
          hint={HINTS.fadeOut}
          onCommit={(audio_out) => panel.apply(change({ audio_out }))}
        />
      </Row>
    </Group>
  );
}
