import { Camera, CanvasTexture, HalfFloatType, LinearFilter, Mesh, NoBlending, PlaneGeometry, Scene, ShaderMaterial, Texture, UnsignedByteType, Vector2, Vector3, Vector4, VideoTexture, WebGLRenderer, WebGLRenderTarget, type TextureDataType } from "three";
import { t } from "@/i18n";
import type { TimelineClip } from "@/api/generated/contracts";
import { titleKey } from "../model/clipEffects";
import { cameraView, colorFilterParams, videoFadeFactor } from "./previewMath";

// Realm-independent kind checks: the Program monitor can render in its own window, where its <video> and
// <canvas> elements belong to that window, so `instanceof` against this window's classes would be false.
function isVideo(media: TexImageSource): media is HTMLVideoElement {
  return "nodeName" in media && media.nodeName === "VIDEO";
}
function isCanvas(media: TexImageSource): media is HTMLCanvasElement {
  return "nodeName" in media && media.nodeName === "CANVAS";
}
import { canvasMeasure, drawTitle, layoutTitle } from "../model/titleLayout";
import { processedDuration } from "./model";
import { effectAt, maskAt } from "./animation";

/** The look effects as the export compiles them (phasyn_media.composition_effects): streak sigma per length, unsharp radius and grain amplitude. */
const STREAK_SIGMA = 0.25;
const SHARPEN_SIGMA = 1;
const GRAIN_AMPLITUDE = 0.25;
const GLOW_THRESHOLD_MAX = 0.999;

