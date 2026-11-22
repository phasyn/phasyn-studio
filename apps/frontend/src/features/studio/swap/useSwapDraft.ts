// 換角精靈的草稿（只在瀏覽器；專案建立後狀態改存在專案裡）。放在工具列的 SwapLauncher（一直掛載），關掉對話框再打開
// 輸入都還在；重新整理或換專案時由 draftStore 保存的草稿接回（saved）。非同步工作（讀媒體資訊、上傳來源影片、檢查角色圖
// 透明度）完成時，只更新仍是同一個選擇的項目（key 比對）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { uploadFile } from "@/api/files";
import { mediaUrl } from "@/api/http";
import { newLocalId } from "../references/ids";
import { kindForFile, libraryName, readMediaFacts } from "../references/media";
import { defaultTitle, initialDraft, newCharacter, type DraftCharacter, type DraftImage, type DraftSource, type SwapDraft } from "./draft";
import { draftFromSaved, type SavedDraft } from "./draftStore";
import { errorText } from "./errors";
import { checkImage } from "./whiteMatte";
import { t } from "@/i18n";

/** saved: a draft kept in this browser, taken as the starting draft (its library images are checked again on mount). */
export function useSwapDraft(saved: SavedDraft | null = null) {
  const [initial] = useState<SwapDraft>(() => (saved ? draftFromSaved(saved) : initialDraft()));
  const [draft, setDraft] = useState<SwapDraft>(initial);
  const urlsRef = useRef(new Set<string>());
  const controllersRef = useRef(new Set<AbortController>());

  // 卸載（切換專案、離開 Studio）：中止進行中的上傳、釋放 object URL
  useEffect(() => {
    const owned = urlsRef.current;
    const pending = controllersRef.current;
    return () => {
      for (const controller of pending) controller.abort();
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  const objectUrl = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.add(url);
    return url;
  }, []);
  const release = (image: DraftImage | null | undefined) => {
    for (const url of [image?.previewUrl, image?.matteUrl]) {
      if ((url != null && url !== "") && urlsRef.current.has(url)) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(url);
      }
    }
  };

  const update = useCallback((patch: Partial<SwapDraft> | ((current: SwapDraft) => Partial<SwapDraft>)) => {
    setDraft((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
  }, []);

  const setSource = (source: DraftSource) => { setDraft((current) => ({
      ...current,
      source,
      sourceUpload: null,
      startSeconds: 0,
      endSeconds: null,
      disabledCuts: [],
      manualCuts: [],
      skipDetection: false,
      notes: {},
      absent: {},
      title: current.titleEdited ? current.title : defaultTitle(source.name),
    })); };

  const chooseLibraryVideo = (item: StudioLibraryItem) => { setSource({ key: newLocalId("src"), name: item.name, file: item.file, duration_seconds: item.duration_seconds, width: item.width, height: item.height, has_audio: item.has_audio }); };

  /** 上傳本機影片（一次一個；失敗不自動重送，使用者重新選檔）。 */
  const uploadSource = async (file: File) => {
    if (kindForFile(file) !== "video") {
      update({ sourceUpload: { name: file.name, state: "failed", error: t("不是影片檔：只接受影片") } });
      return;
    }
    const controller = new AbortController();
    controllersRef.current.add(controller);
    update({ sourceUpload: { name: file.name, state: "reading", error: null } });
    try {
      const facts = await readMediaFacts(file, "video");
      if (controller.signal.aborted) return;
      update({ sourceUpload: { name: file.name, state: "uploading", error: null } });
      const ref = await uploadFile(file, controller.signal);
      controller.signal.throwIfAborted();
      setSource({ key: newLocalId("src"), name: libraryName(file.name), file: ref, ...facts });
    } catch (error) {
      if (!controller.signal.aborted) update({ sourceUpload: { name: file.name, state: "failed", error: errorText(error) } });
    } finally {
      controllersRef.current.delete(controller);
    }
  };

  const updateCharacter = (id: string, patch: Partial<Omit<DraftCharacter, "id" | "image">>) => { setDraft((current) => ({ ...current, characters: current.characters.map((item) => (item.id === id ? { ...item, ...patch } : item)) })); };

  const addCharacter = () => { setDraft((current) => ({ ...current, characters: [...current.characters, newCharacter()] })); };

  // 釋放 object URL 是副作用：在事件處理器裡做（用這次 render 的草稿），不放進 setDraft 的 updater（StrictMode 會執行兩次）
  const removeCharacter = (id: string) => {
    release(draft.characters.find((item) => item.id === id)?.image);
    setDraft((current) => ({
      ...current,
      characters: current.characters.filter((item) => item.id !== id),
      absent: Object.fromEntries(Object.entries(current.absent).map(([key, ids]) => [key, ids.filter((value) => value !== id)])),
    }));
  };

  /** 檢查已選的角色圖：讀尺寸、判斷透明，透明時先在瀏覽器產生白底副本（建立專案時才上傳）。 */
  const checked = useCallback(
    async (image: DraftImage): Promise<Partial<DraftImage>> => {
      try {
        const blob = image.origin.kind === "local" ? image.origin.file : await fetchImage(image.previewUrl);
        const result = await checkImage(blob);
        return { width: result.width, height: result.height, check: result.transparent ? "transparent" : "opaque", matte: result.matte, matteUrl: result.matte ? objectUrl(result.matte) : null };
      } catch (error) {
        return { check: "failed", error: t("無法讀取圖片：{error}", { error: errorText(error) }) };
      }
    },
    [objectUrl],
  );

  // A restored draft's library images are checked again (their size, transparency and white copy)
  useEffect(() => {
    for (const character of initial.characters) {
      const image = character.image;
      if (image?.check === "checking") void checked(image).then((patch) => { setDraft(patchImage(character.id, image.key, patch)); });
    }
  }, [initial, checked]);

  /** 選角色圖，然後檢查。 */
  const setCharacterImage = async (id: string, source: { kind: "library"; item: StudioLibraryItem } | { kind: "local"; file: File }) => {
    if (source.kind === "local" && kindForFile(source.file) !== "image") {
      setDraft((current) => ({
        ...current,
        characters: current.characters.map((item) =>
          item.id === id
            ? { ...item, image: { key: newLocalId("img"), name: source.file.name, origin: { kind: "local", file: source.file }, previewUrl: "", width: null, height: null, check: "failed", error: t("不是圖片檔"), matte: null, matteUrl: null } }
            : item,
        ),
      }));
      return;
    }
    const key = newLocalId("img");
    const image: DraftImage =
      source.kind === "library"
        ? { key, name: source.item.name, origin: { kind: "library", file: source.item.file }, previewUrl: mediaUrl(source.item.file.node_id, source.item.file.file_id), width: source.item.width, height: source.item.height, check: "checking", error: null, matte: null, matteUrl: null }
        : { key, name: libraryName(source.file.name), origin: { kind: "local", file: source.file }, previewUrl: objectUrl(source.file), width: null, height: null, check: "checking", error: null, matte: null, matteUrl: null };
    release(draft.characters.find((item) => item.id === id)?.image);
    setDraft((current) => ({ ...current, characters: current.characters.map((item) => (item.id === id ? { ...item, image } : item)) }));
    const patch = await checked(image);
    setDraft(patchImage(id, key, patch));
  };

  /** 清空草稿（建立完成或使用者重新開始）；釋放所有角色圖的 object URL。 */
  const reset = () => {
    for (const character of draft.characters) release(character.image);
    setDraft(initialDraft());
  };

  return { draft, update, chooseLibraryVideo, uploadSource, addCharacter, removeCharacter, updateCharacter, setCharacterImage, reset };
}

export type SwapDraftApi = ReturnType<typeof useSwapDraft>;

/** Puts the result of an image check on its character, while that character still has this image (key). */
function patchImage(id: string, key: string, patch: Partial<DraftImage>) {
  return (current: SwapDraft): SwapDraft => ({
    ...current,
    characters: current.characters.map((item) => (item.id === id && item.image?.key === key ? { ...item, image: { ...item.image, ...patch } } : item)),
  });
}

/** A library image's bytes; an HTTP failure (for example the Node is offline) is an error, not undecodable bytes. */
async function fetchImage(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.blob();
}
