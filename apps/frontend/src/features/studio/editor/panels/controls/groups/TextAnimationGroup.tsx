// The Animation group of a text layer: its In (進場) and Out (退場) preset, each with its length in frames. Choosing a
// preset, changing its length or taking it away (無) is one named step of the history; the keys it writes show in the
// lanes of Motion, Opacity and Effects, and the lane of each row here shows where the animation is. A picker shows
// the preset the layer's keys still match, 自訂 when the layer's edge carries keys of someone's own. An animation that
// an edit of the layer's edge left elsewhere can be put back on the edge.
import { useContext, useState } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { exportGeometry, localId } from "../../../../model/project";
import { useEditor, type Editor } from "../../../editorContext";
import { clipDuration, toClipLocalFrame } from "../../../model";
import {
  ANIMATION_SIDES,
  animationLimit,
  blurUnavailable,
  defaultAnimationFrames,
  detectTextAnimation,
  framesProblem,
  MIN_ANIMATION_FRAMES,
  presetKeyCount,
  presetName,
  TEXT_PRESETS,
  withoutTextAnimations,
  withTextAnimation,
  type AnimationSide,
  type AnimationState,
  type TextPresetId,
} from "../../../titles/textAnimation";
import { applyClip, type EditResult } from "../clipEdits";
import { FieldLockContext } from "../controlsContext";
import { NumberField, SelectField, type ChoiceOption } from "../fields";
import { Group } from "../Group";
import { LANE_INSET, laneLeft } from "../lanes/laneGeometry";
import { RowLayoutContext } from "../panelContext";
import { FRAMES_SUFFIX } from "../properties";
import { ROW_LABEL, ROW_LEAD } from "../rowLook";
import { RowFrame, TextButton } from "../rows";

type Choice = TextPresetId | "none" | "custom";

/** What a side's row says, and the names of the history steps it makes. */
const SIDE_TEXT = {
  in: {
    label: t("進場"),
    picker: t("進場動畫"),
    length: t("進場動畫長度"),
    hint: t("從片段的第一個影格開始"),
    applied: (name: string) => t("套用進場動畫「{name}」", { name }),
    removed: t("移除進場動畫"),
    resized: t("調整進場動畫長度"),
    aligned: t("對齊進場動畫"),
    away: t("片段的開頭修剪過，進場動畫不在第一個影格；按一下移回開頭"),
  },
  out: {
    label: t("退場"),
    picker: t("退場動畫"),
    length: t("退場動畫長度"),
    hint: t("在片段的最後一個影格結束"),
    applied: (name: string) => t("套用退場動畫「{name}」", { name }),
    removed: t("移除退場動畫"),
    resized: t("調整退場動畫長度"),
    aligned: t("對齊退場動畫"),
    away: t("片段的結尾修剪過，退場動畫不在最後一個影格；按一下移回結尾"),
  },
} as const;

/** A changed layer as one step of the history, under its own name. */
function commitNamed(editor: Editor, clip: TimelineClip, label: string): EditResult {
  return applyClip({ timeline: editor.timeline, linked: editor.linked, commit: (next) => editor.commit(next, label) }, clip);
}

/** Where a side's animation is, on the lane of its row (it fades in when the animation changes). */
function AnimationSpan({ clip, state }: { clip: TimelineClip; state: AnimationState }) {
  const fade = useChangeFade<HTMLSpanElement>(state.kind === "preset" ? `${state.preset}:${state.start}:${state.frames}` : state.kind);
  if (state.kind !== "preset") return null;
  const duration = Math.max(1, clipDuration(clip));
  const fraction = (processing: number) => Math.max(0, Math.min(1, toClipLocalFrame(clip, processing) / duration));
  const from = fraction(state.start);
  const to = fraction(state.start + state.frames);
  if (to <= from) return null;
  return (
    <span
      ref={fade}
      aria-hidden
      className="pointer-events-none absolute inset-y-1.5 rounded-sm border border-brand-blue/55 bg-brand-blue/20"
      style={{ left: laneLeft(from), width: `calc((100% - ${2 * LANE_INSET}px) * ${(to - from).toFixed(5)})` }}
    />
  );
}

interface AnimationRowProps {
  clip: TimelineClip;
  side: AnimationSide;
  state: AnimationState;
  /** What the other side has: its preset takes room from this one. */
  other: AnimationState;
  /** The length the side's next preset takes while it has none. */
  pending: number;
  setPending: (frames: number) => void;
  change: (side: AnimationSide, preset: TextPresetId | null, frames: number, label: string) => EditResult;
}