const vertexShader = `varying vec2 sampleUv;
void main() { sampleUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// Work in encoded RGB, matching the media filters. Intermediate targets carry straight alpha, except the glow's
// bright pass and its blur (premultiplied, in half-float targets so a strong glow does not band).
const fragmentShader = `
precision highp float;
varying vec2 sampleUv;
uniform sampler2D sourceImage;
uniform sampler2D secondImage;
uniform sampler2D titleImage;
uniform int operation;
uniform vec4 params;
uniform vec4 bounds;
uniform vec2 resolution;
uniform vec2 direction;
uniform vec3 keyColor;
uniform vec3 cameraTransform;
uniform vec2 contentSize;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec4 pixel(vec2 at) { return texture2D(sourceImage, clamp(at, vec2(0.0), vec2(1.0))); }
vec4 premultiplied(vec4 color) { return vec4(color.rgb * color.a, color.a); }
vec4 straight(vec4 color) { return vec4(color.a > 0.00001 ? min(color.rgb / color.a, vec3(1.0)) : vec3(0.0), color.a); }
// Hoskins' hash13, as the export's grain (phasyn_media.composition_effects.grain_luma)
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 color = pixel(sampleUv);
  if (operation == 0) {
    vec2 at = (sampleUv - vec2(0.5) - cameraTransform.xy) / cameraTransform.z + vec2(0.5);
    at = (at - vec2(0.5)) / contentSize + vec2(0.5);
    color = any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0))) ? vec4(0.0) : pixel(at);
  } else if (operation == 1) {
    vec3 rgb = color.rgb * params.y + vec3(params.x);
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = clamp(mix(vec3(luma), rgb, params.z), 0.0, 1.0);
  } else if (operation == 2) {
    // Gaussian of sigma params.x pixels along direction, 33 taps over three sigma; params.y = 1: the input is
    // premultiplied already (summed as it is), else it is premultiplied here and straightened again.
    vec4 sum = vec4(0.0); float weights = 0.0;
    for (int i = -16; i <= 16; i++) {
      float offset = float(i) * params.x * 0.1875;
      // Squared as a product: GLSL leaves pow undefined for a negative base (the taps before the centre)
      float sigmas = float(i) * 0.1875;
      float weight = exp(-0.5 * sigmas * sigmas);
      vec4 sampleColor = pixel(sampleUv + direction * offset / resolution);
      sum += (params.y > 0.5 ? sampleColor : premultiplied(sampleColor)) * weight; weights += weight;
    }
    color = sum / weights;
    if (params.y < 0.5) color.rgb = color.a > 0.00001 ? color.rgb / color.a : vec3(0.0);
  } else if (operation == 3) {
    float distance = length(color.rgb - keyColor) / sqrt(3.0);
    color.a *= params.y > 0.0 ? clamp((distance - params.x) / params.y, 0.0, 1.0) : step(params.x, distance);
  } else if (operation == 4) {
    vec2 point = vec2(sampleUv.x, 1.0 - sampleUv.y) * resolution;
    vec2 lower = bounds.xy * resolution; vec2 size = bounds.zw * resolution;
    vec2 inside = min(point - lower, lower + size - point);
    float distance = min(inside.x, inside.y);
    if (params.z > 0.5) distance = (1.0 - length((point - lower - size * 0.5) / (size * 0.5))) * min(size.x, size.y) * 0.5;
    float feather = params.x * min(resolution.x, resolution.y);
    float coverage = feather > 0.0 ? smoothstep(0.0, feather, distance) : step(0.0, distance);
    color.a *= params.y > 0.5 ? 1.0 - coverage : coverage;
  } else if (operation == 5) {
    vec4 title = texture2D(titleImage, sampleUv);
    float alpha = title.a + color.a * (1.0 - title.a);
    color = vec4((title.rgb * title.a + color.rgb * color.a * (1.0 - title.a)) / max(alpha, 0.00001), alpha);
  } else if (operation == 6) {
    color.rgb = vec3(1.0) - color.rgb;
    if (params.x > 0.5) { float gray = dot(color.rgb, LUMA); color.rgb = clamp(vec3((gray - 0.5) * 1.8 + 0.5), 0.0, 1.0); }
  } else if (operation == 7) color.rgb = vec3(params.x);
  // Fade: the colour towards black, or (params.y = 1, an adjustment layer) the coverage, so the adjustment eases in and out
  else if (operation == 8) { if (params.y > 0.5) color.a *= params.x; else color.rgb *= params.x; }
  else if (operation == 9) {
    // Glow bright pass (premultiplied out): weight = clip((luma - threshold) / (1 - threshold), 0, 1)
    vec4 lit = premultiplied(color);
    color = lit * clamp((dot(lit.rgb, LUMA) - params.x) / max(1.0 - params.x, 0.001), 0.0, 1.0);
  } else if (operation == 10) {
    // Glow: the blurred bright pass times the intensity added to the colour, its coverage screening the alpha
    vec4 glow = min(texture2D(secondImage, sampleUv) * params.x, vec4(1.0));
    vec4 lit = premultiplied(color);
    color = straight(vec4(min(lit.rgb + glow.rgb, vec3(1.0)), 1.0 - (1.0 - lit.a) * (1.0 - glow.a)));
  } else if (operation == 11) {
    // RGB split: red from params.xy back along its offset, blue from the opposite side (texture coordinates)
    color.r = pixel(sampleUv - params.xy).r;
    color.b = pixel(sampleUv + params.xy).b;
  } else if (operation == 12) {
    // Vignette: amount params.x, a smooth step from 0.95 (1 - softness) of the way to the corners
    float inner = 0.95 * (1.0 - params.y);
    float reach = clamp((length(sampleUv * 2.0 - 1.0) / sqrt(2.0) - inner) / max(1.0 - inner, 0.0001), 0.0, 1.0);
    color.rgb *= 1.0 - params.x * reach * reach * (3.0 - 2.0 * reach);
  } else if (operation == 13) {
    // Grain: triangular monochrome noise of amplitude params.x, a function of the pixel and the frame params.y
    vec2 at = floor(sampleUv * resolution);
    float noise = hash13(vec3(at, params.y)) + hash13(vec3(at + vec2(37.0, 91.0), params.y)) - 1.0;
    color.rgb = clamp(color.rgb + params.x * noise, 0.0, 1.0);
  } else if (operation == 14) {
    // Unsharp mask: colour + amount x (colour - blurred colour), premultiplied, alpha unchanged
    vec4 soft = premultiplied(texture2D(secondImage, sampleUv));
    vec4 lit = premultiplied(color);
    color = straight(vec4(clamp(lit.rgb + params.x * (lit.rgb - soft.rgb), 0.0, 1.0), lit.a));
  }
  gl_FragColor = color;
}`;

export interface ClipRenderFrame {
  clip: TimelineClip;
  localFrame: number;
  fit: "contain" | "cover";
  /** A whip transition's blur of this picture: Gaussian sigma in sequence pixels along x and y. */
  transitionBlur?: { x: number; y: number } | null;
}
export interface ClipRenderer { draw: (frame: ClipRenderFrame) => void; dispose: () => void; }

/**
 * What a renderer draws from: decoded media (a video or an image), a text layer's title (painted into the canvas it is
 * given) or an adjustment layer's composite of the tracks below it (painted into its canvas by the layer's owner).
 */
export type ClipPicture = "media" | "text" | "composite";

/** The bounded size the preview renders a sequence of `width` × `height` at (at most 960 × 540). */
export function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 960 / width, 540 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Owns exactly one canvas, two bounded scratch targets and, once a glow or a sharpen needs them, two more (half float
 * where the GPU renders to it); React owns time and media playback. `readable` keeps the last picture in the canvas
 * after it is shown, so an adjustment layer above can read it.
 */
export function createClipRenderer(
  canvas: HTMLCanvasElement,
  media: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
  { picture, readable }: { picture: ClipPicture; readable: boolean },
): ClipRenderer {
  const scale = Math.min(1, 960 / width, 540 / height);
  const { width: renderWidth, height: renderHeight } = previewSize(width, height);
  const renderer = new WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: readable, powerPreference: "low-power" });
  renderer.setPixelRatio(1); renderer.setSize(renderWidth, renderHeight, false);
  renderer.setClearColor(0x000000, 0);
  const textSource = picture === "text";
  if (isCanvas(media)) { media.width = renderWidth; media.height = renderHeight; }
  const image: Texture = isVideo(media) ? new VideoTexture(media) : isCanvas(media) ? new CanvasTexture(media) : new Texture(media); image.generateMipmaps = false; image.minFilter = LinearFilter; image.magFilter = LinearFilter;
  const titleCanvas = document.createElement("canvas"); titleCanvas.width = renderWidth; titleCanvas.height = renderHeight;
  const titleTexture = new CanvasTexture(titleCanvas); titleTexture.generateMipmaps = false; titleTexture.minFilter = LinearFilter;
  const uniforms = {
    sourceImage: { value: image }, secondImage: { value: image }, titleImage: { value: titleTexture }, operation: { value: 0 },
    params: { value: new Vector4() }, bounds: { value: new Vector4() }, resolution: { value: new Vector2(renderWidth, renderHeight) },
    direction: { value: new Vector2() }, keyColor: { value: new Vector3() }, cameraTransform: { value: new Vector3(0, 0, 1) }, contentSize: { value: new Vector2(1, 1) },
  };
  const material = new ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false, blending: NoBlending });
  const geometry = new PlaneGeometry(2, 2); const scene = new Scene(); scene.add(new Mesh(geometry, material)); const camera = new Camera();
  const target = (type: TextureDataType) => new WebGLRenderTarget(renderWidth, renderHeight, { depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, type });
  const targets = [target(UnsignedByteType), target(UnsignedByteType)] as const;
  // A glow is the bright pass blurred and then amplified: 8-bit targets would band, so it uses half float where the GPU can render to it
  const floatType = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float") ? HalfFloatType : UnsignedByteType;
  let extra: readonly [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  const scratch = () => (extra ??= [target(floatType), target(floatType)]);
  let disposed = false; let titleIdentity = ""; let sourceTitleIdentity = "";
  const paintText = (target: HTMLCanvasElement, title: NonNullable<TimelineClip["effects"]>["title"]) => {
    const context = target.getContext("2d");
    if (!context) throw new Error(t("瀏覽器無法建立 2D 畫布，不能產生文字圖層"));
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, renderWidth, renderHeight);
    if (!title) return;
    // Layout is computed at export geometry, then scaled as a whole for the bounded preview.
    const layout = layoutTitle(title, width, height, canvasMeasure(context));
    context.setTransform(renderWidth / width, 0, 0, renderHeight / height, 0, 0); drawTitle(context, layout);
    context.setTransform(1, 0, 0, 1, 0, 0);
  };
  const draw = ({ clip, localFrame, fit, transitionBlur }: ClipRenderFrame) => {
    if (disposed || renderer.getContext().isContextLost()) return;
    const mediaWidth = isVideo(media) ? media.videoWidth : isCanvas(media) ? width : media.naturalWidth;
    const mediaHeight = isVideo(media) ? media.videoHeight : isCanvas(media) ? height : media.naturalHeight;
    if (textSource && isCanvas(media)) {
      const title = clip.effects?.title;
      const identity = title ? `${titleKey(title, width, height)}:${document.fonts.status}` : "empty";
      if (identity !== sourceTitleIdentity) { paintText(media, title); sourceTitleIdentity = identity; }
    }
    if (!mediaWidth || !mediaHeight || (isVideo(media) && media.readyState < 2)) return;
    image.needsUpdate = true;
    // The picture so far, and the main target the next pass writes (the other one holds the picture)
    let source: Texture = image;
    let next: 0 | 1 = 0;
    const pass = (operation: number, input: Texture, output: WebGLRenderTarget | null, second: Texture = input) => {
      uniforms.operation.value = operation; uniforms.sourceImage.value = input; uniforms.secondImage.value = second;
      renderer.setRenderTarget(output); renderer.render(scene, camera);
    };
    const render = (operation: number, final = false, second?: Texture) => {
      const output = final ? null : targets[next];
      pass(operation, source, output, second);
      if (output) { source = output.texture; next = next === 0 ? 1 : 0; }
    };
    /** Two Gaussian passes of `sigma` preview pixels from `input` into the scratch pair; returns the result. */
    const gaussian = (input: Texture, sigma: number, premultipliedInput: boolean): Texture => {
      const [first, second] = scratch();
      uniforms.params.value.set(sigma, premultipliedInput ? 1 : 0, 0, 0);
      uniforms.direction.value.set(1, 0); pass(2, input, second);
      uniforms.direction.value.set(0, 1); pass(2, second.texture, first);
      return first.texture;
    };
    const along = (sigma: number, x: number, y: number) => {
      uniforms.params.value.set(sigma, 0, 0, 0); uniforms.direction.value.set(x, y); render(2);
    };
    const aspect = (mediaWidth / mediaHeight) / (width / height);
    uniforms.contentSize.value.set(fit === "cover" ? Math.max(1, aspect) : Math.min(1, aspect), fit === "cover" ? Math.max(1, 1 / aspect) : Math.min(1, 1 / aspect));
    const fx = clip.effects; const length = processedDuration(clip);
    const cameraViewAt = cameraView(fx, localFrame, width, height);
    uniforms.cameraTransform.value.set((cameraViewAt?.xPercent ?? 0) / 100, -(cameraViewAt?.yPercent ?? 0) / 100, cameraViewAt?.scale ?? 1);
    render(0);
    const color = colorFilterParams(fx?.color);
    if (fx?.color?.invert === true) { uniforms.params.value.set(0, 0, 0, 0); render(6); }
    if (color) { uniforms.params.value.set(color.intercept, color.slope, color.saturation, 0); render(1); }
    if (fx?.impact && localFrame < fx.impact.frames) {
      uniforms.params.value.set(fx.impact.style === "black" ? 0 : 1, 0, 0, 0);
      render(fx.impact.style === "negative" ? 6 : 7);
    }
    const title = fx?.title;
    if (!textSource && title && localFrame >= title.start_frame && localFrame < (title.end_frame ?? length)) {
      const identity = `${titleKey(title, width, height)}:${document.fonts.status}`;
      if (identity !== titleIdentity) {
        paintText(titleCanvas, title); titleTexture.needsUpdate = true; titleIdentity = identity;
      }
      render(5);
    }
    for (const original of clip.effect_stack ?? []) {
      const effect = effectAt(original, localFrame);
      if (!effect.enabled) continue;
      if (effect.kind === "color") { uniforms.params.value.set(effect.brightness + (1 - effect.contrast) / 2, effect.contrast, effect.saturation, 0); render(1); }
      else if (effect.kind === "blur" && effect.radius > 0) {
        along(effect.radius * scale, 1, 0); along(effect.radius * scale, 0, 1);
      } else if (effect.kind === "chroma_key") {
        const value = Number.parseInt(effect.color.slice(1), 16);
        uniforms.keyColor.value.set(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
        uniforms.params.value.set(effect.similarity, effect.blend, 0, 0); render(3);
      } else if (effect.kind === "glow" && effect.intensity > 0) {
        const [bright] = scratch();
        uniforms.params.value.set(Math.min(effect.threshold, GLOW_THRESHOLD_MAX), 0, 0, 0); pass(9, source, bright);
        const glow = effect.radius > 0 ? gaussian(bright.texture, effect.radius * scale, true) : bright.texture;
        uniforms.params.value.set(effect.intensity, 0, 0, 0); render(10, false, glow);
      } else if (effect.kind === "rgb_split" && effect.offset > 0) {
        // Sequence pixels to texture coordinates (y grows down in the picture, up in the texture)
        const angle = (effect.angle * Math.PI) / 180;
        uniforms.params.value.set((effect.offset * Math.cos(angle)) / width, -(effect.offset * Math.sin(angle)) / height, 0, 0); render(11);
      } else if (effect.kind === "vignette" && effect.amount > 0) { uniforms.params.value.set(effect.amount, effect.softness, 0, 0); render(12); }
      else if (effect.kind === "grain" && effect.amount > 0) { uniforms.params.value.set(effect.amount * GRAIN_AMPLITUDE, localFrame, 0, 0); render(13); }
      else if (effect.kind === "directional_blur" && effect.length > 0) {
        const angle = (effect.angle * Math.PI) / 180;
        along(effect.length * STREAK_SIGMA * scale, Math.cos(angle), -Math.sin(angle));
      } else if (effect.kind === "sharpen" && effect.amount > 0) {
        // The radius is a sequence pixel: at a reduced preview it is kept at half a preview pixel at least
        const soft = gaussian(source, Math.max(0.5, SHARPEN_SIGMA * scale), false);
        uniforms.params.value.set(effect.amount, 0, 0, 0); render(14, false, soft);
      }
    }
    if (clip.mask) {
      const mask = maskAt(clip.mask, localFrame); uniforms.bounds.value.set(mask.x, mask.y, mask.width, mask.height);
      uniforms.params.value.set(mask.feather, mask.invert ? 1 : 0, mask.kind === "ellipse" ? 1 : 0, 0); render(4);
    }
    if (transitionBlur && transitionBlur.x > 0) along(transitionBlur.x * scale, 1, 0);
    if (transitionBlur && transitionBlur.y > 0) along(transitionBlur.y * scale, 0, 1);
    uniforms.params.value.set(videoFadeFactor(fx, length, localFrame), picture === "composite" ? 1 : 0, 0, 0); render(8, true);
  };
  return { draw, dispose: () => { if (disposed) return; disposed = true; image.dispose(); titleTexture.dispose(); for (const item of [...targets, ...(extra ?? [])]) item.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); if (!canvas.isConnected) renderer.forceContextLoss(); } };
}
