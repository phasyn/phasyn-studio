// Effect Controls for a selected transition: its kind, where it sits on the cut (its alignment), its length in frames,
// and for a moving transition (push, slide, whip, wipe, zoom) where it goes, how its movement eases and how soft a
// wipe's edge is; a button removes it. Each change is one `transition` command: the two clips run on past the cut into
// their own frames (held edge frames where the media runs out, shown as insufficient media) and nothing else moves.
import { AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hourglass, Trash2, TriangleAlert, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import type { TimelineClip } from "@/api/generated/contracts";
import { reveal, useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import {
  DEFAULT_TRANSITION_EASING,
  DEFAULT_WIPE_SOFTNESS,
  isMoving,
  TRANSITION_ALIGNMENT_LABELS,
  TRANSITION_ALIGNMENTS,
  TRANSITION_DIRECTION_LABELS,
  TRANSITION_DIRECTIONS,
  TRANSITION_EASING_LABELS,
  TRANSITION_EASINGS,
  TRANSITION_KINDS,
  TRANSITION_LABELS,
  TRANSITION_MAX_FRAMES,
  WIPE_SOFTNESS_MAX,
  type Transition,
  type TransitionAlignment,
  type TransitionDirection,
  type TransitionEasing,
  type TransitionOptions,
} from "../../../model/clipEffects";
import { formatDuration } from "../../../model/frames";
import { useEditor } from "../../editorContext";
import { clipDuration, trackClips } from "../../model";
import { cutOf, repeatedFrames } from "../../transitionCut";
import { lockReason, runEdit } from "./clipEdits";
import { FieldLockContext } from "./controlsContext";
import { NumberField, Segmented, SelectField, type ChoiceOption } from "./fields";
import { FRAMES_SUFFIX } from "./properties";
import { ActionRow, Row, TextButton } from "./rows";

type Kind = Transition["kind"];

const KIND_OPTIONS: readonly ChoiceOption<Kind>[] = TRANSITION_KINDS.map((kind) => ({ value: kind, label: TRANSITION_LABELS[kind] }));
const EASING_OPTIONS: readonly ChoiceOption<TransitionEasing>[] = TRANSITION_EASINGS.map((easing) => ({ value: easing, label: TRANSITION_EASING_LABELS[easing] }));
const DIRECTION_ICONS: Record<TransitionDirection, LucideIcon> = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown, in: ZoomIn, out: ZoomOut };
const ALIGNMENT_ICONS: Record<TransitionAlignment, LucideIcon> = { center: AlignHorizontalJustifyCenter, start: AlignHorizontalJustifyStart, end: AlignHorizontalJustifyEnd };
const ALIGNMENT_OPTIONS: readonly ChoiceOption<TransitionAlignment>[] = TRANSITION_ALIGNMENTS.map((alignment) => {
  const Icon = ALIGNMENT_ICONS[alignment];
  return { value: alignment, label: TRANSITION_ALIGNMENT_LABELS[alignment], icon: <Icon aria-hidden /> };
});
const LENGTH_HINT = t("轉場的影格數；兩側片段延伸到切點之外，其他片段不會移動");
const ALIGNMENT_HINT = t("轉場放在切點的哪裡：置中、從切點開始，或在切點結束");
const MEDIA_HINT = t("片段在切點外的影格不夠時，轉場重複片段的第一格或最後一格補足");
const DIRECTION_HINT = t("畫面移動的方向（縮放轉場：推近＝前一段放大穿越到下一段，拉遠相反）");
const EASING_HINT = t("移動的速度曲線；聲音一律交叉淡化");
const SOFTNESS_HINT = t("擦除邊界的柔邊寬度，以移動距離的百分比表示；0 為硬邊");

export interface TransitionControlsProps {
  /** The outgoing clip: it carries the transition into the clip after it. */
  clip: TimelineClip;
  transition: Transition;
}

export function TransitionControls({ clip, transition }: TransitionControlsProps) {
  const editor = useEditor();
  const { timeline, linked } = editor;
  const title = useChangeFade<HTMLHeadingElement>(transition.kind);
  const ordered = trackClips(timeline, clip.track_id);
  const next = ordered[ordered.findIndex((item) => item.clip_id === clip.clip_id) + 1];
  // eslint-disable-next-line @eslint-react/no-unstable-context-value -- The lock reason is a primitive string or null; React compares it by value.
  const lock = lockReason(timeline, clip, linked);
  // The clips as they are at the cut bound the length: what they lend beyond it does not count
  const cut = cutOf(transition);
  const longest = Math.min(TRANSITION_MAX_FRAMES, clipDuration(clip) - cut.outgoing.frames, next ? clipDuration(next) - cut.incoming.frames : TRANSITION_MAX_FRAMES);
  const repeated = next ? repeatedFrames(clip, next, transition) : { outgoing: 0, incoming: 0 };
  const names = next ? t("{from} → {to}", { from: clip.name, to: next.name }) : clip.name;
  const set = (kind: Kind | "cut", frames: number, options?: TransitionOptions, alignment?: TransitionAlignment) => runEdit(editor, { type: "transition", clipId: clip.clip_id, kind, frames, ...(options === undefined ? {} : { options }), ...(alignment === undefined ? {} : { alignment }), linked });
  const report = (result: ReturnType<typeof set>) => {
    if (typeof result === "string") editor.warn(result);
  };
  const remove = () => {
    const result = set("cut", 0);
    if (typeof result === "string") editor.warn(result);
    else if (result) editor.selectTransition(null);
  };
  const moving = isMoving(transition) ? transition : null;
  const directions = moving ? TRANSITION_DIRECTIONS[moving.kind] : [];
  const directionOptions: readonly ChoiceOption<TransitionDirection>[] = directions.map((direction) => {
    const Icon = DIRECTION_ICONS[direction];
    return { value: direction, label: TRANSITION_DIRECTION_LABELS[direction], icon: <Icon aria-hidden /> };
  });
  const wipe = moving?.kind === "wipe" ? moving : null;
  return (
    <FieldLockContext value={lock}>
      <div data-keep-focus="" className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-2">
          <Hourglass aria-hidden className="size-4 shrink-0 text-brand-cyan" />
          <h2 ref={title} className="max-w-[60%] shrink-0 truncate text-body font-semibold text-fg">
            {TRANSITION_LABELS[transition.kind]}
          </h2>
          <span className="min-w-0 flex-1 truncate text-data text-fg-tertiary" title={names}>
            {names}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <Row label={t("種類")}>
            <SelectField label={t("轉場種類")} value={transition.kind} options={KIND_OPTIONS} onChange={(kind) => { report(set(kind, transition.frames)); }} className="max-w-56 flex-1" />
          </Row>
          <Row label={t("對齊")} hint={ALIGNMENT_HINT}>
            <Segmented label={t("轉場對齊")} value={cut.alignment} options={ALIGNMENT_OPTIONS} onChange={(alignment) => { report(set(transition.kind, transition.frames, undefined, alignment)); }} />
            <span className="min-w-0 truncate text-caption text-fg-secondary">{TRANSITION_ALIGNMENT_LABELS[cut.alignment]}</span>
          </Row>
          {repeated.outgoing + repeated.incoming > 0 ? (
            <div key="media" ref={reveal(0)}>
              <Row label={t("素材")} hint={MEDIA_HINT}>
                <span
                  role="status"
                  className="inline-flex min-w-0 items-center gap-1 rounded-sm border border-warning/40 bg-warning/15 px-1.5 py-0.5 text-caption text-warning"
                  title={t("「{from}」在切點後重複最後一格 {outgoing} 影格；「{to}」在切點前重複第一格 {incoming} 影格", { from: clip.name, to: next?.name ?? "", outgoing: repeated.outgoing, incoming: repeated.incoming })}
                >
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{t("素材不足（重複影格）")}</span>
                </span>
              </Row>
            </div>
          ) : null}
          {moving ? (
            <div key={`moving-${moving.kind === "zoom" ? "zoom" : "edge"}`} ref={reveal(0)}>
              <Row label={t("方向")} hint={DIRECTION_HINT}>
                <Segmented label={t("轉場方向")} value={moving.direction} options={directionOptions} onChange={(direction) => { report(set(moving.kind, moving.frames, { direction })); }} />
              </Row>
              <Row label={t("緩動")} hint={EASING_HINT}>
                <SelectField
                  label={t("轉場緩動")}
                  hint={EASING_HINT}
                  value={moving.easing ?? DEFAULT_TRANSITION_EASING}
                  options={EASING_OPTIONS}
                  onChange={(easing) => { report(set(moving.kind, moving.frames, { easing })); }}
                  className="max-w-56 flex-1"
                />
              </Row>
            </div>
          ) : null}
          {wipe ? (
            <div key="softness" ref={reveal(1)}>
              <Row label={t("柔邊")} hint={SOFTNESS_HINT}>
                <NumberField
                  label={t("擦除柔邊")}
                  value={Math.round((wipe.softness ?? DEFAULT_WIPE_SOFTNESS) * 1000) / 10}
                  min={0}
                  max={WIPE_SOFTNESS_MAX * 100}
                  decimals={1}
                  suffix="%"
                  hint={SOFTNESS_HINT}
                  onCommit={(percent) => set(wipe.kind, wipe.frames, { softness: Math.round(percent * 10) / 1000 })}
                />
              </Row>
            </div>
          ) : null}
          <Row label={t("長度")} hint={LENGTH_HINT}>
            <NumberField
              label={t("轉場長度")}
              value={transition.frames}
              min={1}
              max={longest}
              suffix={FRAMES_SUFFIX}
              hint={LENGTH_HINT}
              onCommit={(frames) => set(transition.kind, frames)}
            />
            <span className="machine min-w-0 truncate text-caption text-fg-tertiary">{formatDuration(transition.frames, editor.fps)}</span>
          </Row>
          <ActionRow>
            <TextButton tone="danger" icon={<Trash2 aria-hidden />} disabledReason={lock} onClick={remove}>
              {t("移除轉場")}
            </TextButton>
          </ActionRow>
        </div>
      </div>
    </FieldLockContext>
  );
}
