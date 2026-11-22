import { useId, useState } from "react";
import type { StudioPrevis, StudioPrevisCamera3D, StudioPrevisLayer, StudioPrevisRig } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { t } from "@/i18n";
import { NumberField } from "../components/fields";
import { MAX_KEYS } from "./composition";
import { CAMERA, crossesTarget, interpolate, NEUTRAL, zOf } from "./spaceModel";

type RigAxis = Exclude<keyof StudioPrevisRig, "frame">;
interface Axis<K> {
  key: K;
  label: string;
  min: number;
  max: number;
}
function cameraAxes(): Axis<Exclude<keyof StudioPrevisCamera3D, "frame">>[] {
  return [
    { key: "x", label: t("機位 X（公尺）"), min: -8, max: 8 },
    { key: "y", label: t("機位 Y（公尺）"), min: -8, max: 8 },
    { key: "z", label: t("機位 Z（公尺）"), min: -8, max: 8 },
    { key: "target_x", label: t("瞄準 X（公尺）"), min: -8, max: 8 },
    { key: "target_y", label: t("瞄準 Y（公尺）"), min: -8, max: 8 },
    { key: "target_z", label: t("瞄準 Z（公尺）"), min: -8, max: 8 },
    { key: "focal_mm", label: t("焦距（毫米）"), min: 12, max: 120 },
  ];
}
type Part = "body" | "la" | "ra" | "ll" | "rl";
function rigAxes(part: Part): Axis<RigAxis>[] {
  if (part === "body")
    return [
      { key: "body_yaw", label: t("身體轉向（度）"), min: -180, max: 180 },
      { key: "body_pitch", label: t("軀幹前傾（度）"), min: -60, max: 60 },
      { key: "head_yaw", label: t("頭部轉向（度）"), min: -90, max: 90 },
    ];
  const side = part === "la" || part === "ll" ? "left" : "right";
  return part === "la" || part === "ra"
    ? [
        { key: `${side}_arm_raise`, label: t("手臂前舉（度）"), min: -110, max: 150 },
        { key: `${side}_arm_spread`, label: t("手臂側舉（度）"), min: -35, max: 125 },
        { key: `${side}_elbow`, label: t("屈肘（度）"), min: 0, max: 145 },
      ]
    : [
        { key: `${side}_hip`, label: t("腿部前抬（度）"), min: -80, max: 115 },
        { key: `${side}_leg_spread`, label: t("腿部外展（度）"), min: -30, max: 80 },
        { key: `${side}_knee`, label: t("屈膝（度）"), min: 0, max: 140 },
      ];
}
function Axes<K extends string>({
  axes,
  value,
  change,
  disabled,
}: {
  axes: Axis<K>[];
  value: Record<K, number>;
  change: (key: K, v: number) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-2">
      {axes.map((a) => (
        <label key={a.key} className="grid gap-1 text-caption text-fg-secondary" htmlFor={id + a.key}>
          {a.label}
          <NumberField
            id={id + a.key}
            value={Math.round(value[a.key] * 100) / 100}
            min={a.min}
            max={a.max}
            onCommit={(v) => {
              if (v !== null) change(a.key, v);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}
function Track<T extends { frame: number }>({
  keys,
  value,
  frame,
  change,
  seek,
  last,
}: {
  keys: T[];
  value: T;
  frame: number;
  change: (keys: T[]) => void;
  seek: (f: number) => void;
  last: number;
}) {
  const here = keys.some((k) => k.frame === frame);
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" disabled={here || keys.length >= MAX_KEYS} onClick={() => { change([...keys, value].sort((a, b) => a.frame - b.frame)); }}>
        {t("記錄立體關鍵格")}
      </Button>
      <Button size="sm" disabled={!here || keys.length < 2} onClick={() => { change(keys.filter((k) => k.frame !== frame)); }}>
        {t("移除立體關鍵格")}
      </Button>
      {keys.map((k) => (
        <Button size="sm" key={k.frame} disabled={k.frame > last} aria-pressed={k.frame === frame} onClick={() => { seek(k.frame); }}>
          {t("第 {frame} 格", { frame: k.frame })}
        </Button>
      ))}
    </div>
  );
}
function upsert<T extends { frame: number }>(keys: T[], v: T) {
  return [...keys.filter((k) => k.frame !== v.frame), v].sort((a, b) => a.frame - b.frame);
}
export function SpaceControls({
  scene,
  index,
  frame,
  last,
  seek,
  change,
  layerChange,
}: {
  scene: StudioPrevis;
  index: number;
  frame: number;
  last: number;
  seek: (f: number) => void;
  change: (scene: StudioPrevis) => void;
  layerChange: (patch: Partial<StudioPrevisLayer>) => void;
}) {
  const [cameraError, setCameraError] = useState(false);
  const [part, setPart] = useState<Part>("body");
  const can = (keys: readonly { frame: number }[]) => keys.some((k) => k.frame === frame) || keys.length < MAX_KEYS;
  const layer = scene.layers[index];
  if (!layer) {
    const keys = scene.lens_keys ?? [CAMERA],
      v = interpolate(keys, CAMERA, frame);
    const commit = (next: StudioPrevisCamera3D[]) => {
      seek(frame);
      const overlap = crossesTarget(next);
      setCameraError(overlap);
      if (!overlap) change({ ...scene, lens_keys: next });
    };
    return (
      <section className="grid gap-2">
        <h3 className="text-data font-semibold">{t("立體攝影機")}</h3>
        {cameraError ? (
          <p role="alert" className="text-warning">
            {t("攝影機位置與瞄準點重合，請調整其中一項。")}
          </p>
        ) : null}
        <Axes axes={cameraAxes()} value={v} disabled={!can(keys)} change={(key, n) => { commit(upsert(keys, { ...v, [key]: n })); }} />
        <Track keys={keys} value={v} frame={frame} change={commit} seek={seek} last={last} />
      </section>
    );
  }
  const keys = layer.rig_keys ?? [NEUTRAL],
    v = interpolate(keys, NEUTRAL, frame);
  const commit = (next: StudioPrevisRig[]) => {
    seek(frame);
    layerChange({ rig_keys: next });
  };
  return (
    <section className="grid gap-2">
      <Axes
        axes={[{ key: "z", label: t("圖層 Z（公尺）"), min: -4, max: 4 }]}
        value={{ z: zOf(layer, index, scene.layers.length) }}
        disabled={false}
        change={(_, n) => { layerChange({ z_m: n }); }}
      />
      {layer.kind === "puppet" ? (
        <>
          <label className="grid gap-1 text-caption">
            {t("人偶關節")}
            <Select compact value={part} onChange={(e) => { const value = e.target.value; if (value === "body" || value === "la" || value === "ra" || value === "ll" || value === "rl") setPart(value); }}>
              <option value="body">{t("軀幹與頭部")}</option>
              <option value="la">{t("左臂")}</option>
              <option value="ra">{t("右臂")}</option>
              <option value="ll">{t("左腿")}</option>
              <option value="rl">{t("右腿")}</option>
            </Select>
          </label>
          <Axes axes={rigAxes(part)} value={v} disabled={!can(keys)} change={(axis, n) => { commit(upsert(keys, { ...v, [axis]: n })); }} />
          <Track keys={keys} value={v} frame={frame} change={commit} seek={seek} last={last} />
        </>
      ) : null}
    </section>
  );
}
