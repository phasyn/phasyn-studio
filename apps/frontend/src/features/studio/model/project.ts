// Studio 專案文件的純邏輯：建立、編輯（reducer）、鏡頭狀態。專案只保存使用者的編輯狀態與 run 參照，
// 事實來源仍是 run 與 recording（take 的結果由 run 讀回後填入）。
import type { StudioExport, StudioLibraryItem, StudioProject, StudioShot, StudioTake } from "@/api/generated/contracts";
import { withoutShot } from "../editor/shotRemoval";
import { continuityChange } from "./continuity";
import { DEFAULT_FRAMES, H3_FPS } from "./frames";
import { localId } from "./ids";
import { withoutLibraryItem } from "./library";
import { UNASSIGNED_ROUTE } from "./routes";
import { sameTakeReferences, takeReferences } from "./takeRefs";
import { t } from "@/i18n";
import { samePlugins } from "./promptPlugins";

export type TakeState = StudioTake["state"];
export type ShotPatch = Partial<
  Pick<
    StudioShot,
    | "title"
    | "prompt"
    | "frames"
    | "seed"
    | "seed_locked"
    | "route"
    | "steps"
    | "video_shift"
    | "audio_shift"
    | "note"
    | "continuity"
    | "references"
  >
>;
/**
 * What a new shot may also state: the part of its take the film shows and its outgoing transition (the character-swap
 * planner's kept range and crossfade). The Controller turns them into the shot's clip when it places the shot; from
 * then on only the clip carries the edit, and nothing here reads a shot's own trim or effects.
 */
export type NewShotFields = ShotPatch & Partial<Pick<StudioShot, "shot_id" | "in_frame" | "out_frame" | "effects">>;

export const MAX_SHOTS = 500;
export const MAX_TAKES = 200;
export const MAX_EXPORTS = 200;
export const MAX_LIBRARY_ITEMS = 500;
/** Contract StudioProject.prompt_plugins maxItems (the registry's limits.max_project_plugins is the same number). */
export const MAX_PROMPT_PLUGINS = 8;
export const MAX_SEED = 2_147_483_647;
/** StudioShot.seed：-1＝每次渲染隨機選一個 seed（實際值記在 take.seed）。 */
export const RANDOM_SEED = -1;

export interface FormatPreset {
  id: string;
  width: number;
  height: number;
  label: string;
}

export const FORMAT_PRESETS: readonly FormatPreset[] = [
  { id: "768x448", width: 768, height: 448, label: t("橫幅 768×448") },
  { id: "448x768", width: 448, height: 768, label: t("直幅 448×768") },
  { id: "640x640", width: 640, height: 640, label: t("方形 640×640") },
  { id: "1024x576", width: 1024, height: 576, label: t("橫幅 1024×576") },
  { id: "1280x704", width: 1280, height: 704, label: t("橫幅 1280×704") },
  { id: "1280x736", width: 1280, height: 736, label: t("橫幅 1280×736（裁切成 720P）") },
];

/**
 * 自訂畫面尺寸的單邊規則：StudioProject.format 的 width／height（contracts/component.schema.json：32–4096、32 的倍數），
 * 與 H3 runtime 的 width／height 參數範圍相同（runtimes/h3 config）。
 */
export const FORMAT_SIDE = { min: 32, max: 4096, multiple: 32 } as const;

/** 目前尺寸對應的預設（不是預設時為 null＝自訂）。 */
export function formatPresetOf(width: number, height: number): FormatPreset | null {
  return FORMAT_PRESETS.find((preset) => preset.width === width && preset.height === height) ?? null;
}

/** 最接近的合法單邊（四捨五入到 32 的倍數，再夾到 32–4096）。 */
export function snapFormatSide(value: number): number {
  if (!Number.isFinite(value)) return FORMAT_SIDE.min;
  const snapped = Math.round(value / FORMAT_SIDE.multiple) * FORMAT_SIDE.multiple;
  return Math.min(FORMAT_SIDE.max, Math.max(FORMAT_SIDE.min, snapped));
}

