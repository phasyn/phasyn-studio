import {
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
  type Material,
} from "three";
import type { StudioPrevis } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { paint } from "./composition";
import { PuppetGeometry } from "./puppet";
import { DEPTH_FAR, DEPTH_NEAR, interpolate, lensAt, NEUTRAL, placement } from "./spaceModel";

function silhouette() {
  const s = new Shape();
  s.moveTo(-0.1, 0.27);
  for (const [x, y] of [
    [0.1, 0.27],
    [0.23, -0.035],
    [0.16, -0.068],
    [0.085, 0.095],
    [0.11, -0.5],
    [0.025, -0.5],
    [0, -0.16],
    [-0.025, -0.5],
    [-0.11, -0.5],
    [-0.085, 0.095],
    [-0.16, -0.068],
    [-0.23, -0.035],
  ] as const)
    s.lineTo(x, y);
  s.closePath();
  const head = new Shape();
  head.absarc(0, 0.39, 0.105, 0, 2 * Math.PI, false);
  return new ShapeGeometry([s, head]);
}

function depthMaterial(map: Texture | null) {
  return new ShaderMaterial({
    side: DoubleSide,
    uniforms: { hasMask: { value: Boolean(map) }, alphaMap: { value: map }, nearRange: { value: DEPTH_NEAR }, farRange: { value: DEPTH_FAR } },
    vertexShader: `varying vec2 texCoord; varying float distanceZ; void main() { vec4 pos=modelViewMatrix*vec4(position,1.0); texCoord=uv; distanceZ=-pos.z; gl_Position=projectionMatrix*pos; }`,
    fragmentShader: `uniform bool hasMask; uniform sampler2D alphaMap; uniform float nearRange; uniform float farRange; varying vec2 texCoord; varying float distanceZ; void main(){ if(hasMask && texture2D(alphaMap,texCoord).a < 0.01) discard; float v=1.0-clamp((distanceZ-nearRange)/(farRange-nearRange),0.0,1.0); gl_FragColor=vec4(vec3(v),1.0); }`,
  });
}

class SpaceRenderer {
  readonly gl = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  readonly puppet = new PuppetGeometry();
  readonly plane = new PlaneGeometry();
  readonly figure = silhouette();
  readonly materials = new Map<string, Material>();
  readonly textures = new Map<HTMLImageElement, Texture>();

  texture(image: HTMLImageElement) {
    let tex = this.textures.get(image);
    if (!tex) {
      tex = new Texture(image);
      tex.colorSpace = SRGBColorSpace;
      tex.needsUpdate = true;
      this.textures.set(image, tex);
    }
    return tex;
  }
  render(canvas: HTMLCanvasElement, spec: StudioPrevis, frame: number, images: ReadonlyMap<string, HTMLImageElement>, depth: boolean) {
    const aspect = canvas.width / canvas.height,
      camera = lensAt(spec, frame, aspect);
    const scene = new Scene();
    scene.background = new Color(depth ? "#000000" : spec.background);
    const lamp = new DirectionalLight(0xffffff, 2.15);
    lamp.position.set(-3, 4, 5);
    scene.add(lamp, new HemisphereLight(0xfff5e9, 0x606d83, 1.6));
    const activeMaterials = new Set<string>();
    const usedTextures = new Set<HTMLImageElement>();
    try {
      spec.layers.forEach((layer, index) => {
        const { position, size } = placement(spec, frame, index, aspect);
        const image = (layer.item_id != null && layer.item_id !== "") ? images.get(layer.item_id) : undefined;
        if (layer.kind === "image" && !image) throw new Error(t("預演圖層的圖片尚未載入。"));
        const map = image ? this.texture(image) : null;
        if (image) usedTextures.add(image);
        const key = [depth, layer.kind, layer.color, map?.uuid ?? ""].join("/");
        activeMaterials.add(key);
        let material = this.materials.get(key);
        if (!material) {
          material = depth
            ? depthMaterial(map)
            : layer.kind === "puppet"
              ? new MeshStandardMaterial({ color: layer.color, roughness: 0.76 })
              : new MeshBasicMaterial({ color: map ? "#ffffff" : layer.color, map, side: DoubleSide, alphaTest: 0.01, toneMapped: false });
          this.materials.set(key, material);
        }
        let group: Group;
        if (layer.kind === "puppet") {
          group = this.puppet.pose(interpolate(layer.rig_keys, NEUTRAL, frame), material);
        } else {
          group = new Group();
          const mesh = new Mesh(layer.kind === "figure" ? this.figure : this.plane, material);
          if (layer.kind !== "figure") mesh.scale.x = image ? image.naturalWidth / image.naturalHeight : 1.36;
          group.add(mesh);
        }
        group.position.copy(position);
        group.scale.setScalar(size);
        scene.add(group);
      });
      if (this.gl.domElement.width !== canvas.width || this.gl.domElement.height !== canvas.height)
        this.gl.setSize(canvas.width, canvas.height, false);
      this.gl.render(scene, camera);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(t("無法建立預演畫布。"));
      ctx.drawImage(this.gl.domElement, 0, 0);
    } finally {
      for (const [key, material] of this.materials) {
        if (!activeMaterials.has(key)) {
          material.dispose();
          this.materials.delete(key);
        }
      }
      for (const [image, tex] of this.textures) {
        if (!usedTextures.has(image)) {
          tex.dispose();
          this.textures.delete(image);
        }
      }
    }
  }
  dispose() {
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.puppet.dispose();
    this.plane.dispose();
    this.figure.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
  }
}

/** One WebGL context for this open editor, including full-size exports. Flat scenes continue to use Canvas2D. */
export class PrevisPainter {
  private renderer: SpaceRenderer | null = null;
  draw(canvas: HTMLCanvasElement, scene: StudioPrevis, frame: number, images: ReadonlyMap<string, HTMLImageElement>, depth: boolean) {
    if (scene.projection !== "stage3d") {
      paint(canvas, scene, frame, images, depth);
      return;
    }
    if (!this.renderer) {
      try {
        this.renderer = new SpaceRenderer();
      } catch {
        throw new Error(t("此瀏覽器無法建立 WebGL 2，請切換至平面構圖或啟用圖形加速。"));
      }
    }
    this.renderer.render(canvas, scene, frame, images, depth);
  }
  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
