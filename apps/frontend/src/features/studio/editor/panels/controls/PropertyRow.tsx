// The row of a property that can be animated, as in Premiere Pro's Effect Controls: the stopwatch (on = the property
// has keyframes), its name, its value under the playhead in the property's unit, and ◀ ◆ ▶: previous key, add or
// remove a key at the playhead, next key. Switching the stopwatch on writes a first key at the playhead; switching it
// off asks in the row itself before it removes the keys, and keeps the value under the playhead as the fixed value:
// when the document cannot take that value (a mask that would leave the frame), the reason shows under the row. The
// row's lane shows the keys. While the property is animated its name is a button that selects the key shaping the
// curve under the playhead (the key strip then shows it); a typed value is written into the key at the playhead.
import { ChevronLeft, ChevronRight, Diamond, Timer } from "lucide-react";
import { use, useState } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { FieldLockContext } from "./controlsContext";
import { NumberField } from "./fields";
import { InlineConfirm } from "./InlineConfirm";
import { KeyLane } from "./lanes/KeyLane";
import { useClipPanel } from "./panelContext";
import {
  governingKey,
  KEY_FULL,
  KEY_LIMIT,
  KEY_OUTSIDE,
  keyAt,
  keyBlocked,
  neighbourKey,
  playheadIn,
  propertyName,
  sequenceFrame,
  shownValue,
  storedValue,
  valueAt,
  withKeyToggled,
  withoutAnimation,
  withValueAt,
  type ClipProperty,
} from "./properties";
import { ROW_LABEL } from "./rowLook";
import { IconButton, RowFrame } from "./rows";
import { usePlayheadKeys, usePlayheadValue } from "./usePlayheadValue";

const NOT_ANIMATED = t("這個屬性還沒有動畫；先按碼表開始記錄關鍵影格");

export interface PropertyRowProps {
  property: ClipProperty;
  /** The clip the property belongs to (the selected clip, or its linked sound). */
  owner: TimelineClip;
  /** A fact about the property, for its tooltip. */
  hint?: string;
  /** Narrower bounds of the fixed value, in document units (a mask stays inside the frame while it is not animated). */
  fixedRange?: { min: number; max: number };
}

