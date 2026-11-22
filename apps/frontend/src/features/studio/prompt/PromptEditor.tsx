// Studio 屬性面板的 Prompt 編輯器：一欄固定高度，由上而下是工具列（PromptToolbar，永遠一行：範本、固定 Prompt、@ 參考、
// 逐鏡描述〔prompt 有 [Shot N] 行時〕、⋯，右端展開）、編輯區（整個分頁唯一捲動的地方：文字裡的 @ 名稱看得見的文字區，
// 或區塊檢視；空白時中央是三個範本）、狀態列（PromptStatusRow：建議、呼叫端的狀態徽章）、只有在有問題時才出現的問題列
// （都緊貼 prompt，說的是 prompt 的事），最後是呼叫端的內容（鏡頭的生成設定）。
// 結構性改動都可以復原（逐鏡描述的儲存也是一次可復原的改動）。
// 外觀（Phasyn）：工具列是安靜的工具按鈕（開著的浮層＝淡品牌底＋品牌細框）；文字區維持俐落、不發光。
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioLibraryItem, StudioPromptSnippet, StudioReference } from "@/api/generated/contracts";
import { LazyBoundary } from "@/components/common/LazyBoundary";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { promptTemplates, type PromptTemplate } from "./advisor";
import type { PromptTask } from "./advisorSlot";
import { insertFragment, moveBlock, parsePrompt, serializePrompt } from "./blocks";
import { BlockOutline } from "./BlockOutline";
import { compilePrompt, EMPTY_PROMPT_PROBLEM, PROMPT_MAX_LENGTH } from "./compile";
import { FormatDialog } from "./FormatDialog";
import { mentionOptions } from "./mentions";
import { MentionTextarea, type MentionTextareaHandle } from "./MentionTextarea";
import { describeBlock } from "./outline";
import { ProblemsRow } from "./ProblemsRow";
import type { ShotReferenceEditing, WorkbenchTab } from "./PromptWorkbench";
import { parseShotLayout } from "./shots/layout";
import { StartTemplates } from "./StartTemplates";
import { firstPlaceholder, startTemplates, templateHeading } from "./templateInsert";
import { PromptStatusRow } from "./toolbar/PromptStatusRow";
import { PromptToolbar } from "./toolbar/PromptToolbar";
import { useChangeNotice } from "./useChangeNotice";
import { H3_RULES } from "../model/providerTraits";

// The professional editor (block outline, snippets, advisor panel) loads when it is first opened
const PromptWorkbench = lazy(() => import("./PromptWorkbench").then((m) => ({ default: m.PromptWorkbench })));
// So does the per-shot description dialog (it also brings the swap wizard's frame reader)
const ShotDescriptionsDialog = lazy(() => import("./shots/ShotDescriptionsDialog").then((m) => ({ default: m.ShotDescriptionsDialog })));

