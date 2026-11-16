// 多個鏡頭一起換參考檔案（專案面板「鏡頭」多選的「換參考檔案…」）：選取的鏡頭用到的每個 @ 名稱（同名同類算一組）、它們
// 現在指向哪些檔案，以及為某些組選了新檔案後每個鏡頭的參考。每個參考都經過 replacedReference（與單一鏡頭「換成其他檔案」
// 同一條規則：@ 名稱、送出順序與原聲設定不變；影片與聲音的片段在新檔案放得下時保留，放不下或長度未知時回到整個檔案）；
// 已經指向那個檔案的參考原樣保留（片段也不動）。純函式。
import type { StudioLibraryItem, StudioReference, StudioShot } from "@/api/generated/contracts";
import { aliasOrdinal, clipFits, replacedReference, videoLibrary, type ReferenceKind } from "./materials";

/** The order of the shot's reference list (images, videos, sounds), the same as the @ completion. */
const KIND_ORDER: Readonly<Record<ReferenceKind, number>> = { image: 0, video: 1, audio: 2 };

/** One @ name as the shots use it: the alias with one kind (the same alias written with another kind is another group). */
export interface AliasGroup {
  key: string;
  alias: string;
  kind: ReferenceKind;
  /** The shots (ids, in the order given) that have a reference with this alias and kind. */
  shotIds: string[];
  /** The files it points at now, the most used first, with how many of those shots use each. */
  files: { itemId: string; shots: number }[];
}

function groupKey(alias: string, kind: ReferenceKind): string {
  return `${kind}:${alias}`;
}

/** Every @ name the shots use, grouped by alias and kind, in the order of a shot's reference list. */
export function aliasGroups(shots: readonly StudioShot[]): AliasGroup[] {
  const groups = new Map<string, { alias: string; kind: ReferenceKind; shotIds: string[]; files: Map<string, number> }>();
  for (const shot of shots) {
    // A shot counts once per group and once per file, also when it repeats an alias (validateReferences reports that)
    const inGroup = new Set<string>();
    const onFile = new Set<string>();
    for (const ref of shot.references ?? []) {
      const key = groupKey(ref.alias, ref.kind);
      const group = groups.get(key) ?? { alias: ref.alias, kind: ref.kind, shotIds: [], files: new Map<string, number>() };
      groups.set(key, group);
      if (!inGroup.has(key)) {
        inGroup.add(key);
        group.shotIds.push(shot.shot_id);
      }
      const file = `${key}\n${ref.item_id}`;
      if (!onFile.has(file)) {
        onFile.add(file);
        group.files.set(ref.item_id, (group.files.get(ref.item_id) ?? 0) + 1);
      }
    }
  }
  const rank = (alias: string) => aliasOrdinal(alias) ?? Number.MAX_SAFE_INTEGER;
  return [...groups]
    .map(([key, group]) => ({
      key,
      alias: group.alias,
      kind: group.kind,
      shotIds: group.shotIds,
      files: [...group.files].map(([itemId, shots]) => ({ itemId, shots })).sort((a, b) => b.shots - a.shots),
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || rank(a.alias) - rank(b.alias) || a.alias.localeCompare(b.alias));
}

/** The chosen files that can still be used: the group is there and the file is in the library (no Image Studio mask) with the group's kind. */
export function usablePicks(groups: readonly AliasGroup[], library: readonly StudioLibraryItem[], picks: ReadonlyMap<string, string>): Map<string, string> {
  const kinds = new Map(groups.map((group) => [group.key, group.kind]));
  const items = new Map(videoLibrary(library).map((item) => [item.item_id, item]));
  return new Map([...picks].filter(([key, itemId]) => {
    const kind = kinds.get(key);
    return kind !== undefined && items.get(itemId)?.kind === kind;
  }));
}

/** One shot's references before and after a replacement (復原 puts `before` back while the shot still has `references`). */
export interface ReplacedShot {
  shotId: string;
  before: StudioReference[];
  references: StudioReference[];
}

export interface ReplacementPlan {
  /** The shots whose references change (in the order given), with their references before and after. */
  shots: ReplacedShot[];
  /** For each chosen group: how many of its shots change (the others already point at the file). */
  changed: Map<string, number>;
  /** For each chosen group: how many of the changed shots lose their clip window (the new file does not hold it). */
  unclipped: Map<string, number>;
}

/**
 * What applying `picks` (group key → library item id) does to the shots; shots without a chosen group stay out.
 * `durations` holds the library files' lengths in seconds (a file missing there or without a length counts as unknown).
 */
export function replacementPlan(shots: readonly StudioShot[], picks: ReadonlyMap<string, string>, durations: ReadonlyMap<string, number | null>): ReplacementPlan {
  const out: ReplacedShot[] = [];
  const changed = new Map<string, number>();
  const unclipped = new Map<string, number>();
  for (const shot of shots) {
    const touched = new Set<string>();
    const cut = new Set<string>();
    const before = shot.references ?? [];
    const references = before.map((ref) => {
      const key = groupKey(ref.alias, ref.kind);
      const itemId = picks.get(key);
      if (itemId === undefined || itemId === ref.item_id) return ref;
      const duration = durations.get(itemId) ?? null;
      touched.add(key);
      if (!clipFits(ref, duration)) cut.add(key);
      return replacedReference(ref, itemId, duration);
    });
    if (touched.size === 0) continue;
    for (const key of touched) changed.set(key, (changed.get(key) ?? 0) + 1);
    for (const key of cut) unclipped.set(key, (unclipped.get(key) ?? 0) + 1);
    out.push({ shotId: shot.shot_id, before, references });
  }
  return { shots: out, changed, unclipped };
}

/** Whether two reference lists say the same (field by field, so a saved copy of the document still matches). */
export function sameReferences(a: readonly StudioReference[], b: readonly StudioReference[]): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        ref.ref_id === other.ref_id &&
        ref.kind === other.kind &&
        ref.alias === other.alias &&
        ref.item_id === other.item_id &&
        ref.start_seconds === other.start_seconds &&
        ref.end_seconds === other.end_seconds &&
        (ref.use_embedded_audio ?? null) === (other.use_embedded_audio ?? null) &&
        // Off is null, false or no field at all
        (ref.hold_last_frame === true) === (other.hold_last_frame === true)
      );
    })
  );
}