/** 單邊的問題（說明原因）；合法時 null。不默默改值：呼叫端顯示原因與最接近的合法值。 */
export function formatSideProblem(value: number, label: string): string | null {
  const { min, max, multiple } = FORMAT_SIDE;
  if (!Number.isFinite(value)) return t("{label}必須是數字", { label });
  if (!Number.isInteger(value)) return t("{label}必須是整數", { label });
  if (value < min || value > max) return t("{label}須介於 {min}–{max}", { label, min, max });
  if (value % multiple !== 0) return t("{label}必須是 {multiple} 的倍數（最接近的是 {snapSide}）", { label, multiple, snapSide: snapFormatSide(value) });
  return null;
}

/** 自訂畫面尺寸的問題（先寬後高）；合法時 null。 */
export function formatProblem(width: number, height: number): string | null {
  return formatSideProblem(width, t("寬度")) ?? formatSideProblem(height, t("高度"));
}

/** 匯出尺寸（StudioProject.export_format）；渲染尺寸仍是 format。 */
export type ExportFormat = NonNullable<StudioProject["export_format"]>;
export type ExportFit = ExportFormat["fit"];

export interface ExportSizePreset {
  id: string;
  width: number;
  height: number;
  label: string;
}

export const EXPORT_SIZE_PRESETS: readonly ExportSizePreset[] = [
  { id: "720p", width: 1280, height: 720, label: t("720P") },
  { id: "1080p", width: 1920, height: 1080, label: t("1080P") },
];

/** 匯出的尺寸與縮放方式：沒有 export_format 時就是渲染尺寸（fit 為 undefined＝請求不帶 fit，與以前完全相同）。 */
export function exportGeometry(project: StudioProject): { width: number; height: number; fit: ExportFit | undefined } {
  const format = project.export_format;
  if (!format) return { width: project.format.width, height: project.format.height, fit: undefined };
  return { width: format.width, height: format.height, fit: format.fit };
}

export { localId };

export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) & MAX_SEED;
}

export function newProject(title: string, options: { width?: number; height?: number; frames?: number; route?: string } = {}): StudioProject {
  const now = new Date().toISOString();
  return {
    project_id: localId("p"),
    title: title.trim() || t("未命名專案"),
    revision: 0,
    created_at: now,
    updated_at: now,
    format: { width: options.width ?? 768, height: options.height ?? 448, fps: { num: H3_FPS, den: 1 } },
    defaults: { frames: options.frames ?? DEFAULT_FRAMES, route: options.route ?? UNASSIGNED_ROUTE, steps: null },
    shots: [],
    exports: [],
  };
}

export function newShot(project: StudioProject, patch: NewShotFields = {}): StudioShot {
  return {
    shot_id: localId("s"),
    title: t("鏡頭 {shotsCount}", { shotsCount: project.shots.length + 1 }),
    prompt: "",
    frames: project.defaults.frames,
    seed: RANDOM_SEED,
    seed_locked: false,
    route: project.defaults.route,
    steps: project.defaults.steps,
    video_shift: null,
    audio_shift: null,
    enabled: true,
    in_frame: 0,
    out_frame: null,
    takes: [],
    active_take_id: null,
    note: "",
    ...patch,
  };
}

/**
 * What a new shot takes over from the shot it is added after: the same characters (its references, so @Image1 still
 * names the same picture) and its length. The prompt, takes, first frame, seed, notes and route stay new.
 */
export function continuedShotFields(previous: StudioShot | null | undefined): NewShotFields {
  if (!previous) return {};
  return { frames: previous.frames, ...(previous.references?.length ? { references: structuredClone(previous.references) } : {}) };
}

