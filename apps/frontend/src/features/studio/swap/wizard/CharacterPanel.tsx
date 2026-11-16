// One character of the swap draft: reference image (library or upload, white matte for transparent images) and the
// texts written into the prompt.
import { ImageOff, LoaderCircle, Trash2, Upload } from "lucide-react";
import { useId, useRef } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { CARD, THUMB_ZOOM, TILE } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import type { DraftCharacter } from "../draft";
import { FIELD_LIMITS } from "../prompt";
import { preparedReferenceSize } from "../referenceImage";
import type { SwapDraftApi } from "../useSwapDraft";
import { Label } from "./Label";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export function CharacterPanel({
  index,
  character,
  api,
  images,
  imageEdge,
}: {
  index: number;
  character: DraftCharacter;
  api: SwapDraftApi;
  images: readonly StudioLibraryItem[];
  /** The short edge the chosen route scales reference images to. */
  imageEdge: number;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const image = character.image;
  const prepared = image ? preparedReferenceSize(image.width, image.height, imageEdge) : null;
  const libraryId = image?.origin.kind === "library" ? (images.find((item) => item.file.file_id === (image.origin.kind === "library" ? image.origin.file.file_id : ""))?.item_id ?? "") : "";
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} ref={reveal(index)} className={cn(CARD, "grid gap-3 p-3 md:grid-cols-[10rem_minmax(0,1fr)]")}>
      <div className="grid content-start gap-2">
        <figure className="m-0 grid gap-1">
          <span className={cn(TILE, "grid aspect-[3/4] place-items-center bg-sunken")}>
            {image?.previewUrl ? (
              <img src={image.matteUrl ?? image.previewUrl} alt={t("角色 {index} 的參考圖{value}", { index: index + 1, value: image.matteUrl ? t("（白底副本）") : "" })} className={cn("size-full object-contain", THUMB_ZOOM)} draggable={false} />
            ) : (
              <ImageOff aria-hidden className="size-5 text-fg-disabled" />
            )}
          </span>
          {image ? (
            <figcaption className="grid gap-0.5 text-caption text-fg-tertiary">
              <span className="truncate" title={image.name}>
                {image.name}
              </span>
              {image.check === "checking" ? (
                <span className="flex items-center gap-1 text-info">
                  <LoaderCircle aria-hidden className="size-3 animate-spin" />
                  {t("檢查透明度…")}
                </span>
              ) : image.check === "transparent" ? (
                <span className="text-entity">{t("透明背景：顯示的是白底副本（模型用這張）")}</span>
              ) : image.check === "opaque" ? (
                <span>{t("不透明：直接使用原圖")}</span>
              ) : (
                <span className="text-danger">{image.error}</span>
              )}
              {image.width && image.height ? (
                <span className="machine">
                  {image.width}×{image.height}
                  {prepared ? t(" → 預處理 {width}×{height}", { width: prepared.width, height: prepared.height }) : ""}
                </span>
              ) : null}
            </figcaption>
          ) : null}
        </figure>
        <Select
          compact
          aria-label={t("角色 {index}：從專案素材庫選圖片", { index: index + 1 })}
          value={libraryId}
          onChange={(event) => {
            const item = images.find((entry) => entry.item_id === event.target.value);
            if (item) void api.setCharacterImage(character.id, { kind: "library", item });
          }}
        >
          <option value="">{images.length === 0 ? t("素材庫沒有圖片") : t("從素材庫選…")}</option>
          {images.map((item) => (
            <option key={item.item_id} value={item.item_id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} onClick={() => fileInput.current?.click()}>
          {t("上傳圖片")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          tabIndex={-1}
          aria-hidden
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void api.setCharacterImage(character.id, { kind: "local", file });
          }}
        />
      </div>
      <div className="grid content-start gap-2.5">
        <div className="flex items-center gap-2">
          <h3 id={headingId} className="text-data font-semibold text-fg">
            <T source={"角色 {index}<0><Subject {index2}></0>"} values={{ index: index + 1, index2: index + 1 }} slots={[<span className="machine ml-1.5 text-caption font-normal text-fg-tertiary" />]} />
          </h3>
          <Button size="icon-sm" variant="quiet" className="ml-auto" icon={<Trash2 aria-hidden />} aria-label={t("移除角色 {index}", { index: index + 1 })} title={t("移除角色 {index}", { index: index + 1 })} onClick={() => api.removeCharacter(character.id)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-who`} hint={t("原影片裡要被換掉的人物（英文名詞片語）")}>
            {t("取代影片中的誰")}
          </Label>
          <Input id={`${id}-who`} compact maxLength={FIELD_LIMITS.who} value={character.who} placeholder="the person in the red jacket" onChange={(event) => api.updateCharacter(character.id, { who: event.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-appearance`} hint={t("身份、臉、眼睛、髮型、服裝、配件；寫完整，模型才會照圖畫")}>
            {t("外觀")}
          </Label>
          <Textarea
            id={`${id}-appearance`}
            compact
            rows={3}
            maxLength={FIELD_LIMITS.appearance}
            value={character.appearance}
            placeholder="young woman with short black hair and brown eyes, a navy blazer over a white shirt, and small silver earrings"
            onChange={(event) => api.updateCharacter(character.id, { appearance: event.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-not`} hint={t("原角色的服裝或配件，逗號分隔；會寫成「has no …」")}>
            {t("不應出現的特徵（選填）")}
          </Label>
          <Input id={`${id}-not`} compact maxLength={FIELD_LIMITS.mustNot} value={character.mustNot} placeholder="red jacket, baseball cap" onChange={(event) => api.updateCharacter(character.id, { mustNot: event.target.value })} />
        </div>
      </div>
    </section>
  );
}
