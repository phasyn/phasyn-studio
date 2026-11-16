// Image Studio 的契約型別：全部來自 contracts（x-phasyn-extension；ImageAsset／StudioImageShot／StudioImageTake／
// StudioLibraryItem.source 由 contracts/component.schema.json 定義，RunStepPreview＝RunStepState.preview）。
// 這裡只放方便用的別名，不加任何欄位。
import type { StudioImageShot, StudioImageTake, StudioLibraryItem, StudioProject } from "@/api/generated/contracts";

export type { ImageAsset, RunStepPreview, StudioImageShot, StudioImageTake } from "@/api/generated/contracts";

export type ImageMode = StudioImageShot["mode"];
export type SeedMode = StudioImageShot["seed_mode"];
export type SigmaSchedule = StudioImageShot["sigma_schedule"];
export type DecodeMode = StudioImageShot["decode"];
export type PreviewMode = StudioImageShot["preview"]["mode"];

/** 圖生圖的一張參考圖：專案素材庫的圖片（item_id）與它在送出順序中的位置（order）。 */
export type StudioImageReference = StudioImageShot["references"][number];

export type ImageTakeState = StudioImageTake["state"];

/** StudioLibraryItem.source（選用）：素材是 Image Studio 某個 take 加進來的，或使用者上傳的。 */
export type LibraryItemSource = NonNullable<StudioLibraryItem["source"]>;

export type ImageLibraryItem = StudioLibraryItem;

/** StudioProject（image_shots 為選用；舊專案沒有此欄位仍合法）。 */
export type ImageStudioProject = StudioProject;