export type ProjectAction =
  | { type: "patchTimelineSource"; sourceId: string; patch: Partial<NonNullable<StudioProject["timeline"]>["sources"][number]> }
  | { type: "setTimeline"; timeline: NonNullable<StudioProject["timeline"]> }
  | { type: "rename"; title: string }
  | { type: "setFormat"; width: number; height: number }
  /** 匯出尺寸；null＝與渲染尺寸相同（移除欄位）。 */
  | { type: "setExportFormat"; exportFormat: ExportFormat | null }
  /** 專案的 Prompt 插件（id 依選取順序；空陣列＝移除欄位）。 */
  | { type: "setPromptPlugins"; plugins: string[] }
  | { type: "setDefaults"; patch: Partial<StudioProject["defaults"]> }
  /** 素材庫（參考圖片／影片／聲音）整份替換；超過上限時不變。 */
  | { type: "setLibrary"; library: StudioLibraryItem[] }
  /**
   * 把素材接在素材庫最後（上傳完成、從其他專案加入）：接在套用當下的素材庫後面，所以同時完成的幾筆不會互相蓋掉。
   * item_id 已在素材庫的略過；加上之後超過上限時整批不加、素材庫不變（與 setLibrary 同一條規則）。
   */
  | { type: "addLibraryItems"; items: StudioLibraryItem[] }
  /** 從素材庫移除一個素材（不刪除檔案）；還有影片鏡頭或 Image Studio 圖片使用它時不變（見 model/library）。 */
  | { type: "removeLibraryItem"; itemId: string }
  | { type: "addShot"; shot: StudioShot; afterShotId?: string | null }
  /** newTakeId：一併複製使用中且可播放的 take（同一個 run 輸出、新的 take_id），複本可直接播放。 */
  | { type: "duplicateShot"; shotId: string; newShotId: string; newTakeId?: string }
  | { type: "updateShot"; shotId: string; patch: ShotPatch }
  | { type: "removeShot"; shotId: string }
  | { type: "moveShot"; shotId: string; toIndex: number }
  | { type: "reorderShots"; order: string[] }
  /** adoptSeed：改用這個 take 時，固定 seed 的鏡頭一併採用它的 seed（選定變體後重新渲染可重現）；seed -1（每次隨機）保持不變。 */
  | { type: "setActiveTake"; shotId: string; takeId: string | null; adoptSeed?: boolean }
  | { type: "addTakes"; takes: { shotId: string; take: StudioTake }[] }
  | { type: "updateTake"; runId: string; outputKey: string; patch: Partial<StudioTake>; activateOnSuccess?: boolean }
  | { type: "removeTake"; shotId: string; takeId: string }
  | { type: "addExport"; record: StudioExport }
  | { type: "updateExport"; runId: string; patch: Partial<StudioExport> }
  | { type: "removeExport"; exportId: string };

function hasShot(project: StudioProject, shotId: string): boolean {
  return project.shots.some((shot) => shot.shot_id === shotId);
}

function mapShot(project: StudioProject, shotId: string, fn: (shot: StudioShot) => StudioShot): StudioProject {
  let changed = false;
  const shots = project.shots.map((shot) => {
    if (shot.shot_id !== shotId) return shot;
    const next = fn(shot);
    changed ||= next !== shot;
    return next;
  });
  return changed ? { ...project, shots } : project;
}

/** 純函式；不合法或無效的動作回傳原物件（呼叫端據此判斷是否需要保存）。 */
/** The copy "duplicate shot" makes (with the playable active take when a take id is given); null when it cannot be made. */
export function duplicatedShot(project: StudioProject, shotId: string, newShotId: string, newTakeId?: string): StudioShot | null {
  const source = project.shots.find((shot) => shot.shot_id === shotId);
  if (!source || project.shots.length >= MAX_SHOTS || hasShot(project, newShotId)) return null;
  const take = playableTake(source);
  const takes = take && newTakeId ? [{ ...take, take_id: newTakeId }] : [];
  // The copy is a new shot of the same generation settings: the edit of the original stays with its clips. It starts
  // off the timeline (an enabled shot that never had a place would be appended after the last clip, lengthening the
  // film); 加入時間軸 places it where the editor wants it.
  const { effects: _effects, ...settings } = source;
  return {
    ...settings,
    shot_id: newShotId,
    title: t("{title}（複本）", { title: source.title }).slice(0, 200),
    enabled: false,
    in_frame: 0,
    out_frame: null,
    takes,
    active_take_id: takes[0]?.take_id ?? null,
  };
}