export function PropertyRow({ property, owner, hint, fixedRange }: PropertyRowProps) {
  const panel = useClipPanel();
  const locked = use(FieldLockContext);
  const [confirming, setConfirming] = useState(false);
  // Why switching the animation off was refused; shown under the row until the next action of the row
  const [refusal, setRefusal] = useState<string | null>(null);
  const { unit, label } = property;
  const name = propertyName(property);
  const animated = property.keys.length > 0;
  const shown = usePlayheadValue(panel.playhead, (frame) => shownValue(unit, valueAt(property, playheadIn(owner, frame).processing)));
  const at = usePlayheadKeys(panel.playhead, owner, property);
  const chosen = panel.selection?.property === property.key;
  const range = animated ? property : (fixedRange ?? property);
  /** Why no key can be written at the playhead (what the stopwatch, ◆ and the value of an animated property need). */
  const keyReason = !at.inside ? KEY_OUTSIDE : property.keys.length >= KEY_LIMIT && !at.onKey ? KEY_FULL : null;
  const here = () => playheadIn(owner, panel.playhead.getFrame());
  const stopwatchTitle = animated ? t("{name}：關閉動畫並移除所有關鍵影格", { name }) : t("{name}：開啟動畫，在播放頭寫入第一個關鍵影格", { name });

  const commitValue = (typed: number) => {
    setRefusal(null);
    const now = here();
    const blocked = animated ? keyBlocked(property, now) : null;
    return blocked ?? panel.apply(withValueAt(property, now.processing, storedValue(unit, typed, range.min, range.max)));
  };
  const toggleAnimation = () => {
    setRefusal(null);
    if (animated) setConfirming(true);
    else panel.perform(withKeyToggled(property, here().processing));
  };
  const removeAnimation = () => {
    setConfirming(false);
    const result = panel.apply(withoutAnimation(property, here().processing));
    if (typeof result === "string") setRefusal(result);
    else if (result && chosen) panel.select(null);
  };
  // The key strip, once it shows this property, follows what ◀ ◆ ▶ do; they never open it by themselves
  const toggleKey = () => {
    setRefusal(null);
    const now = here();
    const existed = keyAt(property, now.processing) !== undefined;
    if (!panel.perform(withKeyToggled(property, now.processing)) || !chosen) return;
    if (!existed) panel.select({ property: property.key, frame: now.processing });
    else if (panel.selection?.frame === now.processing) panel.select(null);
  };
  const jump = (direction: -1 | 1) => {
    const key = neighbourKey(owner, property, here().processing, direction);
    if (!key) return;
    panel.seek(sequenceFrame(owner, key));
    if (chosen) panel.select({ property: property.key, frame: key.frame });
  };
  const choose = () => {
    const key = chosen ? undefined : governingKey(owner, property, here().processing);
    panel.select(key ? { property: property.key, frame: key.frame } : null);
  };

  return (
    <RowFrame selected={chosen} lane={animated ? <KeyLane property={property} owner={owner} /> : undefined}>
      <IconButton
        label={t("{name} 的動畫", { name })}
        title={stopwatchTitle}
        pressed={animated}
        disabledReason={locked ?? (animated ? null : keyReason)}
        onClick={toggleAnimation}
      >
        <Timer aria-hidden />
      </IconButton>
      {animated && confirming ? (
        <InlineConfirm question={t("移除 {count} 個關鍵影格？", { count: property.keys.length })} action={t("移除")} onConfirm={removeAnimation} onCancel={() => { setConfirming(false); }} />
      ) : (
        <>
          {animated ? (
            <button
              type="button"
              aria-pressed={chosen}
              title={t("{name}：顯示關鍵影格與曲線", { name })}
              onClick={choose}
              className={cn(ROW_LABEL, "rounded-sm text-left hover:text-fg", chosen && "text-fg")}
            >
              {label}
            </button>
          ) : (
            <span className={ROW_LABEL} title={(hint != null && hint !== "") ? t("{label}：{hint}", { label: name, hint }) : name}>
              {label}
            </span>
          )}
          <NumberField
            label={name}
            value={shown}
            min={shownValue(unit, range.min)}
            max={shownValue(unit, range.max)}
            decimals={unit.decimals}
            step={unit.step}
            suffix={unit.suffix}
            {...(hint === undefined ? {} : { hint })}
            disabledReason={animated ? keyReason : null}
            onCommit={commitValue}
          />
          <span aria-hidden className="min-w-0 flex-1" />
          <span className="flex shrink-0 items-center">
            <IconButton
              label={t("{name}：上一個關鍵影格", { name })}
              disabledReason={!animated ? NOT_ANIMATED : at.before ? null : t("播放頭之前沒有關鍵影格")}
              onClick={() => { jump(-1); }}
            >
              <ChevronLeft aria-hidden />
            </IconButton>
            <IconButton
              label={at.onKey ? t("{name}：移除播放頭上的關鍵影格", { name }) : t("{name}：在播放頭加入關鍵影格", { name })}
              pressed={at.onKey}
              plain
              disabledReason={!animated ? NOT_ANIMATED : (locked ?? keyReason)}
              onClick={toggleKey}
            >
              <Diamond aria-hidden className={cn(at.onKey && "fill-brand-cyan text-brand-cyan")} />
            </IconButton>
            <IconButton
              label={t("{name}：下一個關鍵影格", { name })}
              disabledReason={!animated ? NOT_ANIMATED : at.after ? null : t("播放頭之後沒有關鍵影格")}
              onClick={() => { jump(1); }}
            >
              <ChevronRight aria-hidden />
            </IconButton>
          </span>
        </>
      )}
      {(refusal != null && refusal !== "") ? (
        <p role="alert" className="order-last basis-full pb-1 text-caption text-danger">
          {t("無法關閉動畫：{reason}（播放頭上的數值會成為固定值，請移到其他影格再試）", { reason: refusal })}
        </p>
      ) : null}
    </RowFrame>
  );
}
