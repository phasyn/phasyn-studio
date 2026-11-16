// 鏡頭的參考素材（H3 ref2va）：上傳（加進專案素材庫並加到這個鏡頭）、從素材庫加入（錨定在按鈕上的彈出層，可多選）、每個參考
// 一列（56 px 縮圖、@ 名稱、檔名；拖曳把手調整同類的送出順序，prompt 裡的 @ 名稱與 H3 標籤跟著換；雙擊或 F2 改檔名；其他動作
// 在列的「…」）、影片／聲音的片段設定；會擋渲染的問題與提醒。數量徽章只在接近 H3 上限時出現（materials.nearLimit）。
// 鏡頭的方式不送參考素材時（接續上一鏡、首幀圖片、只用文字）只說一行，參考仍保留在鏡頭裡；unsupportedReason 非 null 時停用加入。
// 拖檔：整個分頁是放開的目標（useFileDropZone），沒有常駐的提示；說明只在沒有參考時的空狀態裡。
import { AtSign, CircleX, FolderOpen, Info, TriangleAlert, Upload } from "lucide-react";
import { useContext, useId, useMemo, useRef } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Callout } from "@/components/ui/callout";
import { CARD, COUNT, SPRING_SNAPPY } from "@/components/ui/look";
import { reveal, useFlipList } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { MODE_LABEL, readingText } from "../components/generation/modeText";
import { Popover } from "../components/generation/Popover";
import { usePopover } from "../components/generation/usePopover";
import { readMode } from "../model/generationMode";
import { libraryRenameProblem, withLibraryItemPatch } from "../model/library";
import { findRoute } from "../model/routes";
import { mentionCount, PROMPT_MAX_LENGTH, tagUseCount } from "../prompt/compile";
import { StudioContext } from "../studioContext";
import { RefMemoryNote } from "../swap/RefMemoryNote";
import { canMoveReference, moveReference, moveReferenceTo, remapReferenceText } from "./editing";
import { newLocalId } from "./ids";
import { LibraryPicker } from "./LibraryPicker";
import { aliasOrdinal, newReference, presentationLabels, referenceWarnings, replacedReference, validateReferences, videoLibrary, type ReferenceKind } from "./materials";
import { DropOverlay, LimitBadges } from "./PanelParts";
import { ReferenceRow } from "./ReferenceRow";
import { ReferenceUploadRow } from "./UploadRow";
import { useFileDropZone } from "./useFileDropZone";
import { useReferenceDrag } from "./useReferenceDrag";
import { useReferenceUploads } from "./useReferenceUploads";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export interface ReferencesPanelProps {
  projectId: string;
  /** 專案素材庫（上傳的圖片／影片／聲音）。 */
  library: readonly StudioLibraryItem[];
  /** 這個鏡頭使用的參考（alias＝prompt 裡的 @ 名稱）。 */
  references: readonly StudioReference[];
  /** 新增上傳後回呼（呼叫端把新項目寫進 project.library 並自動儲存）。 */
  onLibraryChange: (next: StudioLibraryItem[]) => void;
  onReferencesChange: (next: StudioReference[]) => void;
  /** 非 null＝目前的運算路由（元件組合）不支援參考素材：顯示原因並停用加入。 */
  unsupportedReason: string | null;
  disabled?: boolean;
  /** 點 @ 名稱時插入到 prompt（提供時名稱變成按鈕）。 */
  onInsertMention?: (alias: string) => void;
  /** 鏡頭的 prompt：顯示每個參考在 prompt 中用了幾次，移除仍在使用的參考前提醒。 */
  prompt?: string;
  /** 生成長度（秒）：參考片段比生成長度長時提醒會被截斷。 */
  durationSeconds?: number | null;
  /** 目前的鏡頭：上傳期間換了鏡頭時，檔案只加進素材庫、不會加到另一個鏡頭。 */
  shotId?: string;
  /**
   * 改寫鏡頭的 prompt（與 prompt 一起提供時才能調整送出順序：換號後，prompt 裡的 @ 名稱與 H3 標籤跟著換，
   * 仍指向同一個檔案）。
   */
  onPromptChange?: (next: string) => void;
}

const KINDS: ReferenceKind[] = ["image", "video", "audio"];
const ACCEPT = "image/*,video/*,audio/*";
/** The generic reason the inspector gives for a route without references (a more specific one is the route's own hint). */
const GENERIC_UNSUPPORTED = t("目前的運算路由不支援參考素材（需要 ref2va 元件組合）");