export interface PromptEditorProps {
  /** 鏡頭的 prompt 原文（可含 @Image1 這類參考與區塊標題）。 */
  value: string;
  /** 每次編輯都回呼；呼叫端負責自動儲存。 */
  onChange: (next: string) => void;
  /** 這個鏡頭可用的參考素材（@ 自動完成的來源）。 */
  references: readonly StudioReference[];
  /** 專案素材庫（顯示參考的檔名與縮圖）。 */
  library: readonly StudioLibraryItem[];
  /** 提供時，專業編輯器的「參考」分頁可以管理參考（上傳、從素材庫加入、改檔名、調整順序、移除）。 */
  referenceEditing?: ShotReferenceEditing;
  /** 文字區的 id（外部 label 的 htmlFor）；沒有外部 label 時文字區的名稱是「Prompt」。 */
  id?: string;
  disabled?: boolean;
  /** 鏡頭長度（秒）：時間軸區塊的建議範圍與超出長度的提醒。沒給時由 durationFrames ÷ fps 推算。 */
  durationSeconds?: number | null;
  /** 鏡頭影格數（24 fps）：給「修正與建議」；沒給時由 durationSeconds × 24 推算，兩者都沒有＝未知（0）。 */
  durationFrames?: number;
  /** 鏡頭長度的幀率（路線的規則：H3 是 24，其他路線是專案的幀率）；沒給時用 H3 的 24。 */
  fps?: number;
  /** 這個鏡頭的 H3 任務（t2va／fl2va／ref2va）：給「修正與建議」與範本的排序。 */
  mode?: PromptTask;
  /**
   * 路線由驅動素材生成（表演影片、音訊驅動）：參考素材是「參考」分頁裡的角色圖片與驅動素材，不靠 prompt 的 @ 名稱，
   * 所以不提醒「沒有在 prompt 中使用」。
   */
  drivenByReferences?: boolean;
  /** 專業編輯器標題列顯示的名稱（例如鏡頭名稱）。 */
  contextLabel?: string;
  placeholder?: string;
  /** 呼叫端加在狀態列「建議」後面的狀態徽章（鏡頭的插件檢查）。 */
  toolbarStatus?: ReactNode;
  /** 狀態徽章顯示的內容改變時跟著變（狀態列重新量它的空間）。 */
  toolbarStatusKey?: string;
  /** prompt 以外擋下渲染的原因（鏡頭的插件檢查），一項一句：專業編輯器的狀態列一起列出，不會只說「可以送出」。 */
  blockers?: readonly string[];
  /** 編輯區與問題列之間的內容（鏡頭的生成列）。 */
  afterEditor?: ReactNode;
  className?: string;
}