export function projectReducer(project: StudioProject, action: ProjectAction): StudioProject {
  switch (action.type) {
    case "patchTimelineSource":
      return project.timeline ? { ...project, timeline: { ...project.timeline, sources: project.timeline.sources.map((source) => source.source_id === action.sourceId ? { ...source, ...action.patch } : source) } } : project;
    case "setTimeline":
      return project.timeline === action.timeline ? project : { ...project, timeline: action.timeline };
    case "rename": {
      const title = action.title.trim();
      return title && title !== project.title ? { ...project, title: title.slice(0, 200) } : project;
    }
    case "setFormat":
      return { ...project, format: { ...project.format, width: action.width, height: action.height } };
    case "setPromptPlugins": {
      const next = [...new Set(action.plugins)].slice(0, MAX_PROMPT_PLUGINS);
      const current = project.prompt_plugins ?? [];
      if (next.length === current.length && next.every((id, index) => id === current[index])) return project;
      if (next.length === 0) {
        const { prompt_plugins: _removed, ...rest } = project;
        return rest;
      }
      return { ...project, prompt_plugins: next };
    }
    case "setExportFormat": {
      if (action.exportFormat === null) {
        if (!project.export_format) return project;
        const { export_format: _removed, ...rest } = project;
        return rest;
      }
      const current = project.export_format;
      const next = action.exportFormat;
      if (current && current.width === next.width && current.height === next.height && current.fit === next.fit) return project;
      return { ...project, export_format: { width: next.width, height: next.height, fit: next.fit } };
    }
    case "setDefaults":
      return { ...project, defaults: { ...project.defaults, ...action.patch } };
    case "setLibrary":
      return action.library === project.library || action.library.length > MAX_LIBRARY_ITEMS ? project : { ...project, library: action.library };
    case "addLibraryItems": {
      const library = project.library ?? [];
      const known = new Set(library.map((item) => item.item_id));
      const fresh: StudioLibraryItem[] = [];
      for (const item of action.items) {
        // A repeated id in the same batch is the same item: only its first copy joins
        if (known.has(item.item_id)) continue;
        known.add(item.item_id);
        fresh.push(item);
      }
      return fresh.length === 0 || library.length + fresh.length > MAX_LIBRARY_ITEMS ? project : { ...project, library: [...library, ...fresh] };
    }
    case "removeLibraryItem":
      return withoutLibraryItem(project, action.itemId);
    case "addShot": {
      if (project.shots.length >= MAX_SHOTS) return project;
      const index = action.afterShotId ? project.shots.findIndex((shot) => shot.shot_id === action.afterShotId) : -1;
      const shots = [...project.shots];
      shots.splice(index >= 0 ? index + 1 : shots.length, 0, action.shot);
      return { ...project, shots };
    }
    case "duplicateShot": {
      const copy = duplicatedShot(project, action.shotId, action.newShotId, action.newTakeId);
      if (!copy) return project;
      const shots = [...project.shots];
      shots.splice(project.shots.findIndex((shot) => shot.shot_id === action.shotId) + 1, 0, copy);
      return { ...project, shots };
    }
    case "updateShot":
      return mapShot(project, action.shotId, (shot) => {
        // 沒有實際改變（例如編輯器回呼同樣的值）時不產生新文件，免得觸發自動保存
        if ((Object.keys(action.patch) as (keyof ShotPatch)[]).every((key) => shot[key] === action.patch[key])) return shot;
        return { ...shot, ...action.patch };
      });
    case "removeShot": {
      const shots = project.shots.filter((shot) => shot.shot_id !== action.shotId);
      if (shots.length === project.shots.length) return project;
      // The shot leaves the film with it; clips a locked track keeps stay as plain media (the dialog says so first)
      const timeline = project.timeline ? withoutShot(project.timeline, action.shotId) : null;
      return { ...project, shots, ...(timeline?.ok ? { timeline: timeline.value } : {}) };
    }
    case "moveShot": {
      const from = project.shots.findIndex((shot) => shot.shot_id === action.shotId);
      if (from < 0) return project;
      const to = Math.max(0, Math.min(project.shots.length - 1, action.toIndex));
      if (from === to) return project;
      const shots = [...project.shots];
      const [moved] = shots.splice(from, 1);
      if (!moved) return project;
      shots.splice(to, 0, moved);
      return { ...project, shots };
    }
    case "reorderShots": {
      const byId = new Map(project.shots.map((shot) => [shot.shot_id, shot]));
      if (action.order.length !== project.shots.length || new Set(action.order).size !== action.order.length) return project;
      const shots = action.order.map((id) => byId.get(id));
      if (shots.some((shot) => !shot)) return project;
      const ordered = shots as StudioShot[];
      return ordered.every((shot, index) => shot === project.shots[index]) ? project : { ...project, shots: ordered };
    }
    case "setActiveTake":
      return mapShot(project, action.shotId, (shot) => {
        const take = action.takeId ? shot.takes.find((item) => item.take_id === action.takeId) : undefined;
        const seed = action.adoptSeed && take && shot.seed !== RANDOM_SEED ? take.seed : shot.seed;
        if (shot.active_take_id === action.takeId && seed === shot.seed) return shot;
        return { ...shot, active_take_id: action.takeId, seed };
      });
    case "addTakes": {
      let next = project;
      for (const { shotId, take } of action.takes) {
        next = mapShot(next, shotId, (shot) => (shot.takes.length >= MAX_TAKES ? shot : { ...shot, takes: [...shot.takes, take] }));
      }
      return next;
    }
    case "updateTake": {
      let changed = false;
      const shots = project.shots.map((shot) => {
        const index = shot.takes.findIndex((take) => take.run_id === action.runId && take.output_key === action.outputKey);
        if (index < 0) return shot;
        const current = shot.takes[index];
        if (!current) return shot;
        const updated = { ...current, ...action.patch };
        const takes = [...shot.takes];
        takes[index] = updated;
        changed = true;
        const activate = action.activateOnSuccess && updated.state === "succeeded" && current.state !== "succeeded";
        return { ...shot, takes, active_take_id: activate ? updated.take_id : shot.active_take_id };
      });
      return changed ? { ...project, shots } : project;
    }
    case "removeTake":
      return mapShot(project, action.shotId, (shot) => ({
        ...shot,
        takes: shot.takes.filter((take) => take.take_id !== action.takeId),
        active_take_id: shot.active_take_id === action.takeId ? null : shot.active_take_id,
      }));
    case "addExport": {
      const exports = [...project.exports, action.record];
      return { ...project, exports: exports.slice(Math.max(0, exports.length - MAX_EXPORTS)) };
    }
    case "updateExport": {
      let changed = false;
      const exports = project.exports.map((record) => {
        if (record.run_id !== action.runId) return record;
        changed = true;
        return { ...record, ...action.patch };
      });
      return changed ? { ...project, exports } : project;
    }
    case "removeExport":
      return { ...project, exports: project.exports.filter((record) => record.export_id !== action.exportId) };
  }
}

