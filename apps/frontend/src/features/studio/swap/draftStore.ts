import { isFileRef } from "@/api/types";
// The swap wizard's unfinished draft, kept in this browser (localStorage), so a reload, a new deploy or opening another
// project does not throw away a long setup (a 40-segment film is minutes of ticking characters per segment). There is
// one draft per browser, as there is one wizard: it makes a new project whichever project is open. What cannot be kept
// is left out, and the wizard says so when it restores: an image picked from this computer (the file itself; a library
// image is kept by reference and checked again), the white copy of a transparent image (made again by that check) and
// an upload still in progress. The cut detection is kept as its run, which the wizard reads back from the Controller.
// The draft is cleared when its project has been created (useSwapCreate) or the person starts over.
import { useEffect } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { isFiniteNumber, isListed, isRecord } from "@/lib/json";
import { newLocalId } from "../references/ids";
import { STEP_IDS, initialDraft, type DraftCharacter, type SwapDraft } from "./draft";

const KEY = "phasyn.studio.swap.draft";
/** Saving waits this long after the last change (typing a note saves once). */
const SAVE_DELAY_MS = 400;

/** The cut detection a draft used: the probe run, read back from the Controller after a restore. */
export interface SavedDetection {
  runId: string;
  sourceKey: string;
  createdAt: string;
}

export interface SavedImage {
  name: string;
  file: FileRef;
  width: number | null;
  height: number | null;
}

export interface SavedCharacter extends Omit<DraftCharacter, "image"> {
  /** A library image (kept by reference); null when there was none. */
  image: SavedImage | null;
  /** The name of an image picked from this computer, which is not kept. */
  localImage: string | null;
}