export function PromptEditor({
  value,
  onChange,
  references,
  library,
  referenceEditing,
  id,
  disabled = false,
  durationSeconds: seconds = null,
  durationFrames,
  fps = H3_RULES.fps,
  mode,
  drivenByReferences = false,
  contextLabel,
  placeholder,
  toolbarStatus,
  toolbarStatusKey,
  blockers,
  afterEditor,
  className,
}: PromptEditorProps) {
  const durationSeconds = seconds ?? (durationFrames !== undefined && durationFrames > 0 ? durationFrames / fps : null);
  const frames = durationFrames ?? (durationSeconds !== null ? Math.round(durationSeconds * fps) : 0);
  const [view, setView] = useState<"text" | "blocks">("text");
  const [formatOpen, setFormatOpen] = useState(false);
  const [workbench, setWorkbench] = useState<{ selection: number | "full"; tab: WorkbenchTab } | null>(null);
  // 逐鏡描述: mounted from its first opening; each opening is a new session (a fresh copy of the prompt), and closing
  // keeps it mounted so the dialog can play its exit
  const [shotDialog, setShotDialog] = useState<{ open: boolean; session: number } | null>(null);
  const editorRef = useRef<MentionTextareaHandle>(null);
  // 區塊檢視中按「@ 參考」：先切回文字檢視，textarea 掛上後再插入
  const pendingInsertRef = useRef<((handle: MentionTextareaHandle) => void) | null>(null);
  // 插入範本後：選取它的第一個 [TODO: …]，直接打字就換掉
  const pendingSelectRef = useRef<{ start: number; end: number } | null>(null);
  const notice = useChangeNotice(value, onChange);
  const doc = useMemo(() => parsePrompt(value), [value]);
  const shotCount = useMemo(() => parseShotLayout(value)?.shots.length ?? 0, [value]);
  const compiled = useMemo(() => compilePrompt(value, references, library), [value, references, library]);
  const options = useMemo(() => mentionOptions(references, library), [references, library]);
  const templates = useMemo(() => promptTemplates({ ...(mode === undefined ? {} : { mode }), frames, references, library }), [mode, frames, references, library]);
  const starts = useMemo(() => startTemplates(templates, mode), [templates, mode]);
  const empty = value.trim() === "";
  const problems = compiled.problems.filter((problem) => problem !== EMPTY_PROMPT_PROBLEM);
  // 空白的 prompt 還沒寫，不先警告「參考沒用到」；驅動素材的路線不靠 @ 名稱用參考
  const used = new Set(compiled.usedAliases);
  const unused = empty || drivenByReferences ? [] : [...new Set(references.map((ref) => ref.alias))].filter((alias) => !used.has(alias));

  useEffect(() => {
    const action = pendingInsertRef.current;
    if (view !== "text" || !action || !editorRef.current) return;
    pendingInsertRef.current = null;
    action(editorRef.current);
  }, [view]);

  useLayoutEffect(() => {
    const range = pendingSelectRef.current;
    if (!range || view !== "text" || !editorRef.current) return;
    pendingSelectRef.current = null;
    editorRef.current.selectRange(range.start, range.end);
  }, [value, view]);

  const tooLong = () => { notice.report(t("插入後會超過 {promptMaxLength} 字元上限，沒有插入", { promptMaxLength: PROMPT_MAX_LENGTH.toLocaleString("en-US") })); };
  const openWorkbench = (tab: WorkbenchTab, selection: number | "full" = "full") => { setWorkbench({ selection, tab }); };

  /** Fills an empty prompt; otherwise a template that starts with a heading joins the end as blocks, plain text the caret. */
  const insertTemplate = (template: PromptTemplate) => {
    const message = t("已插入範本「{value}」", { value: template.title });
    // In the text view the caret lands on the template's first [TODO: …] (the block view has no caret)
    const placeholderAt = view === "text" ? firstPlaceholder(template.text) : null;
    if (empty) {
      if (notice.apply(template.text, message)) pendingSelectRef.current = placeholderAt;
      return;
    }
    if (templateHeading(template.text) !== null || view === "blocks") {
      const result = insertFragment(doc, doc.blocks.length, template.text);
      if (notice.apply(result.text, message) && placeholderAt) pendingSelectRef.current = { start: result.offset + placeholderAt.start, end: result.offset + placeholderAt.end };
      return;
    }
    if (editorRef.current?.insertText(template.text) === false) tooLong();
  };
  const pickSnippet = (snippet: StudioPromptSnippet): boolean => {
    if (view === "blocks") {
      const result = insertFragment(doc, doc.blocks.length, snippet.text);
      notice.apply(result.text, t("已把固定 Prompt「{title}」附加到最後", { title: snippet.title }));
      return true;
    }
    if (editorRef.current?.insertText(snippet.text) === false) {
      tooLong();
      return false;
    }
    return true;
  };
  const startMention = () => {
    const run = (handle: MentionTextareaHandle) => {
      if (!handle.startMention()) tooLong();
    };
    if (view === "text" && editorRef.current) {
      run(editorRef.current);
      return;
    }
    pendingInsertRef.current = run;
    setView("text");
  };

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col gap-2", className)}>
      <PromptToolbar
        view={view}
        disabled={disabled}
        empty={empty}
        templates={templates}
        mode={mode}
        onInsertTemplate={insertTemplate}
        onPickSnippet={pickSnippet}
        onManageSnippets={() => { openWorkbench("snippets"); }}
        onMention={startMention}
        shotCount={shotCount}
        onShotDescriptions={() => { setShotDialog((current) => ({ open: true, session: (current?.session ?? 0) + 1 })); }}
        onFormat={() => { setFormatOpen(true); }}
        onToggleView={() => { setView((current) => (current === "blocks" ? "text" : "blocks")); }}
        onExpand={() => { openWorkbench("snippets"); }}
      />

      <div className="relative flex min-h-32 flex-1 flex-col">
        {view === "text" ? (
          <>
            <MentionTextarea
              {...(id === undefined ? {} : { id })}
              ref={editorRef}
              value={value}
              onChange={onChange}
              options={options}
              disabled={disabled}
              maxLength={PROMPT_MAX_LENGTH}
              {...((id != null && id !== "") ? {} : { ariaLabel: "Prompt" })}
              placeholder={placeholder ?? t("描述畫面、動作、鏡頭運動與聲音；輸入 @ 插入參考素材（例如 @Image1）")}
              containerClassName="flex min-h-0 flex-1 flex-col"
              className="min-h-0 flex-1 resize-none"
            />
            {empty ? <StartTemplates templates={starts} disabled={disabled} onPick={insertTemplate} /> : null}
          </>
        ) : doc.blocks.length === 0 ? (
          <p id={id} className="grid flex-1 place-items-center rounded-lg border border-dashed border-line px-3 py-6 text-center text-caption text-fg-tertiary">
            {t("還沒有內容。切回文字檢視輸入，或展開專業編輯器用範本建立區塊。")}
          </p>
        ) : (
          <div id={id} className="grid min-h-0 min-w-0 flex-1 content-start gap-1 overflow-y-auto rounded-lg border border-line-subtle bg-sunken p-1 animate-reveal">
            <BlockOutline
              blocks={doc.blocks}
              selected={null}
              disabled={disabled}
              label={t("Prompt 區塊")}
              selectHint={t("在專業編輯器開啟")}
              onSelect={(index) => { openWorkbench("snippets", index); }}
              onMove={(index, delta) => {
                const block = doc.blocks[index];
                const name = block ? describeBlock(block).title || describeBlock(block).kind : t("區塊");
                notice.apply(serializePrompt(moveBlock(doc, index, delta)), t("已{value}「{name}」", { value: delta < 0 ? t("上移") : t("下移"), name }));
              }}
            />
          </div>
        )}
      </div>

      <PromptStatusRow
        advisor={{
          text: value,
          frames,
          references,
          library,
          ...(mode === undefined ? {} : { mode }),
          disabled,
          onOpen: () => { openWorkbench("advisor"); },
          onApplyFix: (next, label) => notice.apply(next, t("已套用：{label}", { label })),
        }}
        status={toolbarStatus}
        {...(toolbarStatusKey === undefined ? {} : { statusKey: toolbarStatusKey })}
      />

      <ProblemsRow problems={problems} unused={unused} length={value.length} notice={notice} onShowAll={() => { openWorkbench("snippets"); }} />

      {afterEditor}

      {formatOpen ? <FormatDialog open onOpenChange={setFormatOpen} value={value} onApply={(next, message) => void notice.apply(next, message)} /> : null}
      {shotDialog ? (
        <LazyBoundary>
          <Suspense fallback={null}>
            <ShotDescriptionsDialog
              key={shotDialog.session}
              open={shotDialog.open}
              onOpenChange={(open) => { setShotDialog((current) => (current ? { ...current, open } : current)); }}
              value={value}
              references={references}
              library={library}
              durationSeconds={durationSeconds}
              disabled={disabled}
              onSave={(next, message) => notice.apply(next, message)}
            />
          </Suspense>
        </LazyBoundary>
      ) : null}
      {workbench ? (
        <LazyBoundary>
          <Suspense fallback={null}>
            <PromptWorkbench
              value={value}
              onChange={onChange}
              references={references}
              library={library}
              {...(referenceEditing === undefined ? {} : { referenceEditing })}
              durationSeconds={durationSeconds}
              frames={frames}
              {...(mode === undefined ? {} : { mode })}
              drivenByReferences={drivenByReferences}
              {...(contextLabel === undefined ? {} : { contextLabel })}
              disabled={disabled}
              initialSelection={workbench.selection}
              initialTab={workbench.tab}
              {...(blockers === undefined ? {} : { blockers })}
              onClose={() => { setWorkbench(null); }}
            />
          </Suspense>
        </LazyBoundary>
      ) : null}
    </div>
  );
}
