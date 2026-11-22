import { optionalField } from "@/lib/json";
// take 的動作（監看器工具列與 take 格子的選單共用）：設為使用中、比較、下載原圖／白底版、加入素材庫（白底版）、
// 用在影片鏡頭、載入這組參數、用這組參數新增圖片、封存、永久刪除。每個寫入只送一次；不能做時選項保持可聚焦並寫出原因。
import { Archive, ArchiveRestore, Clapperboard, Columns2, CopyPlus, Download, FolderPlus, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { MenuItem } from "@/components/ui/menuModel";
import { useImageStudio } from "../imageStudioContext";
import { maskDrafts } from "../hooks/maskDrafts";
import { loadParamsPatch } from "../model/params";
import { whiteItemId } from "../model/reconcile";
import { takeLibraryItem, whiteLibraryItem } from "../model/sendToVideo";
import { activeImageTake, localId, takeNumber } from "../model/shots";
import type { ImageAsset, StudioImageShot, StudioImageTake } from "../types";
import { fileUrl } from "./display";
import { t } from "@/i18n";

function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "image";
}

/** 下載檔名：「圖片 1-take3-seed42.png」「…（白底）.png」。 */
export function downloadName(shot: StudioImageShot, take: StudioImageTake, white: boolean): string {
  return `${safeName(shot.title || "image")}-take${String(takeNumber(shot, take.take_id))}-seed${String(take.seed)}${white ? t("（白底）") : ""}.png`;
}

