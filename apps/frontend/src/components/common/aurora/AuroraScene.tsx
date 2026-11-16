// Ambient aurora for brand-moment screens (page-level loading, page-level empty states, the Video Studio start screens,
// the not-found and full-page route-error pages): a full-screen shader plane with three slow ribbons in the four brand
// stops over the deep-space ground, and a drift of stardust in front of it. Decorative only: the parent marks it
// aria-hidden and passes no pointer input. One React Three Fiber loop owns everything; the parent pauses it (frameloop
// "never") while the page is hidden or the canvas is offscreen, and swaps in the static CSS backdrop when the WebGL
// context is lost. Colors are read from the index.css tokens. Loaded lazily (AuroraBackdrop), so screens without it
// never load three.js.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";

export type AuroraTier = "high" | "low";

/** Quality tiers: both animate; low draws fewer stars at DPR 1 with a cheaper noise. */
const TIERS = {
  high: { dpr: [1, 1.75] as [number, number], stars: 1400, octaves: 5 },
  low: { dpr: [1, 1] as [number, number], stars: 420, octaves: 3 },
} as const;

/** The index.css values, used only where computed styles are unavailable. */
const FALLBACK_STOPS = ["#49cfff", "#3e89ff", "#727dff", "#ab7bff"];
const FALLBACK_GROUND = "#070b14";
const STOP_TOKENS = ["--color-brand-cyan", "--color-brand-blue", "--color-brand-iris", "--color-brand-violet"];

function tokenColor(style: CSSStyleDeclaration | null, name: string, fallback: string): THREE.Color {
  const value = style?.getPropertyValue(name).trim();
  return new THREE.Color(value || fallback);
}

/** A small seeded generator, so every mount draws the same sky. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BRAND_GLSL = /* glsl */ `
uniform vec3 uStops[4];
vec3 brand(float x) {
  x = clamp(x, 0.0, 1.0) * 3.0;
  vec3 c = mix(uStops[0], uStops[1], clamp(x, 0.0, 1.0));
  c = mix(c, uStops[2], clamp(x - 1.0, 0.0, 1.0));
  return mix(c, uStops[3], clamp(x - 2.0, 0.0, 1.0));
}
`;

const SKY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uGround;
varying vec2 vUv;
${BRAND_GLSL}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < OCTAVES; i++) {
    value += amplitude * noise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float x = uv.x * aspect;
  float t = uTime * 0.035;
  vec3 color = uGround;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float center = 0.66 - fi * 0.12 + 0.06 * sin(x * (1.1 + fi * 0.35) + t * (2.0 + fi)) + 0.12 * (fbm(vec2(x * 0.8 + t * (1.2 + 0.4 * fi), fi * 3.1 + t)) - 0.5);
    float width = 0.05 + 0.04 * fbm(vec2(x * 1.7 - t, fi + 7.0));
    float band = exp(-pow((uv.y - center) / width, 2.0));
    float curtain = 0.45 + 0.55 * fbm(vec2(x * 7.0 + t * 3.0, uv.y * 1.5 + fi * 4.0));
    // a smooth back-and-forth along the four stops (fract() would wrap violet straight back to cyan: a hard edge)
    float hue = 0.5 + 0.5 * sin(uv.x * 3.4 + fi * 1.8 + t * 2.2);
    color += brand(hue) * band * curtain * (0.22 - fi * 0.05);
  }
  float glow = smoothstep(1.1, 0.0, length((uv - vec2(0.5, 0.95)) * vec2(aspect * 0.7, 1.4)));
  color += brand(0.35) * glow * 0.05;
  float vignette = smoothstep(1.3, 0.3, length((uv - 0.5) * vec2(aspect * 0.85, 1.15)));
  color = mix(uGround, color, 0.3 + 0.7 * vignette);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

const STAR_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
attribute float aSeed;
varying float vAlpha;
varying float vHue;
void main() {
  vec3 p = position;
  p.x = mod(p.x + uTime * (0.03 + 0.05 * aSeed) + 8.0, 16.0) - 8.0;
  p.y += sin(uTime * 0.18 + aSeed * 6.2831) * 0.08;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPixelRatio * (1.4 + 2.6 * aSeed * aSeed) * (5.0 / max(-mv.z, 0.5));
  vAlpha = 0.25 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.5 + aSeed) + aSeed * 40.0));
  vHue = fract(aSeed * 1.7);
}
`;

const STAR_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying float vHue;
${BRAND_GLSL}
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  gl_FragColor = vec4(mix(vec3(1.0), brand(vHue), 0.55), a);
  #include <colorspace_fragment>
}
`;

