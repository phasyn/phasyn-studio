// The fade group of a clip's effects as the panels write it. A fade of 0 frames is left out, and a group with nothing
// in it is left out of the effects: such leftovers change nothing in the picture or the sound, but a clip that
// carries them reads as edited, and the Controller lets only an untouched clip follow its shot's new take.
import type { Effects, Fade } from "../../../model/clipEffects";

export function withFade(effects: Effects, patch: Fade): Effects {
  const merged: Fade = { ...effects.fade, ...patch };
  const kept: Fade = {};
  for (const edge of ["video_in", "video_out", "audio_in", "audio_out"] as const) {
    const frames = merged[edge];
    if (frames !== undefined && frames > 0) kept[edge] = frames;
  }
  const { fade: _fade, ...rest } = effects;
  return Object.keys(kept).length > 0 ? { ...rest, fade: kept } : rest;
}
