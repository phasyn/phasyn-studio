// The Color dock of the Color layout: the basic colour correction of the selected clips on video tracks, with room
// for a slider beside every value. The same values are in the Color group of Effect Controls (one clip). With several
// clips selected, the dock shows the values of the clip in focus and a change of one value reaches every selected
// clip as one step of the history (the other values of each clip stay its own); 全部套用 gives every selected clip the
// focused clip's whole correction (grade one, then the rest) and 重設 takes all of them back.
import { CopyCheck, Palette, RotateCcw } from "lucide-react";
import type { TimelineClip } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/i18n";
import { useEditor } from "../editorContext";
import { applyClips, clipEdits, lockReason, type ClipEdits, type EditResult, type EditTarget } from "./controls/clipEdits";
import { colorChanged, withColor, withoutColor } from "./controls/clipLooks";
import { ColorRows } from "./controls/ColorRows";
import { DensityContext, FieldLockContext } from "./controls/controlsContext";
import { ChangedDot, TextButton } from "./controls/rows";

type Color = NonNullable<NonNullable<TimelineClip["effects"]>["color"]>;

/** Edits that take the colour change made on `shown` to every clip of `clips` (only the values that changed). */
function sharedColorEdits(target: EditTarget, warn: (reason: string) => void, shown: TimelineClip, clips: readonly TimelineClip[]): ClipEdits {
  const apply = (changed: TimelineClip): EditResult => {
    const after = changed.effects?.color;
    if (after === undefined) return applyClips(target, clips.map(withoutColor));
    const before: Color = shown.effects?.color ?? {};
    const change: Color = {};
    for (const key of Object.keys(after) as (keyof Color)[]) {
      if (after[key] !== before[key]) Object.assign(change, { [key]: after[key] });
    }
    return applyClips(target, clips.map((clip) => withColor(clip, change)));
  };
  return {
    apply,
    perform: (clip) => {
      const result = apply(clip);
      if (typeof result === "string") warn(result);
      return result === true;
    },
  };
}

function ClipColor({ clip, clips }: { clip: TimelineClip; clips: readonly TimelineClip[] }) {
  const editor = useEditor();
  const several = clips.length > 1;
  const lock = clips.map((item) => lockReason(editor.timeline, item, editor.linked)).find((reason) => reason !== null) ?? null;
  const edits = several ? sharedColorEdits(editor, editor.warn, clip, clips) : clipEdits(editor, editor.warn);
  const changed = clips.some(colorChanged);
  const names = clips.map((item) => item.name).join("\n");
  const same = clips.every((item) => JSON.stringify(item.effects?.color ?? {}) === JSON.stringify(clip.effects?.color ?? {}));
  const applyAll = () => {
    const color = clip.effects?.color;
    const result = applyClips(editor, clips.map((item) => (color ? withColor(withoutColor(item), color) : withoutColor(item))));
    if (typeof result === "string") editor.warn(result);
  };
  return (
    <DensityContext.Provider value="comfortable">
      <FieldLockContext.Provider value={lock}>
        <div data-keep-focus="" className="flex min-h-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
            <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={several ? names : clip.name}>
              {several ? t("{count} 個片段", { count: clips.length }) : clip.name}
            </h2>
            {changed ? <ChangedDot /> : null}
            <TextButton
              icon={<RotateCcw aria-hidden />}
              title={several ? t("選取的片段都回到原本的色彩") : t("回到原本的色彩")}
              disabledReason={lock ?? (changed ? null : t("已經是預設值"))}
              onClick={() => edits.perform(withoutColor(clip))}
            >
              {t("重設")}
            </TextButton>
          </header>
          {several ? (
            <div className="grid shrink-0 gap-1.5 border-b border-line-subtle px-3 py-2 animate-fade-in">
              <p className="text-caption text-fg-secondary" title={names}>
                {t("改動會一起套用到選取的 {count} 個片段；欄位顯示「{name}」的值", { count: clips.length, name: clip.name })}
              </p>
              <div className="justify-self-start">
                <TextButton
                  icon={<CopyCheck aria-hidden />}
                  title={t("讓選取的片段都用「{name}」的整組色彩", { name: clip.name })}
                  disabledReason={lock ?? (same ? t("選取的片段色彩都一樣") : null)}
                  onClick={applyAll}
                >
                  {t("全部套用這組色彩")}
                </TextButton>
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <ColorRows clip={clip} edits={edits} sliders />
          </div>
        </div>
      </FieldLockContext.Provider>
    </DensityContext.Provider>
  );
}

export function ColorDock() {
  const editor = useEditor();
  const pictures = editor.selected.flatMap((id) => {
    const clip = editor.timeline.clips.find((item) => item.clip_id === id);
    return clip && editor.trackOf(clip)?.kind === "video" ? [clip] : [];
  });
  const focus = pictures.find((clip) => clip.clip_id === editor.selectedClip?.clip_id) ?? pictures[0];
  if (!focus) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
        <EmptyState
          size="compact"
          icon={<Palette />}
          title={t("選取視訊軌上的片段")}
          description={t("亮度、對比、飽和度與負片會套用在選取的片段上；選取好幾個時一起調整。")}
        />
      </div>
    );
  }
  return <ClipColor key={pictures.map((clip) => clip.clip_id).join("|")} clip={focus} clips={pictures} />;
}