/**
 * The scene's uniforms (shared by the sky and the stardust), owned by one instance per canvas. Only its methods change
 * them: advance() moves time by a clamped delta (a resumed loop never jumps) and resize() follows the canvas.
 */
class AuroraUniforms {
  readonly values: Record<string, THREE.IUniform>;

  constructor() {
    const style = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
    this.values = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uGround: { value: tokenColor(style, "--color-canvas", FALLBACK_GROUND) },
      uStops: { value: STOP_TOKENS.map((name, index) => tokenColor(style, name, FALLBACK_STOPS[index] ?? FALLBACK_GROUND)) },
      uPixelRatio: { value: 1 },
    };
  }

  advance(delta: number): number {
    const time = Number(this.values.uTime?.value ?? 0) + Math.min(Math.max(delta, 0), 0.1);
    if (this.values.uTime) this.values.uTime.value = time;
    return time;
  }

  resize(width: number, height: number, dpr: number): void {
    (this.values.uResolution?.value as THREE.Vector2 | undefined)?.set(width * dpr, height * dpr);
    if (this.values.uPixelRatio) this.values.uPixelRatio.value = dpr;
  }
}

function Sky({ uniforms, octaves }: { uniforms: AuroraUniforms; octaves: number }) {
  return (
    <mesh frustumCulled={false} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        vertexShader={SKY_VERTEX}
        fragmentShader={SKY_FRAGMENT}
        uniforms={uniforms.values}
        defines={{ OCTAVES: octaves }}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

function Stardust({ uniforms, count }: { uniforms: AuroraUniforms; count: number }) {
  const { positions, seeds } = useMemo(() => {
    const random = mulberry32(0x5f3759df);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = random() * 16 - 8;
      positions[index * 3 + 1] = random() * 9 - 4.5;
      positions[index * 3 + 2] = -6 + random() * 7;
      seeds[index] = random();
    }
    return { positions, seeds };
  }, [count]);
  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
      </bufferGeometry>
      <shaderMaterial
        vertexShader={STAR_VERTEX}
        fragmentShader={STAR_FRAGMENT}
        uniforms={uniforms.values}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** The single per-frame owner: advances time (clamped, so a resumed loop never jumps) and sways the camera slowly. */
function Clock({ uniforms }: { uniforms: AuroraUniforms }) {
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  useEffect(() => {
    uniforms.resize(size.width, size.height, dpr);
  }, [uniforms, size, dpr]);
  useFrame(({ camera }, delta) => {
    const time = uniforms.advance(delta);
    camera.position.x = Math.sin(time * 0.05) * 0.35;
    camera.position.y = Math.cos(time * 0.04) * 0.15;
    camera.lookAt(0, 0, -2);
  });
  return null;
}

/** A lost WebGL context hands over to the static backdrop (no automatic restore loop). */
function ContextGuard({ onLost }: { onLost: (reason: string) => void }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = () => onLost("WebGL context lost");
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }, [gl, onLost]);
  return null;
}

export interface AuroraSceneProps {
  tier: AuroraTier;
  /** false while the page is hidden or the backdrop is offscreen: the loop stops (no frames, no uploads). */
  active: boolean;
  onLost: (reason: string) => void;
}

export default function AuroraScene({ tier, active, onLost }: AuroraSceneProps) {
  const settings = TIERS[tier];
  const [uniforms] = useState(() => new AuroraUniforms());
  const [ready, setReady] = useState(false);
  return (
    <Canvas
      className="transition-opacity duration-(--duration-spring-smooth) ease-(--ease-enter)"
      style={{ position: "absolute", inset: 0, opacity: ready ? 1 : 0, pointerEvents: "none" }}
      frameloop={active ? "always" : "never"}
      dpr={settings.dpr}
      // Layout size (offsetWidth/Height): a page entering with a scale transform must not shrink the drawing buffer.
      resize={{ offsetSize: true }}
      flat
      gl={{ antialias: false, alpha: true, powerPreference: "low-power" }}
      camera={{ fov: 55, position: [0, 0, 5], near: 0.1, far: 30 }}
      onCreated={() => setReady(true)}
    >
      <Sky uniforms={uniforms} octaves={settings.octaves} />
      <Stardust uniforms={uniforms} count={settings.stars} />
      <Clock uniforms={uniforms} />
      <ContextGuard onLost={onLost} />
    </Canvas>
  );
}