function AnimationRow({ clip, side, state, other, pending, setPending, change }: AnimationRowProps) {
  const editor = useEditor();
  const { lead } = useContext(RowLayoutContext);
  const locked = useContext(FieldLockContext);
  const text = SIDE_TEXT[side];
  const limit = animationLimit(clip, other);
  const room = framesProblem(clip, MIN_ANIMATION_FRAMES, other);
  const frames = state.kind === "preset" ? state.frames : Math.max(MIN_ANIMATION_FRAMES, Math.min(limit, pending));
  const blur = blurUnavailable(clip);
  const value: Choice = state.kind === "preset" ? state.preset : state.kind;
  const options: ChoiceOption<Choice>[] = [
    { value: "none", label: t("無") },
    ...TEXT_PRESETS.map((preset) => ({ value: preset.id, label: preset.id === "blur" && blur ? t("{name}（無法使用）", { name: preset[side] }) : preset[side] })),
    // Shown only while it is what the side has: it is not something to choose
    ...(state.kind === "custom" ? [{ value: "custom" as const, label: t("自訂") }] : []),
  ];
  const report = (result: EditResult) => {
    if (typeof result === "string") editor.warn(result);
  };
  const choose = (choice: Choice) => {
    if (choice === value || choice === "custom") return;
    if (choice === "none") {
      if (state.kind === "preset") report(change(side, null, frames, text.removed));
      return;
    }
    const refusal = (choice === "blur" ? blur : null) ?? room;
    if (refusal) editor.warn(refusal);
    else report(change(side, choice, frames, text.applied(presetName(choice, side))));
  };
  const seconds = (frames / Math.max(1, editor.fps)).toFixed(2);

  return (
    <RowFrame lane={<AnimationSpan clip={clip} state={state} />}>
      {lead ? <span aria-hidden className={ROW_LEAD} /> : null}
      <span className={ROW_LABEL} title={t("{label}：{hint}", { label: text.label, hint: text.hint })}>
        {text.label}
      </span>
      <SelectField label={text.picker} value={value} options={options} hint={blur ?? undefined} onChange={choose} className="max-w-56 min-w-24 flex-1" />
      <NumberField
        label={text.length}
        value={frames}
        min={MIN_ANIMATION_FRAMES}
        max={Math.max(MIN_ANIMATION_FRAMES, limit)}
        suffix={FRAMES_SUFFIX}
        hint={t("約 {seconds} 秒", { seconds })}
        disabledReason={room}
        onCommit={(next) => {
          // Without a preset the length waits for the next one
          if (state.kind !== "preset") {
            setPending(next);
            return true;
          }
          if (next === state.frames && state.aligned) return true;
          return change(side, state.preset, next, text.resized);
        }}
      />
      {state.kind === "preset" && !state.aligned ? (
        <TextButton title={text.away} disabledReason={locked} onClick={() => report(change(side, state.preset, state.frames, text.aligned))}>
          {t("對齊")}
        </TextButton>
      ) : null}
    </RowFrame>
  );
}

export function TextAnimationGroup({ clip }: { clip: TimelineClip }) {
  const editor = useEditor();
  const frame = exportGeometry(editor.project);
  const states: Record<AnimationSide, AnimationState> = { in: detectTextAnimation(clip, "in", frame), out: detectTextAnimation(clip, "out", frame) };
  const [pending, setPending] = useState<Record<AnimationSide, number>>(() => {
    const frames = defaultAnimationFrames(editor.fps);
    return { in: frames, out: frames };
  });
  const change = (side: AnimationSide, preset: TextPresetId | null, frames: number, label: string): EditResult => {
    const result = withTextAnimation(clip, side, preset, frames, frame, localId);
    return result.ok ? commitNamed(editor, result.value, label) : result.error;
  };
  const reset = () => {
    const result = commitNamed(editor, withoutTextAnimations(clip, frame), t("移除文字動畫"));
    if (typeof result === "string") editor.warn(result);
  };
  return (
    <Group
      id="animation"
      title={t("動畫")}
      changed={states.in.kind === "preset" || states.out.kind === "preset"}
      onReset={reset}
      resetKeys={presetKeyCount(clip, states.in) + presetKeyCount(clip, states.out)}
    >
      {ANIMATION_SIDES.map((side) => (
        <AnimationRow
          key={side}
          clip={clip}
          side={side}
          state={states[side]}
          other={states[side === "in" ? "out" : "in"]}
          pending={pending[side]}
          setPending={(frames) => setPending((current) => ({ ...current, [side]: frames }))}
          change={change}
        />
      ))}
    </Group>
  );
}
