// 「專業 Prompt 編輯器」（近全螢幕對話框）：左＝區塊大綱與範本、中＝全文或選取區塊、右＝固定 Prompt 片段庫、參考素材與修正建議
// （與 Studio 其他面板相同的 44 px 分頁）。標題列只有一行（名稱與鏡頭名稱），字元、區塊與鏡頭長度在底部狀態列。
// 參考分頁有 referenceEditing 時是完整的參考管理（與屬性面板同一個 ReferencesPanel：上傳、從素材庫加入、改檔名、
// 調整送出順序、裁切、移除，點 @ 名稱插入到游標）；沒有時只列出參考供插入。參考分頁開著時右欄加寬。
// 所有修改即時套用（onChange）；結構性改動留下可復原的提示。Esc 關閉（候選清單、草稿欄位開著時先關它們）。
// 外觀與共用對話框一致（契約 v2）：遮罩深空藍半透明＋6 px 模糊、視窗是 material-sheet（玻璃＋視窗陰影）＋頂端品牌細線，
// 進場 0.94→1＋上移（smooth 彈簧）；裡面的欄位與清單是實心、不發光。
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AtSign, BookMarked, CircleX, FileText, Heading, Lightbulb, ListTree, PenLine, RemoveFormatting, Timer, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Disclosure } from "@/components/common/Disclosure";
import { Button } from "@/components/ui/button";
import { useFocusReturn } from "@/components/ui/focusReturn";
import { PanelTabs } from "@/components/workbench/PanelTabs";
import { cn } from "@/lib/cn";
import { LIST_ROW, LIST_ROW_IDLE, LIST_ROW_SELECTED } from "@/components/ui/look";
import { ReferencesPanel } from "../references";
import { aliasLabels } from "../references/materials";
import { AdvisorSlot, type PromptTask } from "./advisorSlot";
import { analyzePrompt } from "./analysis";
import {
  addMissingSections,
  blockIndexAt,
  blockText,
  deleteBlock,
  duplicateBlock,
  insertFragment,
  missingSections,
  moveBlock,
  parsePrompt,
  proposeTimelineBlock,
  serializePrompt,
  type PromptDocument,
} from "./blocks";
import { BlockEditorPane } from "./BlockEditorPane";
import { BlockOutline } from "./BlockOutline";
import { ChangeNotice } from "./ChangeNotice";
import { compilePrompt, PROMPT_MAX_LENGTH } from "./compile";
import { FormatDialog } from "./FormatDialog";
import { mentionOptions } from "./mentions";
import { MentionTextarea, type MentionTextareaHandle } from "./MentionTextarea";
import { describeBlock } from "./outline";
import { ReferenceList } from "./ReferenceList";
import { SnippetLibraryPanel } from "./SnippetLibraryPanel";
import { templateHeading } from "./templateInsert";
import { useChangeNotice } from "./useChangeNotice";
import { WorkbenchStatus } from "./WorkbenchStatus";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const EMPTY_ITEMS = [] as const;

export type WorkbenchTab = "snippets" | "references" | "advisor";

const WORKBENCH_TABS: readonly string[] = ["snippets", "references", "advisor"] satisfies readonly WorkbenchTab[];

function isWorkbenchTab(value: string): value is WorkbenchTab {
  return WORKBENCH_TABS.includes(value);
}

/** 在專業編輯器裡管理這個鏡頭的參考素材所需的專案資訊與寫入（與屬性面板的 ReferencesPanel 相同）。 */
export interface ShotReferenceEditing {
  projectId: string;
  shotId: string;
  onLibraryChange: (next: StudioLibraryItem[]) => void;
  onReferencesChange: (next: StudioReference[]) => void;
  /** 非 null＝目前的運算路由不支援參考素材：顯示原因並停用加入。 */
  unsupportedReason: string | null;
}

