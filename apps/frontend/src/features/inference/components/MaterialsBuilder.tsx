import { isListed } from "@/lib/json";
import { ArrowDown, ArrowUp, CircleAlert, Eye, EyeOff, FileUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Select } from "@/components/ui/controls";
import { useFlipList } from "@/components/ui/motion";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { nextMaterialKey } from "../draftStore";
import { acceptOf } from "../model/inputs";
import {
  canMoveMaterial,
  materialCounts,
  materialIssues,
  materialTags,
  moveMaterial,
  newMaterial,
  orderedMaterials,
  type MaterialDraft,
  type MaterialTag,
} from "../model/materials";
import { MATERIAL_ROLES, REF2VA_LIMITS, ROLE_LABEL } from "@/lib/h3Materials";
import { Expand } from "@/components/flow/Expand";
import { RISE_IN } from "@/components/ui/look";
import { useUploads } from "../useUploads";
import { MediaPreview } from "@/components/values/MediaPreview";
import { SecondsInput } from "./SecondsInput";
import { UploadButton } from "./UploadButton";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

type ListUpdate = (update: (list: MaterialDraft[]) => MaterialDraft[]) => void;

function focusLater(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: false }));
}

function CountChip({ label, value, max, over }: { label: string; value: number; max: number; over: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-caption transition-colors duration-(--duration-base)",
        over ? "border-danger/40 bg-danger/12 text-danger" : "border-line bg-raised text-fg-secondary",
      )}
    >
      {over ? <CircleAlert aria-hidden className="size-3" /> : null}
      {label}
      <span className="machine">{t("{value}／{max}", { value, max })}</span>
    </span>
  );
}

