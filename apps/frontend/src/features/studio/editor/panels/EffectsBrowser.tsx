// The Effects browser (a tab of the Project group, and the right dock of the Effects layout): a searchable tree of
// what can be applied. A double click or Enter applies an item to the selection: video transitions go on the cut at the
// end of the selected clip (or replace the selected transition), effects on every selected clip they fit, sound
// effects on the selected clips' sound. An item can also be dragged onto the timeline: an effect onto a clip, a
// transition onto an edit point (useEffectDrop). An item that cannot be applied to the selection says why in its
// tooltip; whether it can is worked out once per selection, not once per item (effectAvailabilities). Beside the search
// an adjustment layer can be added at the playhead: effects put on it change every track below it.
import { Search, SlidersHorizontal } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import type { StudioTimeline, TimelineClip } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import { usePersistentSet } from "@/lib/usePersistentSize";
import { localId } from "../../model/ids";
import { useEditor } from "../editorContext";
import { applyLabel, applyToClips } from "./effects/applyEffect";
import { EFFECT_CATEGORIES, EFFECT_ITEMS, effectAvailabilities, matchesEffect, type EffectAvailability, type EffectCategory, type EffectItem } from "./effects/catalog";
import { EffectTree, type EffectTreeGroup } from "./effects/EffectTree";

const ALL_OPEN: readonly string[] = EFFECT_CATEGORIES.map((category) => category.id);

function clipOf(timeline: StudioTimeline, clipId: string | null): TimelineClip | null {
  return clipId === null ? null : (timeline.clips.find((clip) => clip.clip_id === clipId) ?? null);
}

export function EffectsBrowser() {
  const editor = useEditor();
  const { timeline, linked, problem, selectedTransition } = editor;
  const clipId = editor.selectedClip?.clip_id ?? null;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = usePersistentSet("studio.nle.effects.open", ALL_OPEN);
  // Every item is tried on a copy of the timeline. That follows the document a beat behind, so an edit never waits for it
  const snapshot = useDeferredValue(timeline);
  const availability = useMemo(() => {
    if (problem) {
      const blocked: EffectAvailability = { reason: problem, applied: false, clipName: null };
      return new Map(EFFECT_ITEMS.map((item) => [item.id, blocked]));
    }
    return effectAvailabilities(EFFECT_ITEMS, { timeline: snapshot, clip: clipOf(snapshot, clipId), transitionClip: clipOf(snapshot, selectedTransition), linked });
  }, [snapshot, clipId, selectedTransition, linked, problem]);

  const searching = query.trim() !== "";
  const groups = EFFECT_CATEGORIES.flatMap((category): EffectTreeGroup[] => {
    const entries = EFFECT_ITEMS.filter((item) => item.category === category.id && matchesEffect(item, query)).flatMap((item) => {
      const state = availability.get(item.id);
      return state ? [{ item, availability: state }] : [];
    });
    // A search shows every match: a category without one leaves the tree, the others open
    if (searching && entries.length === 0) return [];
    return [{ category, entries, open: searching || open.has(category.id) }];
  });

  const toggle = (category: EffectCategory, next: boolean) => {
    if (searching) return;
    const ids = new Set(open);
    if (next) ids.add(category.id);
    else ids.delete(category.id);
    setOpen(ids);
  };
  /** The item's own plan for the selection: a transition on the selected clip's cut (or the selected transition), or why nothing applies. */
  const applyPlan = (item: EffectItem) => {
    const plan = item.plan({ timeline, clip: editor.selectedClip, transitionClip: clipOf(timeline, selectedTransition), linked }, localId);
    if (!plan.ok) {
      // Nothing was attempted: the reason of the tooltip, for those who chose the item with the keyboard
      editor.notify({ tone: "info", title: item.label, detail: plan.reason });
      return;
    }
    if (!editor.command(plan.command)) return;
    editor.notify({ tone: "success", title: t("已把「{effect}」套用到「{clip}」", { effect: item.label, clip: plan.clip.name }) });
  };
  /** An effect or preset on every selected clip it fits (the first selected clip decides, as Premiere does). */
  const applyToSelection = (item: EffectItem) => {
    const result = applyToClips(timeline, item, editor.selected, linked, localId);
    if (!result.ok) {
      editor.notify({ tone: "info", title: item.label, detail: result.error });
      return;
    }
    if (!editor.commit(result.value.timeline, applyLabel(item))) return;
    const { clips } = result.value;
    const only = clips[0];
    editor.notify({
      tone: "success",
      title:
        clips.length === 1 && only
          ? t("已把「{effect}」套用到「{clip}」", { effect: item.label, clip: only.name })
          : t("已把「{effect}」套用到 {count} 個片段", { effect: item.label, count: clips.length }),
    });
  };
  const apply = (item: EffectItem) => {
    if (problem) editor.warn(problem);
    else if (item.lands === "cut" || editor.selected.length === 0) applyPlan(item);
    else applyToSelection(item);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-keep-focus="" className="@container/fx flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            value={query}
            aria-label={t("搜尋效果")}
            placeholder={t("搜尋效果")}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || query === "") return;
              event.preventDefault();
              setQuery("");
            }}
          />
        </div>
        <Button
          size="sm"
          icon={<SlidersHorizontal aria-hidden />}
          aria-label={t("新增調整圖層")}
          title={t("在播放頭新增調整圖層：放在它上面的效果會套用到下方所有軌道")}
          onClick={editor.addAdjustmentLayer}
          className="px-2 @[20rem]/fx:px-3"
        >
          <span className="hidden @[20rem]/fx:inline">{t("新增調整圖層")}</span>
        </Button>
      </div>
      {groups.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <EmptyState
            size="compact"
            icon={<Search />}
            title={t("沒有符合的效果")}
            action={
              <Button size="sm" onClick={() => setQuery("")}>
                {t("清除搜尋")}
              </Button>
            }
          />
        </div>
      ) : (
        <EffectTree label={t("效果與轉場")} groups={groups} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggle} onApply={apply} />
      )}
    </div>
  );
}
