/* eslint-disable */
/**
 * Numeric bounds of the timeline document. Generated from contracts/component.schema.json by
 * tools/contracts/timeline_limits.py; do not edit.
 * Regenerate: python3 -I tools/contracts/timeline_limits.py
 */
export const MAX_SEQUENCE_FRAMES = 100000;
export const MAX_SEQUENCE_SECONDS = 3600;
export const MIN_FPS = 1;
export const MAX_FPS = 240;
export const MAX_SOURCE_FRAMES = 20736000;
export const MAX_SOURCE_SECONDS = 86400;
export const MAX_SOURCE_SIDE = 16384;
export const MAX_TRACKS = 16;
export const MAX_CLIPS = 1000;
export const MAX_SOURCES = 500;
export const MAX_CAPTIONS = 500;
export const MAX_MARKERS = 500;
export const MAX_PLACED_SHOTS = 500;
export const MAX_MIGRATION_NOTES = 64;
export const MAX_MIGRATION_NOTE_CHARS = 400;
export const MAX_KEYFRAMES = 128;
export const MAX_EFFECTS = 8;
export const MAX_NAME_CHARS = 200;
export const MAX_TEXT_CHARS = 200;
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 12;
export const MIN_SPEED_PERCENT = 50;
export const MAX_SPEED_PERCENT = 1000;
export const MIN_VOLUME_DB = -60;
export const MAX_VOLUME_DB = 12;
export const MAX_HOLD_FRAMES = 240;
export const MAX_FADE_FRAMES = 1000;
export const MAX_FRAME_STEP = 4;
export const MAX_IMPACT_FRAMES = 12;
export const MAX_TRANSITION_FRAMES = 240;
export const MAX_COMMANDS = 64;
export const MAX_SRT_CHARS = 1000000;
export const MOTION_BOUNDS = {
  x: [-2, 2],
  y: [-2, 2],
  scale: [0.05, 4],
  rotation: [-360, 360],
  opacity: [0, 1],
  gain_db: [-60, 12],
  pan: [-1, 1],
} as const;
export const EFFECT_BOUNDS = {
  color: {
    brightness: [-1, 1],
    contrast: [0, 4],
    saturation: [0, 4],
  },
  blur: {
    radius: [0, 64],
  },
  chroma_key: {
    similarity: [0.01, 1],
    blend: [0, 1],
  },
  glow: {
    intensity: [0, 4],
    radius: [0, 64],
    threshold: [0, 1],
  },
  rgb_split: {
    offset: [0, 64],
    angle: [-180, 180],
  },
  vignette: {
    amount: [0, 1],
    softness: [0, 1],
  },
  grain: {
    amount: [0, 1],
  },
  directional_blur: {
    length: [0, 128],
    angle: [-180, 180],
  },
  sharpen: {
    amount: [0, 3],
  },
} as const;
export const MASK_BOUNDS = {
  x: [0, 1],
  y: [0, 1],
  width: [0.01, 1],
  height: [0.01, 1],
  feather: [0, 0.5],
} as const;