/** 使用中的 take：明確選取的那個；沒有選取時用最新的成功 take。 */
export function activeTake(shot: StudioShot): StudioTake | null {
  const chosen = shot.active_take_id ? shot.takes.find((take) => take.take_id === shot.active_take_id) : undefined;
  if (chosen) return chosen;
  for (let i = shot.takes.length - 1; i >= 0; i -= 1) {
    const take = shot.takes[i];
    if (take?.state === "succeeded") return take;
  }
  return null;
}

export function latestTake(shot: StudioShot): StudioTake | null {
  return shot.takes.at(-1) ?? null;
}

/** 使用中且可以播放（成功、有 asset）的 take；沒有就是 null。 */
export function playableTake(shot: StudioShot): StudioTake | null {
  const take = activeTake(shot);
  return take?.state === "succeeded" && take.asset ? take : null;
}

/** 刪除鏡頭後要選取的鄰居：專案順序的下一個，沒有就上一個。 */
export function neighbourShotId(project: StudioProject, shotId: string): string | null {
  const index = project.shots.findIndex((shot) => shot.shot_id === shotId);
  if (index < 0) return null;
  return project.shots[index + 1]?.shot_id ?? project.shots[index - 1]?.shot_id ?? null;
}

/** 只列出與 take 不同的設定（用於「設定已變更」的說明）；空陣列＝一致。seed -1（每次隨機）時任何 seed 都算一致。 */
export function changedSinceTake(take: StudioTake, shot: StudioShot, project: StudioProject): string[] {
  const out: string[] = [];
  if (take.prompt !== shot.prompt) out.push("prompt");
  if (!samePlugins(take.prompt_plugins, project.prompt_plugins, take.prompt_plugin_revs)) out.push(t("Prompt 插件"));
  if (shot.seed !== RANDOM_SEED && take.seed !== shot.seed) out.push("seed");
  if (take.frames !== shot.frames) out.push(t("時長"));
  if (take.route !== shot.route) out.push(t("運算路由"));
  if (take.steps !== shot.steps) out.push(t("步數"));
  if (take.width !== project.format.width || take.height !== project.format.height) out.push(t("解析度"));
  // ref2va take：送出的參考素材（alias、檔案、裁切）與鏡頭目前的參考不同也算變更
  if (take.task === "ref2va" && !sameTakeReferences(take, takeReferences(shot.references ?? [], project.library ?? []))) out.push(t("參考素材"));
  const continuity = continuityChange(take, shot, project);
  if (continuity) out.push(continuity);
  return out;
}