export function ReferencesPanel({
  projectId,
  shotId,
  library,
  references,
  onLibraryChange,
  onReferencesChange,
  unsupportedReason,
  disabled = false,
  onInsertMention,
  prompt,
  durationSeconds = null,
  onPromptChange,
}: ReferencesPanelProps) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const picker = usePopover();
  const uploads = useReferenceUploads({ projectId, shotId: shotId ?? null, library, references, onLibraryChange, onReferencesChange });
  const items = useMemo(() => new Map(library.map((item) => [item.item_id, item])), [library]);
  const labels = useMemo(() => presentationLabels(references, library), [references, library]);
  const problems = useMemo(() => (references.length > 0 ? validateReferences(references, library, { generatedSeconds: durationSeconds }) : []), [references, library, durationSeconds]);
  const warnings = useMemo(() => referenceWarnings(references, library, { durationSeconds }), [references, library, durationSeconds]);
  const blocked = disabled ? t("目前無法編輯") : unsupportedReason;
  // The shot's 方式 (outside the Studio's provider there is none and the route's reason is shown as it is)
  const studio = useContext(StudioContext);
  const shot = shotId ? studio?.project.shots.find((item) => item.shot_id === shotId) : undefined;
  const reading = studio && shot ? readMode(shot, findRoute(studio.engine.routes, shot.route), studio.engine.status === "ready") : null;
  const notSent =
    reading?.mode && reading.mode !== "references"
      ? t("方式是「{mode}」：參考素材不會送出（仍保留在鏡頭裡）。", { mode: MODE_LABEL[reading.mode] })
      : reading?.issue === "needs-first-frame"
        ? t("這條路線需要首幀：參考素材不會送出（仍保留在鏡頭裡）。")
        : null;
  const routeHint = unsupportedReason && unsupportedReason !== GENERIC_UNSUPPORTED ? unsupportedReason : null;
  const routeGone = reading?.issue === "route-missing" ? readingText(reading).problem : null;
  // 清單依類型（圖片、影片、聲音）與序號顯示，和 @ 自動完成一致
  const rows = useMemo(
    () => [...references].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (aliasOrdinal(a.alias) ?? 0) - (aliasOrdinal(b.alias) ?? 0)),
    [references],
  );
  // 調整順序後其他列從舊位置滑到新位置
  useFlipList(listRef, rows.map((ref) => ref.ref_id).join(" "));

  const reorderable = onPromptChange !== undefined && prompt !== undefined;
  /** Writes a new order: the prompt's @ names and H3 tags follow; nothing changes when the prompt would grow past its limit. */
  const reorder = (next: StudioReference[] | null) => {
    if (!next || !onPromptChange || prompt === undefined) return;
    const text = remapReferenceText(prompt, references, next, library);
    // 換號後 prompt 變長（例如 @Image9 → @Image10）超過上限：不動，免得參考與 prompt 對不起來
    if (text.length > PROMPT_MAX_LENGTH) return;
    onReferencesChange(next);
    if (text !== prompt) onPromptChange(text);
  };
  const drag = useReferenceDrag(listRef, (refId, toIndex) => reorder(moveReferenceTo(references, refId, toIndex)));
  const highlight = useFileDropZone(section, blocked === null, (files) => uploads.addFiles(files, true));

  const update = (refId: string, patch: Partial<StudioReference>) => onReferencesChange(references.map((ref) => (ref.ref_id === refId ? { ...ref, ...patch } : ref)));
  const remove = (refId: string) => {
    const at = rows.findIndex((ref) => ref.ref_id === refId);
    const neighbour = rows[at + 1]?.ref_id ?? rows[at - 1]?.ref_id ?? null;
    const hadFocus = section.current?.contains(document.activeElement) ?? false;
    onReferencesChange(references.filter((ref) => ref.ref_id !== refId));
    // The row leaves with its buttons: focus goes to the next row's 「…」, or to 上傳
    if (hadFocus) {
      window.requestAnimationFrame(() => {
        const next = neighbour ? listRef.current?.querySelector<HTMLElement>(`[data-ref-id="${CSS.escape(neighbour)}"] [data-row-menu] button`) : null;
        (next ?? uploadButton.current)?.focus({ preventScroll: true });
      });
    }
  };
  const rename = (itemId: string, name: string) => {
    if (libraryRenameProblem(library, itemId, name) || items.get(itemId)?.name === name.trim()) return;
    onLibraryChange(withLibraryItemPatch(library, itemId, { name }));
  };
  const addItems = (chosen: readonly StudioLibraryItem[]) => {
    const next = chosen.reduce<StudioReference[]>((list, item) => {
      const created = newReference(item, list, newLocalId("ref"));
      return created ? [...list, created] : list;
    }, [...references]);
    if (next.length > references.length) onReferencesChange(next);
    picker.close(true);
  };
  const line = drag.state && drag.state.target !== drag.state.from ? drag.state.lineTop : null;

  return (
    <section ref={section} aria-labelledby={`${id}-title`} className="grid min-w-0 gap-2.5">
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-data font-semibold text-fg">
          <AtSign aria-hidden className="size-3.5 text-brand-cyan/80" />
          {t("參考素材")}
        </h3>
        <LimitBadges references={references} />
        <span className="ml-auto flex items-center gap-1.5">
          <ActionButton ref={uploadButton} size="sm" variant="secondary" icon={<Upload aria-hidden />} disabledReason={blocked} onClick={() => fileInput.current?.click()}>
            {t("上傳")}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="secondary"
            icon={<FolderOpen aria-hidden />}
            disabledReason={blocked}
            aria-haspopup="dialog"
            aria-expanded={picker.open}
            aria-controls={picker.open ? `${id}-library` : undefined}
            onClick={picker.toggle}
          >
            <T source={"從素材庫加入<0>{libraryCount}</0>"} values={{ libraryCount: library.length }} slots={[<span className={COUNT} />]} />
          </ActionButton>
        </span>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) uploads.addFiles(files, true);
          }}
        />
      </div>

      {notSent ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-info/30 bg-info/8 px-2.5 py-1.5 text-caption text-info animate-reveal">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {notSent}
            {routeHint ? ` ${routeHint}` : ""}
          </span>
        </p>
      ) : unsupportedReason ? (
        <Callout tone="warning" title={t("目前的路線不支援參考素材")}>
          {/* 沒有更具體的原因時，內文只說怎麼解決，不重複標題 */}
          <p>{routeGone ?? routeHint ?? t("在生成列把方式改成「參考素材」。")}</p>
          {references.length > 0 ? <p>{t("下面的參考仍保留在鏡頭裡，但不能新增。")}</p> : null}
        </Callout>
      ) : null}

      {uploads.tasks.length > 0 ? (
        <ul className={cn(CARD, "grid gap-0.5 p-1")} aria-label={t("上傳")} aria-live="polite">
          {uploads.tasks.map((task) => (
            <ReferenceUploadRow key={task.key} task={task} onRetry={() => uploads.retry(task.key)} onDismiss={() => uploads.dismiss(task.key)} />
          ))}
        </ul>
      ) : null}

      {problems.length > 0 ? (
        <ul className="grid gap-1" aria-label={t("會擋下渲染的參考問題")}>
          {problems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 text-caption text-danger">
              <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="grid gap-1" aria-label={t("參考提醒")}>
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-caption text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      {shot ? <RefMemoryNote shot={shot} /> : null}

      {references.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState
            size="compact"
            illustration="drop"
            title={t("這個鏡頭沒有參考素材")}
            description={t("上傳或從素材庫加入圖片、影片或聲音（也可以把檔案拖進這個分頁），再在 prompt 輸入 @ 插入它們，例如 @Image1、@Video1、@Audio1。")}
          />
        </div>
      ) : (
        <ul ref={listRef} className="relative grid gap-1.5" aria-label={t("這個鏡頭的參考素材（{referencesCount}）", { referencesCount: references.length })}>
          {rows.map((ref, index) => (
            <ReferenceRow
              key={ref.ref_id}
              ref={reveal(index)}
              reference={ref}
              item={items.get(ref.item_id)}
              label={labels.get(ref.ref_id)}
              mentions={prompt === undefined ? null : mentionCount(prompt, ref.alias)}
              tagUses={prompt === undefined ? 0 : tagUseCount(prompt, [labels.get(ref.ref_id)?.label, labels.get(ref.ref_id)?.soundtrack?.label])}
              disabled={disabled}
              onChange={(patch) => update(ref.ref_id, patch)}
              onRemove={() => remove(ref.ref_id)}
              onInsertMention={onInsertMention}
              rename={{ problem: (name) => libraryRenameProblem(library, ref.item_id, name), onRename: (name) => rename(ref.item_id, name) }}
              replace={{
                items: videoLibrary(library).filter((item) => item.kind === ref.kind && item.item_id !== ref.item_id),
                onReplace: (itemId) => update(ref.ref_id, replacedReference(ref, itemId, items.get(itemId)?.duration_seconds ?? null)),
                onUpload: (file) => uploads.replaceWith(file, ref.ref_id),
              }}
              move={reorderable ? { up: canMoveReference(references, ref.ref_id, -1), down: canMoveReference(references, ref.ref_id, 1), onMove: (delta) => reorder(moveReference(references, ref.ref_id, delta)) } : undefined}
              drag={reorderable ? { onPointerDown: drag.begin(ref.ref_id, ref.kind), active: drag.state?.refId === ref.ref_id } : undefined}
            />
          ))}
          {line !== null ? (
            <li
              aria-hidden
              role="presentation"
              className={cn("pointer-events-none absolute inset-x-2 top-0 h-0.5 rounded-full bg-brand-gradient transition-transform", SPRING_SNAPPY)}
              style={{ transform: `translateY(${line - 1}px)` }}
            />
          ) : null}
        </ul>
      )}

      <Popover id={`${id}-library`} open={picker.open} anchor={picker.anchor} label={t("從素材庫加入")} onClose={picker.close} className="w-[min(30rem,calc(100vw-1rem))]">
        <LibraryPicker library={library} references={references} disabledReason={blocked} onAdd={addItems} onCancel={() => picker.close(true)} />
      </Popover>

      {highlight ? <DropOverlay highlight={highlight} /> : null}
    </section>
  );
}
