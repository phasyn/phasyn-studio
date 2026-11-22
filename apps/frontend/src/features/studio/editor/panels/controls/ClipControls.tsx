// Effect Controls for a selected clip, laid out as in Premiere Pro. A header line names the clip and its range; under
// it the property groups (an accordion) stand on the left and the keyframe lanes on the right, sharing one vertical
// scroll; under those the strip of the selected key. A row and its lane are one grid row, so they stay aligned. The
// lanes need room: on a panel narrower than 560 px (or when the header's button hides them) the properties take the
// whole width and the keys of a property are reached with its ◀ ◆ ▶ buttons. An adjustment layer shows only what it
// has: the clip, opacity and blending, its fades, the mask, its effects and its colour.
import { ChartGantt, Film, Music2, SlidersHorizontal, Type } from "lucide-react";
import { useMemo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { TimelineClip } from "@/api/generated/contracts";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { isTextEntry } from "@/lib/keyboard";
import { useElementSize } from "@/lib/useElementSize";
import { usePersistentFlag } from "@/lib/usePersistentSize";
import { formatTimecode } from "../../../model/frames";
import { exportGeometry } from "../../../model/project";
import { hasMotionReference } from "../../../speedfeel/target";
import { useEditor } from "../../editorContext";
import { chordOf } from "../../keymap";
import { clipDuration, clipEnabled } from "../../model";
import { clipEdits, clipKind, linkedAudio, lockReason, runEdit } from "./clipEdits";
import { FieldLockContext, GroupsContext, setGroupOpen, useOpenGroups, type ClipKindId, type GroupId, type GroupsState } from "./controlsContext";
import { AudioGroup } from "./groups/AudioGroup";
import { CameraGroup, ImpactGroup } from "./groups/CameraGroup";
import { ClipGroup } from "./groups/ClipGroup";
import { ColorGroup, TextGroup } from "./groups/ColorGroup";
import { EffectsGroup } from "./groups/EffectsGroup";
import { MaskGroup } from "./groups/MaskGroup";
import { MotionGroup, OpacityGroup } from "./groups/MotionGroup";
import { SpeedFeelGroup } from "./groups/SpeedFeelGroup";
import { TextAnimationGroup } from "./groups/TextAnimationGroup";
import { FadeGroup, TimeGroup } from "./groups/TimeGroup";
import type { FieldRequest } from "./intents";
import { KeyStrip } from "./keys/KeyStrip";
import { ClipTime, LaneBackdrop, LanePlayhead, LaneRuler } from "./lanes/LaneRuler";
import { ClipPanelContext, RowLayoutContext, type ClipPanel, type KeySelection } from "./panelContext";
import { audioProperties, clipProperties, withoutKey, type AudioProperties, type ClipProperty } from "./properties";
import { IconButton, TextButton } from "./rows";

/** From this width of the panel the keyframe lanes have room beside the properties. */
const LANES_PANEL_WIDTH = 560;
/** The same measured inside the panel's frame, where this component lies (the frame is a 1 px border; a little tolerance). */
const LANES_FROM = LANES_PANEL_WIDTH - 4;
/** What a property row holds beside its label: the stopwatch, the value with its unit, the keyframe navigator, the gaps and the padding. */
const ROW_FIXED = 238;
/** Room the scrollbar of the panel body may take from the rows (10 px here, a little more in other browsers). */
const SCROLLBAR = 12;

const KIND_ICON = { video: Film, audio: Music2, text: Type, adjustment: SlidersHorizontal } as const;
const KIND_TONE: Record<ClipKindId, string> = { video: "text-clip-video-edge", audio: "text-clip-audio-edge", text: "text-brand-violet", adjustment: "text-clip-adjust-edge" };

/** Width of the property column while the lanes show: a little over half the panel, between what a row needs and a comfortable maximum. */
function propertyColumn(width: number): number {
  return Math.round(Math.max(300, Math.min(440, width * 0.52)));
}

/** The group a requested field is in. */
function requestedGroup(request: FieldRequest | null): GroupId | null {
  if (!request) return null;
  return request.field === "name" ? "clip" : "time";
}

/** A property and the clip it belongs to. */
interface OwnedProperty {
  property: ClipProperty;
  owner: TimelineClip;
}

/** The property a key selection names: one of the selected clip's own, or the volume or pan of its sound. */
function ownedProperty(
  key: string,
  clip: TimelineClip,
  properties: ReadonlyMap<string, ClipProperty>,
  sound: TimelineClip | null,
  audio: AudioProperties | null,
): OwnedProperty | null {
  const own = properties.get(key);
  if (own) return { property: own, owner: clip };
  const heard = sound && audio ? [audio.volume, audio.pan].find((property) => property.key === key) : undefined;
  return sound && heard ? { property: heard, owner: sound } : null;
}

interface Section {
  id: GroupId;
  node: ReactNode;
}

interface ClipHeaderProps {
  clip: TimelineClip;
  kind: ClipKindId;
  /** Clips selected beside this one. */
  others: number;
  /** The lanes are on screen. */
  lanes: boolean;
  /** Why the lanes cannot show; null when they can. */
  lanesBlocked: string | null;
  /** Why the clip cannot be changed (a locked track); null when it can. */
  lock: string | null;
  onToggleLanes: () => void;
}

function ClipHeader({ clip, kind, others, lanes, lanesBlocked, lock, onToggleLanes }: ClipHeaderProps) {
  const editor = useEditor();
  const { fps } = editor;
  const duration = clipDuration(clip);
  const enabled = clipEnabled(clip);
  const Icon = KIND_ICON[kind];
  return (
    <header className="@container/ec flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-2">
      <Icon aria-hidden className={cn("size-4 shrink-0", KIND_TONE[kind])} />
      <h2 className={cn("min-w-0 flex-1 truncate text-body font-semibold", enabled ? "text-fg" : "text-fg-tertiary line-through")} title={clip.name}>
        {clip.name}
      </h2>
      {others > 0 ? (
        <span
          className="machine shrink-0 rounded-sm bg-raised px-1 text-caption text-fg-secondary"
          title={t("另外選取了 {count} 個片段；這裡調整的是第一個", { count: others })}
        >
          +{others}
        </span>
      ) : null}
      <span
        // The range gives way to the name on a narrow panel (sooner when the switched-off mark needs the room too)
        className={cn("machine hidden shrink-0 text-caption whitespace-nowrap text-fg-tertiary", enabled ? "@min-[340px]/ec:inline" : "@min-[450px]/ec:inline")}
        title={t("片段在序列上的範圍；長度 {duration}", { duration: formatTimecode(duration, fps) })}
      >
        {t("{start} – {end}", { start: formatTimecode(clip.start_frame, fps), end: formatTimecode(clip.start_frame + duration, fps) })}
      </span>
      {enabled ? null : (
        <>
          <span className="shrink-0 rounded-full border border-warning/30 bg-warning/12 px-1.5 py-px text-caption font-medium text-warning">
            {t("已停用")}
          </span>
          <TextButton
            title={t("啟用這個片段（{shortcut}）", { shortcut: chordOf("toggleEnabled") })}
            disabledReason={lock}
            onClick={() => void editor.toggleEnabled()}
          >
            {t("啟用")}
          </TextButton>
        </>
      )}
      <IconButton
        label={t("關鍵影格軌道")}
        title={lanes ? t("隱藏關鍵影格軌道") : t("顯示關鍵影格軌道")}
        pressed={lanes}
        disabledReason={lanesBlocked}
        onClick={onToggleLanes}
      >
        <ChartGantt aria-hidden />
      </IconButton>
    </header>
  );
}

export interface ClipControlsProps {
  clip: TimelineClip;
  /** A field a command asked to bring forward (rename, speed). */
  request: FieldRequest | null;
}

export function ClipControls({ clip, request }: ClipControlsProps) {
  const editor = useEditor();
  const { timeline } = editor;
  const rootRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(rootRef);
  const [wantLanes, setWantLanes] = usePersistentFlag("studio.nle.controls.lanes", true);
  const [selection, setSelection] = useState<KeySelection | null>(null);

  const kind = clipKind(timeline, clip, editor.sourceOf(clip));
  const sound = kind === "audio" ? clip : linkedAudio(timeline, clip);
  const frame = exportGeometry(editor.project);
  const properties = new Map((kind === "audio" ? [] : clipProperties(clip, "video", frame)).map((property) => [property.key, property]));
  const audio = sound ? audioProperties(sound, frame) : null;
  // eslint-disable-next-line @eslint-react/no-unstable-context-value -- The lock reason is a primitive string or null; React compares it by value.
  const lock = lockReason(timeline, clip, editor.linked);
  // eslint-disable-next-line @eslint-react/no-unstable-context-value -- The lock reason is a primitive string or null; React compares it by value.
  const soundLock = sound ? lockReason(timeline, sound, editor.linked) : null;

  // Layout: the lanes take the right part of a panel that is wide enough for them. Without them the rows have the
  // whole width, less the scrollbar of the body; the labels are as wide as a property row leaves them, up to a limit
  const roomy = width >= LANES_FROM;
  const lanes = wantLanes && roomy;
  const column = lanes ? propertyColumn(width) : width - SCROLLBAR;
  const sizes: CSSProperties & Record<"--ec-props" | "--ec-label", string> = { "--ec-props": `${String(column)}px`, "--ec-label": `${String(Math.max(56, Math.min(112, column - ROW_FIXED)))}px` };

  const openGroups = useOpenGroups(kind);
  const asked = requestedGroup(request);
  // What a command asked for stays open afterwards: it joins the remembered groups once it was shown
  useEffect(() => {
    if (asked) setGroupOpen(kind, asked, true);
  }, [asked, kind]);
  const rowLayout = useMemo(() => ({ lead: true, lanes }), [lanes]);
  const groups = useMemo<GroupsState>(() => ({ open: openGroups, forced: asked, setOpen: (id, open) => { setGroupOpen(kind, id, open); } }), [openGroups, asked, kind]);

  const panel = useMemo<ClipPanel>(() => ({
    ...clipEdits(editor, editor.warn),
    clip,
    fps: editor.fps,
    playhead: editor.playhead,
    // A value still being typed is taken before the playhead moves: the fields show the value at the playhead
    seek: (target) => {
      editor.drafts.commitAll();
      editor.transport.seek(target);
    },
    warn: editor.warn,
    fixedLengthTiming: (edit) => runEdit(editor, { type: "fixedLengthTiming", clipId: clip.clip_id, linked: editor.linked, edit }, t("時間")),
    selection,
    select: setSelection,
    rest: () => rootRef.current?.focus({ preventScroll: true }),
  }), [editor, clip, selection]);

  // The selected key, while it still exists (an undo or another edit may have taken it away)
  const owned = selection ? ownedProperty(selection.property, clip, properties, sound, audio) : null;
  const keyframe = selection ? owned?.property.keys.find((key) => key.frame === selection.frame) : undefined;

  const clipSection: Section = { id: "clip", node: <ClipGroup clip={clip} kind={kind} focusName={request?.field === "name" ? request.id : null} /> };
  const timeSection: Section = {
    id: "time",
    node: <TimeGroup clip={clip} sound={kind === "audio"} focusSpeed={request?.field === "speed" ? request.id : null} />,
  };
  const soundSections: Section[] =
    sound && audio
      ? [
          {
            id: "audio",
            node: (
              <FieldLockContext value={soundLock}>
                <AudioGroup clip={sound} audio={audio} />
              </FieldLockContext>
            ),
          },
        ]
      : [];
  const opacitySection: Section = { id: "opacity", node: <OpacityGroup clip={clip} properties={properties} /> };
  const fadeSection: Section = { id: "fade", node: <FadeGroup clip={clip} adjustment={kind === "adjustment"} /> };
  // What changes the picture without moving it or its clock: an adjustment layer has these alone
  const lookSections: Section[] = [
    { id: "mask", node: <MaskGroup clip={clip} properties={properties} /> },
    { id: "effects", node: <EffectsGroup clip={clip} properties={properties} /> },
    { id: "color", node: <ColorGroup clip={clip} /> },
  ];
  const pictureSections: Section[] = [
    { id: "motion", node: <MotionGroup clip={clip} properties={properties} /> },
    opacitySection,
    timeSection,
    fadeSection,
    { id: "camera", node: <CameraGroup clip={clip} /> },
    { id: "impact", node: <ImpactGroup clip={clip} /> },
    // The speed-feel tool, where the clip's shot has a motion reference to compare with
    ...(kind === "video" && hasMotionReference(editor.project, timeline, clip) ? [{ id: "speedfeel" as const, node: <SpeedFeelGroup clip={clip} /> }] : []),
    ...lookSections,
  ];
  const textSection: Section = { id: "text", node: <TextGroup clip={clip} standalone={kind === "text"} /> };
  // A text layer's In and Out presets, under its text
  const animationSection: Section = { id: "animation", node: <TextAnimationGroup clip={clip} /> };
  const sections: Record<ClipKindId, Section[]> = {
    video: [clipSection, ...pictureSections, ...soundSections, textSection],
    audio: [clipSection, ...soundSections, timeSection],
    text: [textSection, animationSection, clipSection, ...pictureSections],
    adjustment: [clipSection, opacitySection, fadeSection, ...lookSections],
  };

  return (
    <ClipPanelContext value={panel}>
      <GroupsContext value={groups}>
        <RowLayoutContext value={rowLayout}>
          <FieldLockContext value={lock}>
            <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */
              ref={rootRef}
              // The panel keeps Delete while the focus is in it: there it removes the selected key, never the clip
              tabIndex={-1}
              data-keep-focus=""
              data-delete-keys=""
              style={sizes}
              className="flex min-h-0 flex-1 flex-col outline-none"
              onKeyDown={(event) => {
                if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented || isTextEntry(event.target)) return;
                event.preventDefault();
                if (event.repeat || !owned || !keyframe || (Boolean(owned.owner === clip ? lock : soundLock))) return;
                if (panel.perform(withoutKey(owned.property, keyframe.frame))) setSelection(null);
                panel.rest();
              }}
            >
              <ClipHeader
                clip={clip}
                kind={kind}
                others={Math.max(0, editor.selected.length - 1)}
                lanes={lanes}
                lanesBlocked={roomy ? null : t("面板不到 {width} px 寬，放不下關鍵影格軌道", { width: LANES_PANEL_WIDTH })}
                lock={lock}
                onToggleLanes={() => { setWantLanes(!wantLanes); }}
              />
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                <div className="relative min-h-full pb-2">
                  {lanes ? (
                    <>
                      <LaneBackdrop />
                      <div className="sticky top-0 z-20 grid h-6 grid-cols-[var(--ec-props)_minmax(0,1fr)] border-b border-line-subtle bg-surface">
                        <div className="flex min-w-0 items-center justify-end px-2">
                          <ClipTime />
                        </div>
                        <div className="relative min-w-0 bg-sunken">
                          <LaneRuler width={width - column} />
                          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-px bg-line-subtle" />
                        </div>
                      </div>
                    </>
                  ) : null}
                  {sections[kind].map((section, index) => (
                    <div key={section.id} ref={reveal(index)}>
                      {section.node}
                    </div>
                  ))}
                  {lanes ? <LanePlayhead /> : null}
                </div>
              </div>
              {selection && owned && keyframe ? (
                <FieldLockContext value={owned.owner === clip ? lock : soundLock}>
                  <KeyStrip key={selection.property} property={owned.property} owner={owned.owner} keyframe={keyframe} wide={roomy} />
                </FieldLockContext>
              ) : null}
            </div>
          </FieldLockContext>
        </RowLayoutContext>
      </GroupsContext>
    </ClipPanelContext>
  );
}
