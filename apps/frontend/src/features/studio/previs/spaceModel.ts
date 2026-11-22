import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";
import type { StudioPrevis, StudioPrevisCamera3D, StudioPrevisLayer, StudioPrevisRig } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { sample } from "./composition";

export const CAMERA: StudioPrevisCamera3D = { frame: 0, x: 0, y: 0, z: 3.8, target_x: 0, target_y: 0, target_z: 0, focal_mm: 40 };
export const NEUTRAL: StudioPrevisRig = {
  frame: 0,
  body_yaw: 0,
  body_pitch: 0,
  head_yaw: 0,
  left_arm_raise: 0,
  left_arm_spread: 10,
  left_elbow: 5,
  right_arm_raise: 0,
  right_arm_spread: 10,
  right_elbow: 5,
  left_hip: 0,
  left_leg_spread: 7,
  left_knee: 3,
  right_hip: 0,
  right_leg_spread: 7,
  right_knee: 3,
};
export const DEPTH_NEAR = 0.15;
export const DEPTH_FAR = 14;

export function interpolate<T extends { frame: number }>(keys: readonly T[] | undefined, fallback: T, frame: number): T {
  if (!keys || keys.length === 0) return { ...fallback, frame };
  const right = keys.findIndex((key) => key.frame >= frame);
  const b = keys[right];
  if (!b) return { ...(keys.at(-1) ?? fallback), frame };
  const a = keys[right - 1];
  if (!a || b.frame === frame) return { ...b, frame };
  const alpha = (frame - a.frame) / (b.frame - a.frame);
  const out = { ...a, frame };
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue;
    const left = a[key], end = b[key];
    if (key !== "frame" && typeof left === "number" && typeof end === "number") Object.assign(out, { [key]: left + (end - left) * alpha });
  }
  return out;
}

/** A linear camera segment can intersect its target between valid endpoint poses. Check its nearest sampled frame. */
export function crossesTarget(keys: readonly StudioPrevisCamera3D[]) {
  const delta = (key: StudioPrevisCamera3D) => new Vector3(key.x - key.target_x, key.y - key.target_y, key.z - key.target_z);
  return keys.some((key, i) => {
    const start = delta(key),
      next = keys[i + 1];
    if (start.lengthSq() < 1e-8) return true;
    if (!next) return false;
    const d = delta(next).sub(start),
      span = next.frame - key.frame;
    if (!d.lengthSq() || span <= 0) return false;
    const n = Math.round(Math.min(1, Math.max(0, -start.dot(d) / d.lengthSq())) * span);
    return start.addScaledVector(d, n / span).lengthSq() < 1e-8;
  });
}

export function lensAt(scene: StudioPrevis, frame: number, aspect: number) {
  const v = interpolate(scene.lens_keys, CAMERA, frame);
  const camera = new PerspectiveCamera(45, aspect, 0.03, 40);
  camera.filmGauge = 35;
  camera.setFocalLength(v.focal_mm);
  camera.position.set(v.x, v.y, v.z);
  const target = new Vector3(v.target_x, v.target_y, v.target_z);
  if (camera.position.distanceToSquared(target) < 1e-8) throw new Error(t("攝影機位置與瞄準點重合，請調整其中一項。"));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}
export function zOf(layer: StudioPrevisLayer, index: number, count: number) {
  return layer.z_m ?? (index - count + 1) * 0.35;
}
export function placement(scene: StudioPrevis, frame: number, index: number, aspect: number) {
  const layer = scene.layers[index];
  if (!layer) throw new RangeError(t("預演圖層的識別或素材設定無效。"));
  const p = sample(layer.keys, frame);
  return { p, position: new Vector3((p.x / 50 - 1) * aspect, 1 - p.y / 50, zOf(layer, index, scene.layers.length)), size: (2 * p.scale) / 100 };
}

/** Unproject a screen-space drag onto the layer's fixed world-Z plane. */
export function drag3D(scene: StudioPrevis, frame: number, index: number, aspect: number, dx: number, dy: number) {
  const camera = lensAt(scene, frame, aspect),
    { p, position } = placement(scene, frame, index, aspect);
  const ndc = position.clone().project(camera),
    ray = new Raycaster();
  ray.setFromCamera(new Vector2(ndc.x + 2 * dx, ndc.y - 2 * dy), camera);
  const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -position.z), new Vector3());
  if (!hit) return null;
  const bound = (v: number) => Math.min(200, Math.max(-100, Math.round(v * 10) / 10));
  return { ...p, x: bound((hit.x / aspect + 1) * 50), y: bound((1 - hit.y) * 50) };
}
