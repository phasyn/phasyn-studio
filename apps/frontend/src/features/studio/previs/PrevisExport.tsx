import { useEffect, useRef, useState } from "react";
import { uploadBlob } from "@/api/files";
import type { StudioLibraryItem, StudioPrevis, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { MAX_LIBRARY_ITEMS } from "../model/project";
import { newLocalId } from "../references/ids";
import { addBlockedReason, newReference } from "../references/materials";
import { useStudio } from "../studioContext";
import type { PrevisPainter } from "./spacePainter";

interface Props {
  painter: PrevisPainter;
  shot: StudioShot;
  scene: StudioPrevis;
  frame: number;
  depth: boolean;
  images: Map<string, HTMLImageElement>;
  blocked: boolean;
}
export function PrevisExport({ painter, shot, scene, frame, depth, images, blocked }: Props) {
  const { project, dispatch, flush } = useStudio();
  const activeRef = useRef<AbortController | null>(null);
  useEffect(() => () => activeRef.current?.abort(), []);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<StudioLibraryItem | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const library = project.library ?? [];
  const item = library.find((i) => i.item_id === result?.item_id);
  const refs = shot.references ?? [];
  const ref = refs.find((r) => r.item_id === item?.item_id);
  const noRoom = library.length >= MAX_LIBRARY_ITEMS;
  const save = async () => {
    if (activeRef.current || blocked || noRoom) return;
    const controller = new AbortController();
    activeRef.current = controller;
    setSaving(true);
    setErr(null);
    try {
      await flush();
      const canvas = document.createElement("canvas");
      canvas.width = project.format.width;
      canvas.height = project.format.height;
      painter.draw(canvas, scene, frame, images, depth);
      const blob = await new Promise<Blob>((resolve, reject) => { canvas.toBlob((b) => { if (b) resolve(b); else reject(new Error(t("無法匯出預演 PNG。"))); }, "image/png"); },
      );
      const file = await uploadBlob(blob, "image/png", controller.signal);
      if (controller.signal.aborted) return;
      const name = t("{shot} · 第 {frame} 格 · {kind}.png", {
        shot: shot.title.slice(0, 110),
        frame,
        kind: depth ? (scene.projection === "stage3d" ? t("鏡頭深度") : t("分層深度")) : t("構圖預演"),
      });
      const created: StudioLibraryItem = {
        item_id: newLocalId("lib"),
        kind: "image",
        name,
        file,
        created_at: new Date().toISOString(),
        width: canvas.width,
        height: canvas.height,
        duration_seconds: null,
        has_audio: null,
        note:
          t("預演鏡頭 {shot}，來源影格 {frame}，影格率 {rate}。", {
            shot: shot.shot_id,
            frame,
            rate: `${String(project.format.fps.num)}/${String(project.format.fps.den)}`,
          }) + (depth && scene.projection === "stage3d" ? " " + t("鏡頭軸向深度使用 8 位元灰階，0.15 公尺為白、14 公尺為黑，背景為黑。") : ""),
      };
      dispatch({ type: "addLibraryItems", items: [created] });
      setResult(created);
    } catch (cause) {
      if (!controller.signal.aborted) setErr(errorText(cause));
    } finally {
      activeRef.current = null;
      setSaving(false);
    }
  };
  const setFirst = () => {
    if (item) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { continuity: { mode: "image", item_id: item.item_id } } });
  };
  const addRef = () => {
    if (!item || ref) return;
    const r = newReference(item, refs, newLocalId("ref"));
    if (r) dispatch({ type: "updateShot", shotId: shot.shot_id, patch: { references: [...refs, r] } });
  };
  const first = Boolean(item && shot.continuity?.mode === "image" && shot.continuity.item_id === item.item_id);
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={blocked || saving || noRoom} onClick={() => void save()}>
          {saving ? t("正在儲存預演 PNG…") : t("將此格 PNG 存入素材庫")}
        </Button>
        {noRoom ? <span role="alert">{t("素材庫已滿。")}</span> : null}
      </div>
      {item ? (
        <div className="flex flex-wrap items-center gap-2 text-caption">
          <a
            href={mediaUrl(item.file.node_id, item.file.file_id)}
            download={`previs-${item.file.sha256.slice(0, 16)}.png`}
            className="text-action-fg underline"
          >
            {item.name}
          </a>
          <Button size="sm" disabled={first} onClick={setFirst}>
            {first ? t("已設為首幀") : t("設為鏡頭首幀")}
          </Button>
          <Button
            size="sm"
            disabled={Boolean(ref) || Boolean(addBlockedReason("image", refs))}
            title={addBlockedReason("image", refs) ?? undefined}
            onClick={addRef}
          >
            {ref ? `@${ref.alias}` : t("加入鏡頭參考")}
          </Button>
        </div>
      ) : null}
      {(err != null && err !== "") ? (
        <p role="alert" className="text-warning">
          {err}
        </p>
      ) : null}
    </section>
  );
}
