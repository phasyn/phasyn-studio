// The strip under the rows of Effect Controls for the selected key: its place inside the clip, its value, how it
// leads to the next key (linear, Bezier, ease in, ease out, ease in and out, hold) and, when wanted, the property's
// curve with every key as a point and the handles of a Bezier key. The strip is never taller than 160 px: its header
// wraps onto a second line on a narrow panel and the curve takes what height is left.
import { Spline, Trash2, X } from "lucide-react";
import { useContext } from "react";
import type { TimelineClip, TimelineKeyframe } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { useMeasuredElement } from "@/lib/useElementSize";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { DEFAULT_BEZIER } from "../../../curves";
import { clipDuration, toClipLocalFrame, toProcessingFrame } from "../../../model";
import { FieldLockContext } from "../controlsContext";
import { NumberField, SelectField } from "../fields";
import { useClipPanel } from "../panelContext";
import {
  FRAMES_SUFFIX,
  KEY_COLLISION,
  KEY_LIMIT,
  patchedKeys,
  propertyName,
  sequenceFrame,
  shownKeys,
  shownValue,
  storedValue,
  withKeyChanged,
  withoutKey,
  type ClipProperty,
  type KeyChange,
} from "../properties";
import { IconButton } from "../rows";
import { BezierEditor, BezierFields } from "./BezierEditor";
import { CurveGraph } from "./CurveGraph";
import { INTERPOLATIONS } from "./interpolation";

export interface KeyStripProps {
  property: ClipProperty;
  /** The clip the property belongs to (the selected clip, or its linked sound). */
  owner: TimelineClip;
  /** The selected key. */
  keyframe: TimelineKeyframe;
  /** The panel is wide: the header fits one line and the handles of a Bezier key are also shown as numbers. */
  wide: boolean;
}

export function KeyStrip({ property, owner, keyframe, wide }: KeyStripProps) {
  const panel = useClipPanel();
  const locked = useContext(FieldLockContext);
  const [curve, setCurve] = usePersistentFlag("studio.nle.controls.curve", true);
  const [bodyRef, , body] = useMeasuredElement<HTMLDivElement>();
  const { unit } = property;
  const name = propertyName(property);
  const shown = shownKeys(owner, property);
  const hidden = property.keys.length - shown.length;
  const place = { index: shown.findIndex((key) => key.frame === keyframe.frame) + 1, count: shown.length, limit: KEY_LIMIT };
  // Keys a trim left outside the part of the clip that plays are still in the document: the count says so
  const placeTitle =
    hidden > 0
      ? t("第 {index} 個，共 {count} 個關鍵影格（每個屬性最多 {limit} 個）；另有 {hidden} 個在片段播放的範圍之外", { ...place, hidden })
      : t("第 {index} 個，共 {count} 個關鍵影格（每個屬性最多 {limit} 個）", place);
  const bezier = keyframe.bezier ?? DEFAULT_BEZIER;

  const select = (frame: number) => panel.select({ property: property.key, frame });
  const patch = (change: Partial<TimelineKeyframe>) => property.withKeys(patchedKeys(property.keys, keyframe.frame, change));
  /** A key at another frame, with another value, or both; the answer is the field's: true, or why it was refused. */
  const change = (from: number, to: KeyChange) => {
    const next = withKeyChanged(property, from, to);
    if (!next) return KEY_COLLISION;
    const result = panel.apply(next);
    if (result === true && from === keyframe.frame && to.frame !== undefined) select(to.frame);
    return result;
  };
  const remove = (key: TimelineKeyframe) => {
    if (!panel.perform(withoutKey(property, key.frame))) return;
    if (key.frame === keyframe.frame) panel.select(null);
    // The strip (or the point in it) goes with the key: the focus stays in the panel
    panel.rest();
  };

  return (
    <section aria-label={t("選取的關鍵影格")} className="flex max-h-40 shrink-0 flex-col border-t border-line bg-surface">
      <div className="flex shrink-0 flex-wrap items-center gap-x-1 px-1.5 py-px">
        <span className="flex h-7 min-w-24 flex-1 items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 rotate-45 rounded-[1px] bg-brand-cyan" />
          <span className="min-w-0 truncate text-data font-medium text-fg" title={name}>
            {name}
          </span>
          <span className="machine shrink-0 text-caption text-fg-tertiary" title={placeTitle}>
            {place.index}/{place.count}
          </span>
        </span>
        <NumberField
          label={t("關鍵影格的位置（片段內的影格）")}
          value={toClipLocalFrame(owner, keyframe.frame)}
          min={0}
          max={clipDuration(owner)}
          suffix={FRAMES_SUFFIX}
          className="w-14"
          onCommit={(local) => change(keyframe.frame, { frame: toProcessingFrame(owner, local) })}
        />
        <NumberField
          label={t("關鍵影格的數值")}
          value={shownValue(unit, keyframe.value)}
          min={shownValue(unit, property.min)}
          max={shownValue(unit, property.max)}
          decimals={unit.decimals}
          step={unit.step}
          suffix={unit.suffix}
          className="w-16"
          onCommit={(typed) => change(keyframe.frame, { value: storedValue(unit, typed, property.min, property.max) })}
        />
        <SelectField
          label={t("插值方式")}
          value={keyframe.interpolation}
          options={INTERPOLATIONS}
          hint={t("從這個關鍵影格到下一個的變化方式")}
          onChange={(interpolation) => panel.perform(patch({ interpolation }))}
          className="w-24 shrink-0"
        />
        <span className="flex shrink-0 items-center">
          <IconButton label={t("曲線")} title={curve ? t("隱藏曲線") : t("顯示曲線")} pressed={curve} onClick={() => setCurve(!curve)}>
            <Spline aria-hidden />
          </IconButton>
          <IconButton label={t("刪除這個關鍵影格")} disabledReason={locked} onClick={() => remove(keyframe)} className="hover:text-danger">
            <Trash2 aria-hidden />
          </IconButton>
          <IconButton label={t("取消選取這個關鍵影格")} onClick={() => panel.select(null)}>
            <X aria-hidden />
          </IconButton>
        </span>
      </div>
      {curve ? (
        <div ref={bodyRef} className={cn("flex min-h-0 shrink gap-2 px-1.5 pb-1.5", wide ? "h-[7.5rem]" : "h-24")}>
          <CurveGraph
            property={property}
            owner={owner}
            selected={keyframe.frame}
            locked={locked}
            onSelect={(key) => {
              panel.seek(sequenceFrame(owner, key));
              select(key.frame);
            }}
            onChange={(from, to) => {
              const result = change(from, to);
              if (typeof result === "string") panel.warn(result);
              return result === true;
            }}
            onRemove={remove}
          />
          {keyframe.interpolation === "bezier" ? (
            <>
              <BezierEditor value={bezier} size={body.height} locked={locked} onChange={(next) => panel.perform(patch({ bezier: next }))} />
              {wide ? <BezierFields value={bezier} onChange={(next) => panel.apply(patch({ bezier: next }))} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