export interface PromptWorkbenchProps {
  value: string;
  onChange: (next: string) => void;
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  /** 提供時參考分頁可以管理參考（上傳、加入、改名、排序、移除）；沒有時只能插入。 */
  referenceEditing?: ShotReferenceEditing;
  durationSeconds?: number | null;
  /** 鏡頭影格數（給「修正與建議」）；0＝未知。 */
  frames: number;
  /** 鏡頭的 H3 任務（給「修正與建議」）。 */
  mode?: PromptTask;
  /** 路線由驅動素材生成：不提醒參考「沒有在 prompt 中使用」（PromptEditor 的同名屬性）。 */
  drivenByReferences?: boolean;
  contextLabel?: string;
  disabled?: boolean;
  initialSelection: number | "full";
  initialTab: WorkbenchTab;
  /** prompt 以外擋下渲染的原因（鏡頭的插件檢查），狀態列一起列出。 */
  blockers?: readonly string[];
  onClose: () => void;
}

/** 草稿欄位或 @ 候選清單開著時，Esc 先交給它們（不關閉整個編輯器）。 */
function guardEscape(event: KeyboardEvent) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest("[data-escape-local='true']")) event.preventDefault();
}

export function PromptWorkbench({
  value,
  onChange,
  references,
  library,
  referenceEditing,
  durationSeconds = null,
  frames,
  mode,
  drivenByReferences = false,
  contextLabel,
  disabled = false,
  initialSelection,
  initialTab,
  blockers = EMPTY_ITEMS,
  onClose,
}: PromptWorkbenchProps) {
  const id = useId();
  const doc = useMemo(() => parsePrompt(value), [value]);
  const [selection, setSelection] = useState<number | "full">(initialSelection);
  const [tab, setTab] = useState<WorkbenchTab>(initialTab);
  const [formatOpen, setFormatOpen] = useState(false);
  const notice = useChangeNotice(value, onChange);
  const editorRef = useRef<MentionTextareaHandle>(null);
  // 「跳到這段」：位置是全文的 offset，區塊模式時先切回全文，等全文編輯區掛上再選取。
  // 插入範本後選到新區塊時，等它的內容編輯區掛上再把焦點移過去。
  const pendingRevealRef = useRef<{ start: number; end: number } | null>(null);
  const pendingFocusRef = useRef(false);
  const selected = selection !== "full" && doc.blocks[selection] ? selection : "full";
  const block = selected === "full" ? null : (doc.blocks[selected] ?? null);
  const options = useMemo(() => mentionOptions(references, library), [references, library]);
  const compiled = useMemo(() => compilePrompt(value, references, library), [value, references, library]);
  const labels = useMemo(() => aliasLabels(references), [references]);
  const notes = useMemo(() => analyzePrompt(doc, value, { references, usedAliases: compiled.usedAliases, durationSeconds, drivenByReferences }), [doc, value, references, compiled.usedAliases, durationSeconds, drivenByReferences]);
  const timeline = proposeTimelineBlock(doc, durationSeconds);
  const missing = missingSections(doc);
  const problems = compiled.problems;
  const insertIndex = selected === "full" ? doc.blocks.length : selected + 1;

  const applyText = (text: string, message: string, offset: number | null) => {
    if (!notice.apply(text, message) || offset === null) return;
    const index = blockIndexAt(parsePrompt(text), offset);
    pendingFocusRef.current = true;
    setSelection(index >= 0 ? index : "full");
  };
  const applyDoc = (next: PromptDocument, message: string, select: number | "full") => {
    if (notice.apply(serializePrompt(next), message)) setSelection(select);
  };
  const insertBlock = (index: number, fragment: string, message: string) => {
    const result = insertFragment(doc, index, fragment);
    applyText(result.text, message, result.offset);
  };
  const tooLong = () => { notice.report(t("插入後會超過 {promptMaxLength} 字元上限，沒有插入", { promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") })); };
  const blockName = block ? describeBlock(block).title || describeBlock(block).kind : "";
  // The inline editor mounts this dialog itself (no Dialog.Trigger): it opens on the text editor, and on close focus
  // returns to the control that had it when the dialog opened.
  const focusReturn = useFocusReturn({
    onOpenAutoFocus: (event) => {
      event.preventDefault();
      editorRef.current?.focus();
    },
  });

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = pendingRevealRef.current;
    if (range && selected === "full") {
      pendingRevealRef.current = null;
      editor.selectRange(range.start, range.end);
    } else if (pendingFocusRef.current) {
      pendingFocusRef.current = false;
      editor.focus();
    }
    // value：插入後選取的區塊位置可能沒變（例如新區段插在最前面），仍要在這次更新後處理
  }, [selected, value]);

  const revealRange = (start: number, end: number) => {
    if (selected === "full" && editorRef.current) {
      editorRef.current.selectRange(start, end);
      return;
    }
    pendingRevealRef.current = { start, end };
    setSelection("full");
  };
  /** 修正與建議的範本：有標題的區塊附加在選取的區塊後面，其他文字插入到游標位置。 */
  const insertTemplate = (text: string) => {
    const heading = templateHeading(text);
    if (heading !== null) insertBlock(insertIndex, text, t("已插入範本「{value}」", { value: heading }));
    else if (editorRef.current?.insertText(text) === false) tooLong();
  };

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(2_4_10_/_0.66)] backdrop-blur-[6px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={`${id}-description`}
          onEscapeKeyDown={guardEscape}
          {...focusReturn}
          className="material-sheet fixed inset-2 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl border border-[rgb(255_255_255_/_0.08)] text-fg before:pointer-events-none before:absolute before:inset-x-8 before:top-0 before:h-px before:bg-brand-gradient before:opacity-70 md:inset-4 data-[state=open]:animate-dialog-in forced-colors:border-[CanvasText]"
        >
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line-subtle px-4">
            <DialogPrimitive.Title className="flex shrink-0 items-center gap-2 text-section font-semibold text-fg">
              <PenLine aria-hidden className="size-4 text-brand-cyan" />
              {t("專業 Prompt 編輯器")}
            </DialogPrimitive.Title>
            {(contextLabel != null && contextLabel !== "") ? <span className="min-w-0 truncate text-data text-fg-secondary">{contextLabel}</span> : null}
            <DialogPrimitive.Description id={`${id}-description`} className="sr-only">
              {t("左側是區塊大綱與範本，中間編輯全文或選取的區塊，右側是固定 Prompt 片段庫與參考素材。修改會立即套用到鏡頭的 prompt。")}
            </DialogPrimitive.Description>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Button size="sm" variant="secondary" icon={<RemoveFormatting aria-hidden />} disabled={disabled || value.trim().length === 0} onClick={() => { setFormatOpen(true); }}>
                {t("格式化…")}
              </Button>
              <DialogPrimitive.Close asChild>
                <Button size="icon-sm" variant="quiet" aria-label={t("關閉專業 Prompt 編輯器")} icon={<X aria-hidden />} />
              </DialogPrimitive.Close>
            </span>
          </header>

          <div
            className={cn(
              "grid min-h-0 flex-1 transition-[grid-template-columns] duration-(--duration-spring-smooth) ease-(--ease-spring-smooth)",
              tab === "references" && referenceEditing
                ? "grid-cols-[14rem_minmax(0,1fr)_24rem] xl:grid-cols-[16rem_minmax(0,1fr)_28rem]"
                : "grid-cols-[14rem_minmax(0,1fr)_19rem] xl:grid-cols-[16rem_minmax(0,1fr)_22rem]",
            )}
          >
            <nav aria-label={t("Prompt 區塊大綱")} className="flex min-h-0 flex-col border-r border-line-subtle bg-canvas">
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <button
                  type="button"
                  onClick={() => { setSelection("full"); }}
                  aria-current={selected === "full" ? "true" : undefined}
                  className={cn(
                    LIST_ROW,
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-data",
                    selected === "full" ? cn(LIST_ROW_SELECTED, "text-fg") : cn(LIST_ROW_IDLE, "text-fg-secondary"),
                  )}
                >
                  <FileText aria-hidden className={cn("size-4", selected === "full" ? "text-brand-cyan" : "text-fg-tertiary")} />
                  <T source={"全文<0>{valueCount}</0>"} values={{ valueCount: value.length.toLocaleString("en-US") }} slots={[<span key="slot-0" className="machine ml-auto text-caption text-fg-tertiary" />]} />
                </button>
                <p className="px-2 pt-3 pb-1 text-caption text-fg-tertiary">{t("區塊（{blocksCount}）", { blocksCount: doc.blocks.length })}</p>
                {doc.blocks.length === 0 ? (
                  <p className="px-2 text-caption leading-5 text-fg-tertiary">{t("還沒有內容。在全文輸入，或用下方的按鈕加入段落與時間軸。")}</p>
                ) : (
                  <BlockOutline blocks={doc.blocks} selected={selected === "full" ? null : selected} onSelect={setSelection} label={t("Prompt 區塊")} />
                )}
              </div>
              <div className="grid gap-1 border-t border-line-subtle p-2">
                <p className="px-1 text-caption text-fg-tertiary">{t("新增區塊（插在選取的區塊後面）")}</p>
                <Button
                  size="sm"
                  variant="quiet"
                  className="justify-start px-2"
                  icon={<Timer aria-hidden />}
                  disabled={disabled}
                  title={t("插入 {fragment}", { fragment: timeline.fragment })}
                  onClick={() => { insertBlock(timeline.index, timeline.fragment, t("已新增時間軸區塊 {label}", { label: timeline.label })); }}
                >
                  <T source={"時間軸區塊<0>{label}</0>"} values={{ label: timeline.label }} slots={[<span key="slot-0" className="machine ml-auto truncate text-caption text-fg-tertiary" />]} />
                </Button>
                {timeline.exceeds ? (
                  <p className="px-1 text-caption text-warning">
                    {timeline.cue !== null ? t("切入時間已到鏡頭長度：官方要求切鏡時間小於片長，新分鏡不會被生成。") : t("時間軸已寫到鏡頭長度；新區塊會超出鏡頭長度。")}
                  </p>
                ) : null}
                <Button
                  size="sm"
                  variant="quiet"
                  className="justify-start px-2"
                  icon={<ListTree aria-hidden />}
                  disabled={disabled || missing.length === 0}
                  onClick={() => {
                    const result = addMissingSections(doc);
                    applyText(result.text, t("已補上段落：{added}", { added: formatList(result.added) }), result.offset);
                  }}
                >
                  {t("補上完整格式的段落")}
                </Button>
                <p className="px-1 text-caption leading-5 text-fg-tertiary">{missing.length === 0 ? t("完整格式的 6 段都在了。") : t("加上缺少的 {missingCount} 段，內容留空。", { missingCount: missing.length })}</p>
                <Button size="sm" variant="quiet" className="justify-start px-2" icon={<Heading aria-hidden />} disabled={disabled} onClick={() => { insertBlock(insertIndex, t("**新區塊：**"), t("已新增標題區塊「新區塊」")); }}>
                  {t("標題區塊")}
                </Button>
              </div>
            </nav>

            <section aria-label={t("編輯區")} className="flex min-h-0 min-w-0 flex-col bg-surface">
              {block && selected !== "full" ? (
                <BlockEditorPane
                  doc={doc}
                  index={selected}
                  value={value}
                  onChange={onChange}
                  options={options}
                  editorRef={editorRef}
                  disabled={disabled}
                  onMove={(delta) => { applyDoc(moveBlock(doc, selected, delta), t("已{value}「{blockName}」", { value: delta < 0 ? t("上移") : t("下移"), blockName }), selected + delta); }}
                  onDuplicate={() => { applyDoc(duplicateBlock(doc, selected), t("已複製「{blockName}」", { blockName }), selected + 1); }}
                  onDelete={() => { applyDoc(deleteBlock(doc, selected), t("已刪除「{blockName}」", { blockName }), doc.blocks.length > 1 ? Math.min(selected, doc.blocks.length - 2) : "full"); }}
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
                  <label htmlFor={`${id}-full`} className="sr-only">
                    {t("全文（輸入 @ 插入參考素材）")}
                  </label>
                  <MentionTextarea
                    id={`${id}-full`}
                    ref={editorRef}
                    value={value}
                    onChange={onChange}
                    options={options}
                    disabled={disabled}
                    maxLength={PROMPT_MAX_LENGTH}
                    placeholder={t("描述畫面、動作、鏡頭運動與聲音；可以用左側的按鈕加入段落與時間軸。")}
                    containerClassName="flex min-h-0 flex-1 flex-col"
                    className="min-h-64 flex-1 resize-none leading-7"
                  />
                </div>
              )}
              <div className="grid max-h-[30%] shrink-0 gap-2 overflow-y-auto border-t border-line-subtle px-4 py-2">
                <ChangeNotice state={notice} />
                {problems.length > 0 ? (
                  <ul className="grid gap-1" aria-label={t("會擋下渲染的問題")}>
                    {problems.map((problem) => (
                      <li key={problem} className="flex items-start gap-1.5 text-caption text-danger">
                        <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        {problem}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {notes.length > 0 ? (
                  <Disclosure summary={t("{notesCount} 個提醒（不影響渲染）", { notesCount: notes.length })}>
                    <ul className="grid gap-1">
                      {notes.map((note) => (
                        <li key={note.text} className={cn("text-caption leading-5", note.tone === "warning" ? "text-warning" : "text-fg-tertiary")}>
                          {note.text}
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                ) : null}
              </div>
            </section>

            <aside aria-label={t("固定 Prompt 與參考素材")} className="flex min-h-0 min-w-0 flex-col border-l border-line-subtle bg-canvas">
              <PanelTabs
                variant="studio"
                idPrefix={`${id}-side`}
                label={t("固定 Prompt、參考與修正建議")}
                value={tab}
                onChange={(next) => {
                  if (isWorkbenchTab(next)) setTab(next);
                }}
                tabs={[
                  { id: "snippets", label: t("固定 Prompt"), icon: BookMarked },
                  { id: "references", label: t("參考"), icon: AtSign, ...(references.length ? { count: references.length } : {}) },
                  { id: "advisor", label: t("修正與建議"), icon: Lightbulb },
                ]}
              />
              <div role="tabpanel" id={`${id}-side-panel-${tab}`} aria-labelledby={`${id}-side-tab-${tab}`}  /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- The tab panel is a keyboard destination even when its content has no interactive controls. */ tabIndex={0} className="flex min-h-0 flex-1 flex-col outline-none">
                {tab === "snippets" ? (
                  <SnippetLibraryPanel
                    disabled={disabled}
                    onInsertAtCursor={(text) => {
                      if (editorRef.current?.insertText(text) === false) tooLong();
                    }}
                    onAppendBlock={(text, title) => { insertBlock(insertIndex, text, t("已附加固定 Prompt「{title}」", { title })); }}
                    readSelection={() => editorRef.current?.selection().text ?? ""}
                    currentBlock={block ? { title: blockName, text: blockText(block) } : null}
                  />
                ) : tab === "references" && referenceEditing ? (
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <ReferencesPanel
                      projectId={referenceEditing.projectId}
                      shotId={referenceEditing.shotId}
                      library={library}
                      references={references}
                      onLibraryChange={referenceEditing.onLibraryChange}
                      onReferencesChange={referenceEditing.onReferencesChange}
                      unsupportedReason={referenceEditing.unsupportedReason}
                      disabled={disabled}
                      prompt={value}
                      onPromptChange={onChange}
                      durationSeconds={durationSeconds}
                      onInsertMention={(alias) => {
                        if (editorRef.current?.insertMention(alias) === false) tooLong();
                      }}
                    />
                  </div>
                ) : tab === "references" ? (
                  <ReferenceList
                    options={options}
                    disabled={disabled}
                    onInsert={(alias) => {
                      if (editorRef.current?.insertMention(alias) === false) tooLong();
                    }}
                  />
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <AdvisorSlot
                      text={value}
                      frames={frames}
                      references={references}
                      library={library}
                      {...(mode === undefined ? {} : { mode })}
                      disabled={disabled}
                      onApplyFix={(next, label) => void notice.apply(next, t("已套用：{label}", { label }))}
                      onRevealRange={revealRange}
                      onInsertTemplate={insertTemplate}
                    />
                  </div>
                )}
              </div>
            </aside>
          </div>

          <WorkbenchStatus
            problemCount={problems.length}
            blockers={blockers}
            mapping={compiled.usedAliases.map((alias) => `@${alias} → ${labels.get(alias) ?? "?"}`)}
            length={value.length}
            blocks={doc.blocks.length}
            durationSeconds={durationSeconds}
          />
          {formatOpen ? <FormatDialog open onOpenChange={setFormatOpen} value={value} onApply={(next, message) => void notice.apply(next, message)} /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
