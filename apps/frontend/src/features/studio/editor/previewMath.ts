// Pure preview math of a clip's legacy effects (camera, fades, colour). The browser preview is an approximation; frame
// mapping and fade end points deliberately match FFmpeg (frame 0 fully black, the last frame of a fade-out fully black).
import { COLOR_DEFAULTS, SHAKE_X_RATE, SHAKE_Y_RATE, type Color, type Effects } from "../model/clipEffects";
import { t } from "@/i18n";

/** Shown as the tooltip of the Program viewer. */
export const PREVIEW_DISCLAIMER = t("預覽為近似效果，匯出以 FFmpeg 結果為準");

/** Push-in and shake as a scale and a translation (percent of the picture's width and height). */
export interface CameraView {
  scale: number;
  xPercent: number;
  yPercent: number;
}

/**
 * The camera of frame k of a clip. Like FFmpeg: crop around the centre (push-in; a shake keeps shake_px of margin) and
 * move the crop window along sin / cos with a linear decay; the preview turns that into scale and translate.
 */
export function cameraView(effects: Effects | undefined, k: number, width: number, height: number): CameraView | null {
  const camera = effects?.camera;
  if (!camera) return null;
  const zoom = camera.zoom_percent ?? 100;
  const shakePx = camera.shake_px ?? 0;
  const shakeFrames = camera.shake_frames ?? 0;
  const shakes = shakePx > 0 && shakeFrames > 0;
  const cropW = Math.max(2, Math.floor((width * 100) / zoom - 2 * (shakes ? shakePx : 0)));
  const scale = width / cropW;
  if (!shakes) return { scale, xPercent: 0, yPercent: 0 };
  const cropH = (cropW * height) / width;
  const ampX = Math.min(shakePx, Math.floor((width - cropW) / 2));
  const ampY = Math.min(Math.round((shakePx * height) / width), Math.floor((height - cropH) / 2));
  const decay = Math.max(0, 1 - k / shakeFrames);
  const dx = ampX * Math.sin(k * SHAKE_X_RATE) * decay;
  const dy = ampY * Math.cos(k * SHAKE_Y_RATE) * decay;
  return { scale, xPercent: (-dx / cropW) * 100, yPercent: (-dy / cropH) * 100 };
}

/** Brightness factor of the video fades (1 = picture, 0 = black), the same as FFmpeg's fade. */
export function videoFadeFactor(effects: Effects | undefined, frames: number, k: number): number {
  const fadeIn = effects?.fade?.video_in ?? 0;
  const fadeOut = effects?.fade?.video_out ?? 0;
  let factor = 1;
  if (fadeIn > 0 && k < fadeIn) factor = Math.min(factor, k / fadeIn);
  if (fadeOut > 0) {
    const start = frames - fadeOut - 1;
    if (k >= start) factor = Math.min(factor, Math.max(0, 1 - (k - start) / fadeOut));
  }
  return Math.max(0, Math.min(1, factor));
}

/** Gain factor of the audio fades (the middle of the frame approximates the sample position). */
export function audioFadeFactor(effects: Effects | undefined, frames: number, k: number): number {
  const fadeIn = effects?.fade?.audio_in ?? 0;
  const fadeOut = effects?.fade?.audio_out ?? 0;
  const at = k + 0.5;
  let factor = 1;
  if (fadeIn > 0 && at < fadeIn) factor = Math.min(factor, at / fadeIn);
  if (fadeOut > 0 && at > frames - fadeOut) factor = Math.min(factor, Math.max(0, (frames - at) / fadeOut));
  return Math.max(0, Math.min(1, factor));
}

/**
 * eq (brightness offset, contrast, saturation) as a linear sRGB transform: slope = contrast,
 * intercept = 0.5 − 0.5 × contrast + brightness, then saturate.
 */
export function colorFilterParams(color: Color | undefined): { slope: number; intercept: number; saturation: number } | null {
  const brightness = color?.brightness ?? COLOR_DEFAULTS.brightness;
  const contrast = color?.contrast ?? COLOR_DEFAULTS.contrast;
  const saturation = color?.saturation ?? COLOR_DEFAULTS.saturation;
  if (brightness === 0 && contrast === 1 && saturation === 1) return null;
  return { slope: contrast, intercept: 0.5 - 0.5 * contrast + brightness, saturation };
}