export interface SavedDraft {
  v: 1;
  savedAt: string;
  draft: Omit<SwapDraft, "sourceUpload" | "characters"> & { characters: SavedCharacter[] };
  detection: SavedDetection | null;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the draft holds anything worth keeping (a chosen source video). */
export function draftWorthKeeping(draft: SwapDraft): boolean {
  return draft.source !== null;
}

export function saveDraft(draft: SwapDraft, detection: SavedDetection | null, now = new Date()): void {
  const store = storage();
  if (!store) return;
  const { sourceUpload: _upload, characters, ...rest } = draft;
  const saved: SavedDraft = {
    v: 1,
    savedAt: now.toISOString(),
    draft: {
      ...rest,
      characters: characters.map(({ image, ...character }) => ({
        ...character,
        image: image?.origin.kind === "library" ? { name: image.name, file: image.origin.file, width: image.width, height: image.height } : null,
        localImage: image?.origin.kind === "local" ? image.name : null,
      })),
    },
    detection: detection && detection.sourceKey === draft.source?.key ? detection : null,
  };
  try {
    store.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Storage full or blocked: the draft simply lives in memory for this page
  }
}

export function clearDraft(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function savedSource(value: unknown): value is NonNullable<SwapDraft["source"]> {
  return isRecord(value) && typeof value["key"] === "string" && typeof value["name"] === "string" && isFileRef(value["file"])
    && nullableNumber(value["width"]) && nullableNumber(value["height"]) && nullableNumber(value["duration_seconds"])
    && (value["has_audio"] === null || typeof value["has_audio"] === "boolean");
}

function savedImage(value: unknown): value is SavedImage {
  return isRecord(value) && typeof value["name"] === "string" && isFileRef(value["file"]) && nullableNumber(value["width"]) && nullableNumber(value["height"]);
}

function savedCharacter(value: unknown): value is SavedCharacter {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["who"] === "string" && typeof value["appearance"] === "string"
    && typeof value["mustNot"] === "string" && (value["localImage"] === null || typeof value["localImage"] === "string")
    && (value["image"] === null || savedImage(value["image"]));
}

function savedDraft(value: unknown): value is SavedDraft["draft"] {
  if (!isRecord(value) || !savedSource(value["source"]) || !Array.isArray(value["characters"]) || !value["characters"].every(savedCharacter)) return false;
  const scene = value["scene"];
  return isListed(value["step"], STEP_IDS) && isFiniteNumber(value["startSeconds"]) && nullableNumber(value["endSeconds"])
    && typeof value["style"] === "string" && typeof value["dialogueLanguage"] === "string" && isRecord(scene) && isFiniteNumber(scene["threshold"]) && isFiniteNumber(scene["min_gap_seconds"])
    && typeof value["skipDetection"] === "boolean" && textList(value["disabledCuts"]) && Array.isArray(value["manualCuts"])
    && value["manualCuts"].every((item: unknown) => isRecord(item) && typeof item["id"] === "string" && isFiniteNumber(item["seconds"]))
    && nullableNumber(value["maxFrames"]) && typeof value["trial"] === "boolean" && isFiniteNumber(value["crossfade"]) && typeof value["holdTail"] === "boolean"
    && isRecord(value["notes"]) && Object.values(value["notes"]).every((entry) => typeof entry === "string")
    && isRecord(value["absent"]) && Object.values(value["absent"]).every(textList) && typeof value["title"] === "string" && typeof value["titleEdited"] === "boolean"
    && (value["routeId"] === null || typeof value["routeId"] === "string") && typeof value["format"] === "string"
    && (value["audio"] === "original" || value["audio"] === "generated") && typeof value["autoExport"] === "boolean" && typeof value["startRender"] === "boolean"
    && (value["plugins"] === null || textList(value["plugins"]));
}

/** The kept draft; null when there is none or it does not read back (an older shape, damaged data). */
export function loadDraft(): SavedDraft | null {
  let raw: unknown;
  try {
    const text = storage()?.getItem(KEY);
    if (!(text != null && text !== "")) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["v"] !== 1 || typeof raw["savedAt"] !== "string" || !isRecord(raw["draft"])) return null;
  // Fields added after a draft was saved take the current defaults before validation.
  const { sourceUpload: _upload, characters: _characters, ...base } = initialDraft();
  const stored = raw["draft"];
  if (!Array.isArray(stored["characters"])) return null;
  const characters = stored["characters"].map((value: unknown) => isRecord(value)
    ? { who: "", appearance: "", mustNot: "", image: null, localImage: null, ...value } : value);
  const draft = { ...base, ...stored, characters };
  if (!savedDraft(draft)) return null;
  const item = raw["detection"];
  const detection = isRecord(item) && typeof item["runId"] === "string" && typeof item["sourceKey"] === "string" && typeof item["createdAt"] === "string"
    ? { runId: item["runId"], sourceKey: item["sourceKey"], createdAt: item["createdAt"] } : null;
  return { v: 1, savedAt: raw["savedAt"], draft, detection };
}

/**
 * The wizard's draft from a kept one: a library image comes back as being checked (useSwapDraft checks it again and
 * makes its white copy again), a character whose image came from this computer waits for a new one.
 */
export function draftFromSaved(saved: SavedDraft): SwapDraft {
  return {
    ...saved.draft,
    sourceUpload: null,
    characters: saved.draft.characters.map(({ image, localImage: _local, ...character }) => ({
      ...character,
      image: image
        ? { key: newLocalId("img"), name: image.name, origin: { kind: "library", file: image.file }, previewUrl: mediaUrl(image.file.node_id, image.file.file_id), width: image.width, height: image.height, check: "checking", error: null, matte: null, matteUrl: null }
        : null,
    })),
  };
}

/** The names of the character images that came from this computer and have to be picked again. */
export function lostImages(saved: SavedDraft): string[] {
  return saved.draft.characters.flatMap((character) => ((character.localImage != null && character.localImage !== "") ? [character.localImage] : []));
}

/** Keeps the draft shortly after every change, and right away when the page goes away (a reload, a closed tab). */
export function useDraftAutosave(draft: SwapDraft, detection: SavedDetection | null): void {
  useEffect(() => {
    if (!draftWorthKeeping(draft)) return;
    const save = () => { saveDraft(draft, detection); };
    const timer = window.setTimeout(save, SAVE_DELAY_MS);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [draft, detection]);
}