/** take 的生成參數與鏡頭目前設定是否一致（不一致＝設定已改，需要重新渲染才會反映）。 */
export function takeMatchesShot(take: StudioTake, shot: StudioShot, project: StudioProject): boolean {
  return changedSinceTake(take, shot, project).length === 0;
}

/** cancelled／interrupted：最近一次的 take 被取消，或因 Controller 重新啟動而中斷——沒有完成，但不是失敗。 */
export type ShotStatus = "empty" | "rendering" | "ready" | "stale" | "failed" | "cancelled" | "interrupted";

export function shotStatus(shot: StudioShot, project: StudioProject): ShotStatus {
  if (shot.takes.some((take) => take.state === "rendering")) return "rendering";
  const active = activeTake(shot);
  if (active?.state === "succeeded" && active.asset) return takeMatchesShot(active, shot, project) ? "ready" : "stale";
  const latest = latestTake(shot);
  // 最近一次被取消或中斷時照實說（與 run 的狀態一樣），不說成失敗
  if (latest?.state === "cancelled" || latest?.state === "interrupted") return latest.state;
  if (latest && latest.state !== "succeeded") return "failed";
  return "empty";
}

export const SHOT_STATUS_LABELS: Record<ShotStatus, string> = {
  empty: t("未渲染"),
  rendering: t("渲染中"),
  ready: t("已渲染"),
  stale: t("設定已變更"),
  failed: t("渲染失敗"),
  cancelled: t("已取消"),
  interrupted: t("已中斷"),
};

const NEEDS_RENDER: ReadonlySet<ShotStatus> = new Set(["empty", "stale", "failed", "cancelled", "interrupted"]);

/** 鏡頭需要（重新）渲染：沒有符合目前設定的成功 take，且沒有進行中的 take（失敗、取消、中斷都算）。 */
export function needsRender(shot: StudioShot, project: StudioProject): boolean {
  return NEEDS_RENDER.has(shotStatus(shot, project));
}

export function allTakes(project: StudioProject): { shot: StudioShot; take: StudioTake }[] {
  return project.shots.flatMap((shot) => shot.takes.map((take) => ({ shot, take })));
}

/** 這個專案還在進行中的 run（渲染中的 take 與匯出）；同一個 run（批次、變體）只算一次。 */
export function runsInProgress(project: StudioProject): string[] {
  const ids = new Set<string>();
  for (const shot of project.shots) for (const take of shot.takes) if (take.state === "rendering") ids.add(take.run_id);
  for (const record of project.exports) if (record.state === "rendering") ids.add(record.run_id);
  for (const source of project.timeline?.sources ?? []) if (source.proxy_run_id && !source.proxy && !source.proxy_error) ids.add(source.proxy_run_id);
  return [...ids];
}

/** 工具列「渲染」分頁旁的進行中數量（渲染＋匯出）。 */
export function renderTaskCount(project: StudioProject): number {
  return runsInProgress(project).length;
}
