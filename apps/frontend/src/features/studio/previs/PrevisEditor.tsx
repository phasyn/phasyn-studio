import { useEffect, useId, useRef, useState } from "react";
import type { StudioPrevis, StudioPrevisLayer, StudioPrevisPose, StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { newLocalId } from "../references/ids";
import { useStudio } from "../studioContext";
import { NumberField } from "../components/fields";
import { DEFAULT_SCENE, invalidScene, MAX_KEYS, MAX_LAYERS, sample, writeKey } from "./composition";
import { PrevisCanvas } from "./PrevisCanvas";
import { useLayerImages } from "./useLayerImages";
import { PrevisPainter } from "./spacePainter";
import { SpaceControls } from "./SpaceControls";
import { AnimaticExport } from "./AnimaticExport";
import { PrevisExport } from "./PrevisExport";

function Field({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <label className="grid gap-1 text-caption text-fg-secondary" htmlFor={id}>
        {label}
        <NumberField
          id={id}
          value={Math.round(value * 10) / 10}
          min={min}
          max={max}
          onCommit={(v) => {
            if (v !== null) onChange(v);
          }}
        />
      </label>
    </fieldset>
  );
}

export default function PrevisEditor({ shot }: { shot: StudioShot }) {
  const { project, dispatch } = useStudio();
  const [painter] = useState(() => new PrevisPainter());
  useEffect(() => () => { painter.dispose(); }, [painter]);
  const scene = shot.previs ?? DEFAULT_SCENE;
  const library = project.library ?? [];
  const [target, setTarget] = useState<string>("camera");
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const animationRef = useRef(0);
  useEffect(() => () => { cancelAnimationFrame(animationRef.current); }, []);
  const pause = () => {
    cancelAnimationFrame(animationRef.current);
    setPlaying(false);
  };
  const seekFrame = (value: number) => {
    pause();
    setFrame(value);
  };
  const [itemId, setItemId] = useState("");
  const [depth, setDepth] = useState(false);
  const lastFrame = shot.frames - 1,
    at = Math.min(lastFrame, frame);
  const play = () => {
    if (playing) {
      pause();
      return;
    }
    const start = at === lastFrame ? 0 : at;
    const began = performance.now();
    const fps = project.format.fps.num / project.format.fps.den;
    setPlaying(true);
    const tick = (now: number) => {
      const next = Math.min(lastFrame, start + Math.floor(((now - began) * fps) / 1000));
      setFrame(next);
      if (next < lastFrame) animationRef.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    animationRef.current = requestAnimationFrame(tick);
  };
  const layerIndex = scene.layers.findIndex((layer) => layer.id === target);
  const layer = scene.layers[layerIndex];
  const keys = layer?.keys ?? scene.camera,
    pose = sample(keys, at);
  const isKey = keys.some((k) => k.frame === at),
    canKey = isKey || keys.length < MAX_KEYS;
  const { images, problem, loading } = useLayerImages(scene, library);
  const issue = invalidScene(scene) ?? problem ?? (loading ? t("正在讀取預演素材…") : null);
  const update = (previs: StudioPrevis) => { dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { previs } }); };
  const layerChange = (patch: Partial<StudioPrevisLayer>) => { update({ ...scene, layers: scene.layers.map((l, i) => (i === layerIndex ? { ...l, ...patch } : l)) }); };
  const setKeys = (next: StudioPrevisPose[]) => {
    if (layer) layerChange({ keys: next });
    else update({ ...scene, camera: next });
  };
  const setPose = (next: StudioPrevisPose) => {
    pause();
    if (canKey) setKeys(writeKey(keys, next));
  };
  const libraryImages = library.filter((i) => i.kind === "image");
  const add = (kind: StudioPrevisLayer["kind"]) => {
    if (scene.layers.length >= MAX_LAYERS) return;
    const item = libraryImages.find((i) => i.item_id === itemId);
    if (kind === "image" && !item) return;
    const id = newLocalId("plane"),
      name =
        kind === "image" ? (item?.name ?? "").slice(0, 80) : kind === "puppet" ? t("立體人偶") : kind === "figure" ? t("角色剪影") : t("色塊");
    const next: StudioPrevisLayer = {
      id,
      name,
      kind,
      item_id: kind === "image" ? itemId : null,
      color: kind === "rectangle" ? "#688aa1" : "#f1bd79",
      keys: [{ frame: 0, x: 50, y: 50, scale: kind === "figure" ? 64 : kind === "puppet" ? 76 : 44 }],
    };
    update({ ...scene, projection: kind === "puppet" ? "stage3d" : scene.projection, layers: [...scene.layers, next] });
    setTarget(id);
  };
  const move = (by: number) => {
    const to = layerIndex + by;
    if (!layer || to < 0 || to >= scene.layers.length) return;
    const layers = scene.layers.slice();
    layers.splice(layerIndex, 1);
    layers.splice(to, 0, layer);
    update({ ...scene, layers });
  };
  const remove = () => {
    if (layer) {
      update({ ...scene, layers: scene.layers.filter((l) => l.id !== layer.id) });
      setTarget("camera");
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="grid min-w-0 content-start gap-3 lg:sticky lg:top-0 lg:self-start">
        <PrevisCanvas
          painter={painter}
          scene={scene}
          images={images}
          width={project.format.width}
          height={project.format.height}
          frame={at}
          layerIndex={layerIndex}
          depth={depth}
          problem={issue}
          canKey={canKey}
          onMove={setPose}
        />
        <div className="flex flex-wrap items-end gap-3">
          <Button size="sm" onClick={play}>
            {playing ? t("暫停預演") : t("播放預演")}
          </Button>
          <Field label={t("預演影格")} value={at} min={0} max={lastFrame} onChange={(v) => { seekFrame(Math.round(v)); }} />
          <label className="min-w-32 flex-1 text-caption">
            {t("鏡頭時間（秒）")} · {((at * project.format.fps.den) / project.format.fps.num).toFixed(3)}
            <input
              aria-label={t("預演播放頭")}
              type="range"
              className="block w-full"
              min={0}
              max={lastFrame}
              value={at}
              onChange={(e) => { seekFrame(e.currentTarget.valueAsNumber); }}
            />
          </label>
          <Button size="sm" onClick={() => { seekFrame(0); }}>
            {t("第一格")}
          </Button>
          <Button size="sm" onClick={() => { seekFrame(lastFrame); }}>
            {t("最後一格")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-data">
          <input type="checkbox" checked={depth} onChange={(e) => { setDepth(e.target.checked); }} />
          {scene.projection === "stage3d" ? t("鏡頭深度（0.15–14 公尺，近白遠黑）") : t("分層深度（近白遠黑）")}
        </label>
        <PrevisExport
          painter={painter}
          shot={shot}
          scene={scene}
          images={images}
          frame={at}
          depth={depth}
          blocked={Boolean(issue) || !scene.layers.length}
        />
        <AnimaticExport key={shot.shot_id} shot={shot} scene={scene} painter={painter} depth={depth} images={images}
          blocked={Boolean(issue) || !scene.layers.length} />
      </div>
      <div className="grid content-start gap-3">
        <label className="grid gap-1 text-caption">
          {t("預演投影")}
          <Select
            compact
            value={scene.projection}
            onChange={(e) => { update({
                ...scene,
                projection: e.target.value === "stage3d" ? "stage3d" : e.target.value === "perspective" ? "perspective" : "orthographic",
              }); }
            }
          >
            <option value="orthographic">{t("平面構圖")}</option>
            <option value="perspective">{t("透視與視差")}</option>
            <option value="stage3d">{t("立體攝影棚")}</option>
          </Select>
        </label>
        <label className="flex items-center justify-between text-caption">
          {t("預演背景色")}
          <input type="color" value={scene.background} onChange={(e) => { update({ ...scene, background: e.target.value }); }} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={scene.layers.length >= MAX_LAYERS} onClick={() => { add("figure"); }}>
            {t("加入角色剪影")}
          </Button>
          <Button size="sm" disabled={scene.layers.length >= MAX_LAYERS} onClick={() => { add("puppet"); }}>
            {t("加入立體人偶")}
          </Button>
          <Button size="sm" disabled={scene.layers.length >= MAX_LAYERS} onClick={() => { add("rectangle"); }}>
            {t("加入色塊")}
          </Button>
        </div>
        <label className="grid gap-1 text-caption">
          {t("素材圖層來源")}
          <Select compact value={itemId} onChange={(e) => { setItemId(e.target.value); }}>
            <option value="">{t("選擇素材庫圖片")}</option>
            {libraryImages.map((i) => (
              <option key={i.item_id} value={i.item_id}>
                {i.name}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" disabled={!itemId || scene.layers.length >= MAX_LAYERS} onClick={() => { add("image"); }}>
          {t("加入圖片圖層")}
        </Button>
        <label className="grid gap-1 text-caption">
          {t("編輯相機或圖層（由後至前）")}
          <Select compact value={layer?.id ?? "camera"} onChange={(e) => { setTarget(e.target.value); }}>
            <option value="camera">{t("預演相機")}</option>
            {scene.layers.map((l, i) => (
              <option key={l.id} value={l.id}>
                {i + 1} · {l.name}
              </option>
            ))}
          </Select>
        </label>
        {layer ? (
          <>
            <label className="grid gap-1 text-caption">
              {t("預演圖層名稱")}
              <Input
                compact
                value={layer.name}
                maxLength={80}
                onChange={(e) => {
                  if (e.target.value) layerChange({ name: e.target.value });
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={layerIndex === 0} onClick={() => { move(-1); }}>
                {t("移後一層")}
              </Button>
              <Button size="sm" disabled={layerIndex === scene.layers.length - 1} onClick={() => { move(1); }}>
                {t("移前一層")}
              </Button>
              <Button size="sm" onClick={remove}>
                {t("移除圖層")}
              </Button>
            </div>
            {layer.kind !== "image" ? (
              <label className="flex items-center justify-between text-caption">
                {t("圖層顏色")}
                <input type="color" value={layer.color} onChange={(e) => { layerChange({ color: e.target.value }); }} />
              </label>
            ) : null}
          </>
        ) : null}
        {scene.projection === "stage3d" ? (
          <SpaceControls
            scene={scene}
            index={layerIndex}
            frame={at}
            last={lastFrame}
            seek={seekFrame}
            change={update}
            layerChange={layerChange}
          />
        ) : null}
        {scene.projection !== "stage3d" || layer ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Field
                label={t("水平位置 %")}
                value={pose.x}
                min={-100}
                max={200}
                disabled={!canKey}
                onChange={(v) => { setPose({ ...pose, x: v }); }}
              />
              <Field
                label={t("垂直位置 %")}
                value={pose.y}
                min={-100}
                max={200}
                disabled={!canKey}
                onChange={(v) => { setPose({ ...pose, y: v }); }}
              />
              <Field
                label={layer ? t("畫高占比 %") : t("相機倍率 %")}
                value={pose.scale}
                min={1}
                max={400}
                disabled={!canKey}
                onChange={(v) => { setPose({ ...pose, scale: v }); }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={isKey || !canKey} onClick={() => { setPose(pose); }}>
                {t("新增當前關鍵格")}
              </Button>
              <Button size="sm" disabled={!isKey || keys.length === 1} onClick={() => { setKeys(keys.filter((k) => k.frame !== at)); }}>
                {t("移除當前關鍵格")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1" aria-label={t("時間關鍵格")}>
              {keys.map((k) => (
                <Button key={k.frame} size="sm" aria-pressed={at === k.frame} disabled={k.frame > lastFrame} onClick={() => { seekFrame(k.frame); }}>
                  {t("第 {frame} 格", { frame: k.frame })}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
