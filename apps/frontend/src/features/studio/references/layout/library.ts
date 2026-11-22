// 無看鏡頭版面參考（選用，預設關閉）的內建片段庫。H3 Ref2VA 的角色會自己轉過來正面看鏡頭，prompt 的鏡位寫法壓不住；
// 給一段沒有人看鏡頭的短片當 @Video 版面參考、只跟它的分鏡順序、構圖與站位時，角色比較不會轉過來看鏡頭。
// 代價是構圖被參考支配（跟得越緊越不看鏡頭），所以鏡頭面板另有「照抄檢查」（./copyCheck）。
//
// 片段庫（./library.json）只列已審核的片段，以檔案的 SHA-256 認定：檔案本身不在 repository 裡，透過專案素材庫進到專案（上傳，
// 或把預演動畫加入素材庫）；素材庫裡 SHA-256 相同的影片就是那個片段。一個片段能列入的條件，載入時逐項檢查，不合格的不用：
//  - gaze_check.verdict＝no-camera-gaze：每一格都檢查過，沒有任何人正面朝向鏡頭（只看「有沒有人看鏡頭」，不看畫質）；
//  - site_safe＝true：沒有私人角色、沒有受版權保護的角色或畫面；
//  - provenance.kind 是自己做的站位：previs（Studio 的動態預演，人偶沒有臉）、reviewed_take（已審核的網站角色 take 片段），
//    或 hand_drawn（自己畫的分鏡動畫）。真實作品的站位可以學（用預演重新排一次），但片子本身永遠不放進來。
// 純資料與純函式。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";
import manifest from "./library.json";

export type LayoutShotSize = "wide" | "medium" | "close";
export type LayoutAction = "faceoff" | "charge" | "clash" | "chase" | "aftermath" | "solo_move";
export type LayoutProvenance = "previs" | "reviewed_take" | "hand_drawn";

export const SHOT_SIZES: readonly LayoutShotSize[] = ["wide", "medium", "close"];
export const ACTIONS: readonly LayoutAction[] = ["faceoff", "charge", "clash", "chase", "aftermath", "solo_move"];
const PROVENANCES: readonly LayoutProvenance[] = ["previs", "reviewed_take", "hand_drawn"];

/** 參考只用片段的前幾秒（預設 3 秒，不凍結最後一格）。 */
export const DEFAULT_SPAN_SECONDS = 3;
const MAX_SPAN_SECONDS = 15;
const MIN_SPAN_SECONDS = 2;

export interface LayoutClip {
  /** 片段庫內的 id（小寫、數字、連字號）。 */
  id: string;
  /** 檔案的 SHA-256（小寫 hex）：素材庫裡同一個檔案就是這個片段。 */
  sha256: string;
  /** 介面上的名稱（依語言分開的資料：zh-Hant、en、ja，與插件的文字一樣不進翻譯目錄）。 */
  title: Readonly<Partial<Record<"zh-Hant" | "en" | "ja", string>>>;
  shotSize: LayoutShotSize;
  action: LayoutAction;
  /** 畫面裡的角色數（1 或 2）。 */
  cast: 1 | 2;
  /** 參考使用的長度（秒，從片頭開始）。 */
  spanSeconds: number;
  provenance: LayoutProvenance;
  /** 誰、用什麼方法、何時檢查過每一格（自由文字，只在說明裡出現）。 */
  gazeCheck: string;
}

function member<T extends string>(values: readonly T[], value: unknown): T | null {
  return values.find((entry) => entry === value) ?? null;
}

