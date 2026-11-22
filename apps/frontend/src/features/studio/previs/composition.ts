import { PerspectiveCamera, Vector3 } from "three";
import type { StudioPrevis, StudioPrevisLayer, StudioPrevisPose } from "@/api/generated/contracts";
import { t } from "@/i18n";

const INITIAL_POSE: StudioPrevisPose = { frame: 0, x: 50, y: 50, scale: 100 };
export const DEFAULT_SCENE: StudioPrevis = {
  version: 1,
  projection: "orthographic",
  background: "#1e293b",
  layers: [],
  camera: [{ ...INITIAL_POSE }],
};
export const MAX_LAYERS = 12;
export const MAX_KEYS = 24;

/** The timeline holds the first/last pose outside its keys and linearly interpolates between source frames. */
export function sample(keys: StudioPrevisPose[], frame: number): StudioPrevisPose {
  const later = keys.findIndex((key) => key.frame > frame);
  const left = keys[later === -1 ? keys.length - 1 : Math.max(0, later - 1)] ?? INITIAL_POSE;
  const right = later === -1 ? left : (keys[later] ?? left);
  const alpha = right === left ? 0 : (frame - left.frame) / (right.frame - left.frame);
  return {
    frame,
    x: left.x + (right.x - left.x) * alpha,
    y: left.y + (right.y - left.y) * alpha,
    scale: left.scale + (right.scale - left.scale) * alpha,
  };
}

export function writeKey(keys: StudioPrevisPose[], pose: StudioPrevisPose): StudioPrevisPose[] {
  return [...keys.filter((key) => key.frame !== pose.frame), pose].sort((a, b) => a.frame - b.frame);
}

export function invalidScene(scene: StudioPrevis): string | null {
  if (
    new Set(scene.layers.map((layer) => layer.id)).size !== scene.layers.length ||
    scene.layers.some((layer) => (layer.kind === "image") !== (layer.item_id !== null))
  )
    return t("預演圖層的識別或素材設定無效。");
  if (
    [
      scene.camera,
      ...(scene.lens_keys ? [scene.lens_keys] : []),
      ...scene.layers.flatMap((layer) => [layer.keys, ...(layer.rig_keys ? [layer.rig_keys] : [])]),
    ].some((keys) => !keys.length || keys.some((key, i) => key.frame <= (keys[i - 1]?.frame ?? -Infinity)))
  )
    return t("預演關鍵格必須依序排列，同一格只能有一個姿勢。");
  return null;
}

/** Billboards face the camera. Moving the perspective camera produces parallax between the ordered planes. */
function project(scene: StudioPrevis, frame: number, width: number, height: number) {
  const gaze = sample(scene.camera, frame);
  const aspect = width / height;
  const distance = 1 / Math.tan(Math.PI / 8);
  const camera = new PerspectiveCamera(45, aspect, 0.05, 30);
  camera.position.set((gaze.x / 50 - 1) * aspect, 1 - gaze.y / 50, (distance * 100) / gaze.scale);
  camera.far = Math.max(30, camera.position.z + 10);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return (pose: StudioPrevisPose, index: number) => {
    const z = (index - scene.layers.length + 1) * 0.22;
    if (scene.projection === "orthographic") {
      return {
        x: width * (0.5 + ((pose.x - gaze.x) * gaze.scale) / 10000),
        y: height * (0.5 + ((pose.y - gaze.y) * gaze.scale) / 10000),
        h: (height * pose.scale * gaze.scale) / 10000,
      };
    }
    const atRest = (distance - z) / distance;
    const position = new Vector3((pose.x / 50 - 1) * aspect * atRest, (1 - pose.y / 50) * atRest, z);
    const top = position
      .clone()
      .add(new Vector3(0, (pose.scale / 100) * atRest, 0))
      .project(camera);
    position.project(camera);
    return { x: ((position.x + 1) * width) / 2, y: ((1 - position.y) * height) / 2, h: (top.y - position.y) * height };
  };
}

function shape(ctx: CanvasRenderingContext2D, layer: StudioPrevisLayer, x: number, y: number, height: number) {
  if (layer.kind === "rectangle") {
    ctx.fillRect(x - height * 0.68, y - height / 2, height * 1.36, height);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(height, height);
  ctx.beginPath();
  ctx.arc(0, -0.39, 0.105, 0, 2 * Math.PI);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.27);
  for (const [dx, dy] of [
    [0.1, -0.27],
    [0.23, 0.035],
    [0.16, 0.068],
    [0.085, -0.095],
    [0.11, 0.5],
    [0.025, 0.5],
    [0, 0.16],
    [-0.025, 0.5],
    [-0.11, 0.5],
    [-0.085, -0.095],
    [-0.16, 0.068],
    [-0.23, 0.035],
  ] as const)
    ctx.lineTo(dx, dy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function paint(
  canvas: HTMLCanvasElement,
  scene: StudioPrevis,
  frame: number,
  images: ReadonlyMap<string, HTMLImageElement>,
  depth: boolean,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("無法建立預演畫布。"));
  ctx.fillStyle = depth ? "#000000" : scene.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const position = project(scene, frame, canvas.width, canvas.height);
  let mask: HTMLCanvasElement | null = null;
  scene.layers.forEach((layer, index) => {
    const { x, y, h } = position(sample(layer.keys, frame), index);
    const gray = Math.round((255 * (index + 1)) / scene.layers.length);
    ctx.fillStyle = depth ? `rgb(${String(gray)},${String(gray)},${String(gray)})` : layer.color;
    if (layer.kind !== "image") {
      shape(ctx, layer, x, y, h);
      return;
    }
    const image = images.get(layer.item_id ?? "");
    if (!image) throw new Error(t("預演圖層的圖片尚未載入。"));
    const w = (h * image.naturalWidth) / image.naturalHeight;
    if (!depth) {
      ctx.drawImage(image, x - w / 2, y - h / 2, w, h);
      return;
    }
    // Tint just the image's visible alpha; opaque source photos remain full rectangular planes.
    mask ??= document.createElement("canvas");
    mask.width = canvas.width;
    mask.height = canvas.height;
    const m = mask.getContext("2d");
    if (!m) throw new Error(t("無法建立預演畫布。"));
    m.drawImage(image, x - w / 2, y - h / 2, w, h);
    m.globalCompositeOperation = "source-in";
    m.fillStyle = ctx.fillStyle;
    m.fillRect(0, 0, mask.width, mask.height);
    ctx.drawImage(mask, 0, 0);
  });
}

export function movedPose(scene: StudioPrevis, frame: number, index: number, dx: number, dy: number): StudioPrevisPose | null {
  const layer = scene.layers[index];
  if (!layer) return null;
  const pose = sample(layer.keys, frame);
  const position = project(scene, frame, 100, 100);
  const a = position(pose, index);
  const b = position({ ...pose, x: pose.x + 1, y: pose.y + 1 }, index);
  const bound = (v: number) => Math.min(200, Math.max(-100, Math.round(v * 10) / 10));
  return { ...pose, x: bound(pose.x + (dx * 100) / (b.x - a.x)), y: bound(pose.y + (dy * 100) / (b.y - a.y)) };
}