function downloadAsset(asset: ImageAsset, name: string) {
  const url = fileUrl(asset.file);
  if (!(url != null && url !== "")) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function useTakeActions() {
  const { project, dispatch, notify, selectTake, selectedTakeId, compareTakeId, setCompareTakeId, setSendTarget, archivedRunIds, setRunArchived, deleteRuns, selectShot } = useImageStudio();
  const library = useMemo(() => project.library ?? [], [project.library]);

  const addToLibrary = useCallback(
    (shot: StudioImageShot, take: StudioImageTake) => {
      const result = whiteLibraryItem(project, shot, take, whiteItemId(take), new Date().toISOString());
      if (!result.item) {
        notify({ tone: "warning", title: t("沒有加入素材庫"), detail: result.problem });
        return;
      }
      if (result.existing) {
        notify({ tone: "info", title: t("已在素材庫：「{name}」", { name: result.item.name }) });
        return;
      }
      dispatch({ type: "addLibraryItems", items: [result.item] });
      notify({ tone: "success", title: t("已加入專案素材庫：「{name}」", { name: result.item.name }), detail: t("加入的是白底版；Video Studio 的參考素材可以直接選它。") });
    },
    [dispatch, notify, project],
  );

  const loadParams = useCallback(
    (shot: StudioImageShot, take: StudioImageTake) => {
      const loaded = loadParamsPatch(take, library);
      if (!loaded) {
        notify({ tone: "warning", title: t("這個 take 沒有可讀的參數紀錄"), detail: t("舊資料或別處寫入的 take；沒有套用任何設定。") });
        return;
      }
      const dropped = maskDrafts.has(shot.image_shot_id) && loaded.patch.mode === "i2i";
      if (dropped) maskDrafts.clear(shot.image_shot_id);
      dispatch({ type: "updateImageShot", shotId: shot.image_shot_id, patch: loaded.patch });
      const notes = [...loaded.warnings, ...(dropped ? [t("未保存的遮罩草稿已捨棄（改用這個 take 的遮罩）")] : [])];
      notify({ tone: notes.length > 0 ? "warning" : "info", title: t("已載入 take {takeNumber} 的參數", { takeNumber: takeNumber(shot, take.take_id) }), detail: notes.length > 0 ? notes.join(t("；")) : t("seed {seed}、生成 1 張；按「生成」就能重現。", { seed: take.seed }) });
    },
    [dispatch, library, notify],
  );

  const newShotFromParams = useCallback(
    (shot: StudioImageShot, take: StudioImageTake) => {
      const loaded = loadParamsPatch(take, library);
      if (!loaded) {
        notify({ tone: "warning", title: t("這個 take 沒有可讀的參數紀錄") });
        return;
      }
      const id = localId("i");
      dispatch({ type: "duplicateImageShot", shotId: shot.image_shot_id, newShotId: id, title: t("{value}・take {takeNumber}", { value: shot.title || t("圖片"), takeNumber: takeNumber(shot, take.take_id) }), patch: loaded.patch });
      selectShot(id);
      notify({ tone: loaded.warnings.length > 0 ? "warning" : "info", title: t("已用這組參數新增一張圖片"), ...optionalField("detail", loaded.warnings.join(t("；")) || undefined) });
    },
    [dispatch, library, notify, selectShot],
  );

  const menuItems = useCallback(
    (shot: StudioImageShot, take: StudioImageTake): MenuItem[] => {
      const done = take.state === "succeeded" && take.image !== null;
      const active = activeImageTake(shot)?.take_id === take.take_id;
      const inLibrary = takeLibraryItem(library, shot.image_shot_id, take);
      const archived = archivedRunIds.has(take.run_id);
      const rendering = take.state === "rendering";
      const viewing = selectedTakeId === take.take_id;
      const comparing = compareTakeId === take.take_id;
      const sameRun = shot.takes.filter((item) => item.run_id === take.run_id).length;
      return [
        {
          id: "active",
          label: active ? t("使用中") : t("設為使用中"),
          icon: Star,
          disabledReason: !done ? t("只有完成的 take 可以設為使用中") : active ? t("已經是使用中的 take") : null,
          onSelect: () => { dispatch({ type: "setActiveImageTake", shotId: shot.image_shot_id, takeId: take.take_id }); },
        },
        {
          id: "compare",
          label: comparing ? t("取消比較") : t("與監看中的 take 比較（B）"),
          icon: Columns2,
          disabledReason: comparing ? null : !done ? t("只有完成的 take 可以比較") : viewing ? t("這就是監看中的 take：先選另一個 take") : null,
          onSelect: () => { setCompareTakeId(comparing ? null : take.take_id); },
        },
        {
          id: "download",
          label: t("下載 PNG（原圖）"),
          icon: Download,
          separatorBefore: true,
          disabledReason: done && take.image ? null : t("還沒有圖片"),
          onSelect: () => {
            if (take.image) downloadAsset(take.image, downloadName(shot, take, false));
          },
        },
        {
          id: "download-white",
          label: t("下載 PNG（白底版）"),
          icon: Download,
          disabledReason: !done ? t("還沒有圖片") : take.image_white ? null : t("這個 take 沒有白底版"),
          onSelect: () => {
            if (take.image_white) downloadAsset(take.image_white, downloadName(shot, take, true));
          },
        },
        {
          id: "library",
          label: inLibrary ? t("已在素材庫") : t("加入素材庫（白底版）"),
          icon: FolderPlus,
          separatorBefore: true,
          disabledReason: inLibrary ? t("素材庫的「{name}」", { name: inLibrary.name }) : !done ? t("還沒有圖片") : take.image_white ? null : t("這個 take 沒有白底版"),
          onSelect: () => { addToLibrary(shot, take); },
        },
        {
          id: "video",
          label: t("用在影片鏡頭…"),
          icon: Clapperboard,
          disabledReason: !done ? t("還沒有圖片") : take.image_white ? null : t("這個 take 沒有白底版"),
          onSelect: () => { setSendTarget({ shotId: shot.image_shot_id, takeId: take.take_id }); },
        },
        {
          id: "load",
          label: t("載入這組參數"),
          icon: SlidersHorizontal,
          separatorBefore: true,
          onSelect: () => {
            selectTake(take.take_id);
            loadParams(shot, take);
          },
        },
        { id: "new", label: t("用這組參數新增一張圖片"), icon: CopyPlus, onSelect: () => { newShotFromParams(shot, take); } },
        {
          id: "archive",
          label: archived ? t("取消封存這次生成") : t("封存這次生成"),
          icon: archived ? ArchiveRestore : Archive,
          separatorBefore: true,
          disabledReason: rendering ? t("生成中的 run 不能封存") : null,
          onSelect: () => void setRunArchived(take.run_id, !archived),
        },
        {
          id: "delete",
          label: sameRun > 1 ? t("永久刪除這次生成（{sameRun} 張）…", { sameRun }) : t("永久刪除這次生成…"),
          icon: Trash2,
          tone: "danger",
          disabledReason: rendering ? t("生成中的 run 不能刪除：先取消或等它結束") : null,
          onSelect: () => { deleteRuns([take.run_id]); },
        },
      ];
    },
    [addToLibrary, archivedRunIds, compareTakeId, deleteRuns, dispatch, library, loadParams, newShotFromParams, selectTake, selectedTakeId, setCompareTakeId, setRunArchived, setSendTarget],
  );

  return { menuItems, addToLibrary, loadParams, newShotFromParams };
}