/** 片段庫的一筆；格式不符或不符合列入條件 → null（不用）。 */
export function parseLayoutClip(raw: unknown): LayoutClip | null {
  if (!isRecord(raw)) return null;
  const { id, sha256, title, shot_size: size, action, cast, span_seconds: span, provenance, gaze_check: gaze, site_safe: safe } = raw;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const names = isRecord(title) ? Object.fromEntries((["zh-Hant", "en", "ja"] as const).flatMap((lang) => (typeof title[lang] === "string" && title[lang].trim() !== "" ? [[lang, title[lang].trim()]] : []))) : {};
  if (typeof names["zh-Hant"] !== "string") return null;
  const shotSize = member(SHOT_SIZES, size);
  const kind = member(ACTIONS, action);
  const origin = isRecord(provenance) ? member(PROVENANCES, provenance["kind"]) : null;
  if (!shotSize || !kind || !origin || (cast !== 1 && cast !== 2) || safe !== true) return null;
  if (!isRecord(gaze) || gaze["verdict"] !== "no-camera-gaze" || gaze["frames"] !== "all" || typeof gaze["by"] !== "string") return null;
  const spanSeconds = span === undefined ? DEFAULT_SPAN_SECONDS : span;
  if (typeof spanSeconds !== "number" || !(spanSeconds >= MIN_SPAN_SECONDS && spanSeconds <= MAX_SPAN_SECONDS)) return null;
  const checked = typeof gaze["at"] === "string" ? ` ${gaze["at"]}` : "";
  return { id, sha256, title: names, shotSize, action: kind, cast, spanSeconds, provenance: origin, gazeCheck: `${gaze["by"]}${checked}` };
}

/** 片段庫裡可以用的片段（不合格的略過；同一個 SHA-256 只用第一筆）。 */
export function parseLayoutLibrary(raw: unknown): LayoutClip[] {
  if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["clips"])) return [];
  const seen = new Set<string>();
  return raw["clips"].flatMap((entry) => {
    const clip = parseLayoutClip(entry);
    if (!clip || seen.has(clip.sha256)) return [];
    seen.add(clip.sha256);
    return [clip];
  });
}

export const BUILTIN_LAYOUT_CLIPS: readonly LayoutClip[] = parseLayoutLibrary(manifest);

/** 專案素材庫裡的一段影片對到的片段。 */
export interface LayoutCandidate {
  clip: LayoutClip;
  item: StudioLibraryItem;
}

/** 素材庫裡是片段庫片段的影片（依片段庫順序；同一個片段在素材庫有多份時用第一份）。 */
export function layoutCandidates(library: readonly StudioLibraryItem[], clips: readonly LayoutClip[] = BUILTIN_LAYOUT_CLIPS): LayoutCandidate[] {
  return clips.flatMap((clip) => {
    const item = library.find((entry) => entry.kind === "video" && entry.file.sha256 === clip.sha256);
    return item ? [{ clip, item }] : [];
  });
}

/**
 * 片段庫還缺的片段。每一段都要：每格沒有人朝向鏡頭、沒有私人或受版權保護的角色、自己的站位
 * （優先用 Studio 動態預演的人偶，人偶沒有臉，也最不會被照抄細節）；長 3–4 秒、1280x736 或 736x1280、24 fps、沒有聲音、
 * 片段內沒有硬切。景別 × 動作各一段，雙人戲另備一段單人。
 */
export const NEEDED_LAYOUT_CLIPS: readonly { shotSize: LayoutShotSize; action: LayoutAction; cast: 1 | 2; staging: string }[] = [
  { shotSize: "wide", action: "faceoff", cast: 2, staging: "two fighters in three-quarter back view and profile, turned toward each other across the depth of the frame" },
  { shotSize: "medium", action: "charge", cast: 2, staging: "over-the-shoulder from behind the defender; the attacker runs in from the deep background at the defender" },
  { shotSize: "close", action: "clash", cast: 2, staging: "close shot at the point of contact, both heads in profile, blades or fists meeting between them" },
  { shotSize: "medium", action: "clash", cast: 2, staging: "low angle, both in profile at mid depth, exchanging blows across the frame diagonal" },
  { shotSize: "wide", action: "chase", cast: 2, staging: "high angle following both along a street or rooftop, the pursuer behind the target" },
  { shotSize: "wide", action: "aftermath", cast: 2, staging: "high angle looking down; one is knocked into the background, the other turns toward them" },
  { shotSize: "medium", action: "solo_move", cast: 1, staging: "one character running and reaching after a moving target (a bird, a drifting lantern), head turned to it" },
  { shotSize: "wide", action: "solo_move", cast: 1, staging: "back view walking into a wide landscape that opens up ahead" },
];