function MaterialRow({
  baseId,
  draft,
  tag,
  ordinal,
  canUp,
  canDown,
  disabled,
  onPatch,
  onMove,
  onRemove,
}: {
  baseId: string;
  draft: MaterialDraft;
  tag: MaterialTag | undefined;
  ordinal: number;
  canUp: boolean;
  canDown: boolean;
  disabled: boolean;
  onPatch: (patch: Partial<MaterialDraft>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const rowId = `${baseId}-${draft.key}`;
  const image = draft.role === "reference_image";
  const timeReason = image ? t("圖片沒有時間範圍") : null;
  return (
    <li className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-line-subtle bg-sunken/50 p-2 transition-colors duration-(--duration-fast) hover:border-line-strong", RISE_IN)}>
      <MediaPreview file={draft.file} title={draft.name} size="thumb" />
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="machine text-caption text-fg-tertiary">{`#${String(ordinal)}`}</span>
          <code
            className={cn("machine rounded-full border px-1.5 text-caption", (tag?.tag != null && tag.tag !== "") ? "border-entity/30 bg-entity/12 text-entity" : "border-line bg-raised text-fg-tertiary")}
            title={(tag?.tag != null && tag.tag !== "") ? t("prompt 中以 {tag} 引用這個素材", { tag: tag.tag }) : t("這個素材的編號要送出後才確定")}
          >
            {tag?.tag ?? "<Audio ?>"}
          </code>
          {tag?.soundtrack?.state === "unknown" ? (
            <span
              className="machine rounded-full border border-line bg-raised px-1.5 text-caption text-fg-tertiary"
              title={t("使用影片內的聲音時：影片若有音軌，原聲會在所有獨立聲音之後多佔一個 <Audio n>（元件 probe 後才確定，這裡不知道影片有沒有音軌）")}
            >
              {t("原聲 <Audio ?>")}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-data text-fg" title={draft.name}>
            {draft.name}
          </span>
          <span className="machine text-caption text-fg-tertiary">{`${draft.file.media_type || t("未知類型")} · ${formatBytes(draft.file.size_bytes)}`}</span>
          <span className="ml-auto flex shrink-0 items-center">
            <ToolButton
              label={previewOpen ? t("收起 {name} 的預覽", { name: draft.name }) : t("預覽 {name}", { name: draft.name })}
              icon={previewOpen ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              aria-expanded={previewOpen}
              aria-controls={`${rowId}-preview`}
              onClick={() => { setPreviewOpen(!previewOpen); }}
            />
            <ToolButton
              id={`${rowId}-up`}
              label={t("往前移（{role}的編號 -1）", { role: ROLE_LABEL[draft.role] })}
              icon={<ArrowUp aria-hidden />}
              disabledReason={disabled ? t("建立 run 中") : canUp ? null : t("已是同類的第一個")}
              onClick={() => { onMove(-1); }}
            />
            <ToolButton
              id={`${rowId}-down`}
              label={t("往後移（{role}的編號 +1）", { role: ROLE_LABEL[draft.role] })}
              icon={<ArrowDown aria-hidden />}
              disabledReason={disabled ? t("建立 run 中") : canDown ? null : t("已是同類的最後一個")}
              onClick={() => { onMove(1); }}
            />
            <ToolButton
              id={`${rowId}-remove`}
              label={t("從清單移除 {name}（主控上的檔案保留）", { name: draft.name })}
              icon={<Trash2 aria-hidden />}
              disabledReason={disabled ? t("建立 run 中") : null}
              onClick={onRemove}
              className="hover:text-danger"
            />
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">
          <label className="grid gap-0.5 text-caption text-fg-tertiary" htmlFor={`${rowId}-role`}>
            <T source={"角色{select}"} values={{ select: <Select
              compact
              id={`${rowId}-role`}
              value={draft.role}
              disabled={disabled}
              onChange={(event) => {
                const role = event.target.value;
                if (!isListed(role, MATERIAL_ROLES)) return;
                // 改成圖片時清掉時間範圍與影片設定（圖片不支援）；其他角色保留已填的值，影片設定只留給參考影片。
                onPatch(
                  role === "reference_image"
                    ? { role, start: null, end: null, useEmbeddedAudio: null, holdLastFrame: false }
                    : role === "reference_video"
                      ? { role }
                      : { role, useEmbeddedAudio: null, holdLastFrame: false },
                );
              }}
              className="min-w-32"
            >
              {MATERIAL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </Select> }} />
          </label>
          <label className="grid gap-0.5 text-caption text-fg-tertiary" htmlFor={`${rowId}-start`}>
            {t("開始（秒）")}
            <SecondsInput id={`${rowId}-start`} label={t("{name} 的開始秒數", { name: draft.name })} value={draft.start} placeholder={t("從頭")} disabledReason={timeReason} onChange={(start) => { onPatch({ start }); }} />
          </label>
          <label className="grid gap-0.5 text-caption text-fg-tertiary" htmlFor={`${rowId}-end`}>
            {t("結束（秒）")}
            <SecondsInput id={`${rowId}-end`} label={t("{name} 的結束秒數", { name: draft.name })} value={draft.end} placeholder={t("到結尾")} disabledReason={timeReason} onChange={(end) => { onPatch({ end }); }} />
          </label>
          {draft.role === "reference_video" ? (
            <>
              <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-data text-fg-secondary" title={t("不勾選時送出 use_embedded_audio=false（只用畫面）；勾選＝H3 預設，不另外送出")}>
                <input
                  type="checkbox"
                  className="size-4 accent-action"
                  checked={draft.useEmbeddedAudio !== false}
                  disabled={disabled}
                  onChange={(event) => { onPatch({ useEmbeddedAudio: event.target.checked ? null : false }); }}
                />
                {t("使用影片內的聲音")}
              </label>
              <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-data text-fg-secondary" title={t("參考影片只用到終點，之後重複最後一格、聲音補靜音，補滿生成長度；模型不會提早畫出終點之後的鏡頭。換角時建議打開。")}>
                <input type="checkbox" className="size-4 accent-action" checked={draft.holdLastFrame} disabled={disabled} onChange={(event) => { onPatch({ holdLastFrame: event.target.checked }); }} />
                {t("終點之後凍結最後一格")}
              </label>
            </>
          ) : null}
        </div>
        <Expand id={`${rowId}-preview`} open={previewOpen}>
          {previewOpen ? <MediaPreview file={draft.file} title={draft.name} /> : null}
        </Expand>
      </div>
    </li>
  );
}

/** 素材清單的問題（數量上限、時間範圍…）；同名檔案會產生相同的訊息，所以 key 帶上位置。 */
export function MaterialIssueList({ issues }: { issues: readonly string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="grid gap-0.5 text-caption text-danger" aria-live="polite">
      {issues.map((message, index) => (
        <li key={`${String(index)}:${message}`} className="flex items-start gap-1.5">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {message}
        </li>
      ))}
    </ul>
  );
}

/**
 * h3.materials.v1 編輯器（H3 ref2va 參考素材）：上傳圖片／影片／聲音 → 角色、時間範圍、影片內聲音與終點之後凍結最後一格、同類順序。
 * 清單依送出順序（圖片 → 聲音 → 影片，與 Studio 相同）顯示，並標出 prompt 中引用的 H3 標籤。
 */
export function MaterialsBuilder({
  id,
  pipelineId,
  label,
  materials,
  update,
  disabled = false,
}: {
  id: string;
  /** 上傳中的計數記在這個元件組合的草稿（完成前不能建立 run）。 */
  pipelineId: string;
  label: string;
  materials: readonly MaterialDraft[];
  update: ListUpdate;
  disabled?: boolean;
}) {
  const uploads = useUploads(pipelineId);
  const ordered = orderedMaterials(materials);
  const tags = materialTags(materials);
  const counts = materialCounts(materials);
  const issues = materialIssues(materials);
  const uploadId = `${id}-upload`;
  const full = counts.total >= REF2VA_LIMITS.maxTotal;
  const listRef = useRef<HTMLOListElement>(null);
  // 往前／往後移之後，其他素材從舊位置滑到新位置（共用 FLIP）
  useFlipList(listRef, ordered.map((draft) => draft.key).join("|"));

  const addFiles = (files: File[]) =>
    void uploads.upload(files, (file, ref) => { update((list) => [...list, newMaterial(nextMaterialKey(ref.file_id), file.name, ref)]); });

  const remove = (key: string) => {
    const index = ordered.findIndex((draft) => draft.key === key);
    const neighbour = ordered[index + 1] ?? ordered[index - 1];
    update((list) => list.filter((draft) => draft.key !== key));
    focusLater(neighbour ? `${id}-${neighbour.key}-remove` : uploadId);
  };

  const move = (key: string, direction: -1 | 1) => {
    update((list) => moveMaterial(list, key, direction));
    // 重新排序會讓按鈕暫時離開 DOM 而失去焦點：移到同一顆按鈕（到邊界時改到另一個方向）。
    const after = moveMaterial(materials, key, direction);
    const still = canMoveMaterial(after, key, direction);
    focusLater(`${id}-${key}-${still === (direction === -1) ? "up" : "down"}`);
  };

  return (
    <div className="grid min-w-0 gap-2" role="group" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <UploadButton
          inputId={uploadId}
          label={t("上傳參考素材（可多選）")}
          accept={acceptOf("any")}
          multiple
          disabledReason={disabled ? t("建立 run 中") : full ? t("已達 {maxTotal} 個上限", { maxTotal: REF2VA_LIMITS.maxTotal }) : null}
          pendingText={uploads.progress ? t("上傳中 {index}／{total}：{name}（{progressCount}）", { index: uploads.progress.index, total: uploads.progress.total, name: uploads.progress.name, progressCount: formatBytes(uploads.progress.size) }) : null}
          onFiles={addFiles}
        />
        <span className="flex flex-wrap items-center gap-1.5" aria-label={t("數量與上限")}>
          <CountChip label={t("圖片")} value={counts.image} max={REF2VA_LIMITS.image} over={counts.image > REF2VA_LIMITS.image} />
          <CountChip label={t("影片")} value={counts.video} max={REF2VA_LIMITS.video} over={counts.video > REF2VA_LIMITS.video} />
          <CountChip label={t("聲音")} value={counts.audio} max={REF2VA_LIMITS.audio} over={counts.audio > REF2VA_LIMITS.audio} />
          <CountChip label={t("合計")} value={counts.total} max={REF2VA_LIMITS.maxTotal} over={counts.total > REF2VA_LIMITS.maxTotal} />
        </span>
      </div>
      {uploads.failures.map((failure, index) => (
        <ErrorCallout key={`${String(index)}:${failure.name}`} error={failure.error} write title={t("「{name}」上傳失敗；可重新選擇檔案", { name: failure.name })} />
      ))}
      {ordered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-canvas/60">
          <EmptyState
            icon={<FileUp />}
            size="compact"
            title={t("尚未加入參考素材")}
            description={t("ref2va 需要 1–12 個：圖片 ≤ {image}、影片 ≤ {video}、聲音 ≤ {audio}，不能只有聲音。", { image: REF2VA_LIMITS.image, video: REF2VA_LIMITS.video, audio: REF2VA_LIMITS.audio })}
          />
        </div>
      ) : (
        <ol ref={listRef} className="grid gap-1.5" aria-label={t("{label}（依送出順序）", { label })}>
          {ordered.map((draft, index) => (
            <MaterialRow
              key={draft.key}
              baseId={id}
              draft={draft}
              tag={tags.get(draft.key)}
              ordinal={index + 1}
              canUp={canMoveMaterial(materials, draft.key, -1)}
              canDown={canMoveMaterial(materials, draft.key, 1)}
              disabled={disabled}
              onPatch={(patch) => { update((list) => list.map((item) => (item.key === draft.key ? { ...item, ...patch } : item))); }}
              onMove={(direction) => { move(draft.key, direction); }}
              onRemove={() => { remove(draft.key); }}
            />
          ))}
        </ol>
      )}
      <MaterialIssueList issues={issues} />
      <p className="text-caption text-fg-tertiary">
        {t("送出順序固定為圖片 → 聲音 → 影片（與 Studio 相同）；H3 依同類順序編號，prompt 中以 <Picture 1>、<Audio 1>、<Video 1> 引用。獨立聲音固定是 <Audio 1>…；使用影片內聲音的參考影片若有音軌，原聲接在所有獨立聲音之後。移除只會從清單拿掉，主控上的檔案保留。")}
      </p>
    </div>
  );
}
