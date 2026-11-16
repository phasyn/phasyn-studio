// 專業編輯器右側的固定 Prompt 片段庫：搜尋、分類、插入到游標／附加為新區塊、把選取文字或目前區塊存成片段、
// 編輯與刪除。整份片段庫以 revision 保存；409 → 已重新載入並告知，草稿保留，絕不自動重送。
// 外觀：表單與展開的片段以 reveal 出現；清單逐項 rise-in（stagger）；分類是膠囊小籤；空片段庫用 EmptyState。
import { BookMarked, ClipboardPlus, CornerDownLeft, ListPlus, LoaderCircle, Pencil, Plus, Save, Trash2, TriangleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { StudioPromptLibrary } from "@/api/generated/contracts";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { hasErrorCode } from "@/lib/errors";
import { reveal } from "@/components/ui/motion";
import { usePromptLibrary, useSavePromptLibrary } from "./libraryApi";
import {
  ALL_CATEGORIES,
  categoryFilterValue,
  draftOf,
  emptyDraft,
  excerpt,
  filterSnippets,
  newSnippetId,
  removeSnippet,
  SNIPPET_LIMITS,
  snippetCategories,
  snippetDraftError,
  UNCATEGORIZED,
  upsertSnippet,
  type SnippetDraft,
} from "./snippets";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

interface FormState {
  /** null＝新增。 */
  id: string | null;
  draft: SnippetDraft;
  error: string | null;
  /** 編輯中的片段已被刪除（error 是這個原因時才為 true）：提供「改成另存新片段」。以旗標判斷，不比對錯誤文字。 */
  missing?: boolean;
}

export function SnippetLibraryPanel({
  onInsertAtCursor,
  onAppendBlock,
  readSelection,
  currentBlock,
  disabled = false,
}: {
  onInsertAtCursor: (text: string) => void;
  onAppendBlock: (text: string, title: string) => void;
  /** 編輯區目前選取的文字。 */
  readSelection: () => string;
  /** 目前選取的區塊（存成片段用）；全文模式為 null。 */
  currentBlock: { title: string; text: string } | null;
  disabled?: boolean;
}) {
  const id = useId();
  const query = usePromptLibrary();
  const save = useSavePromptLibrary();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const library = query.data ?? null;
  const snippets = library?.snippets ?? [];
  const categories = snippetCategories(snippets);
  const items = filterSnippets(snippets, search, category);
  const selected = snippets.find((snippet) => snippet.snippet_id === selectedId) ?? null;
  const busy = save.isPending || disabled;
  const conflict = save.isError && hasErrorCode(save.error, "REVISION_CONFLICT");

  const persist = (next: StudioPromptLibrary, done: (saved: StudioPromptLibrary) => void) => {
    setFeedback(null);
    save.mutate(next, {
      onSuccess: done,
      onError: (error) => {
        if (hasErrorCode(error, "REVISION_CONFLICT")) {
          setFeedback({ tone: "warning", text: t("片段庫已在其他地方更新，已重新載入最新內容；這次的變更沒有保存。確認內容後再操作一次。") });
        }
      },
    });
  };

  const openForm = (state: FormState) => {
    save.reset();
    setFeedback(null);
    setConfirmDelete(null);
    setForm(state);
  };

  const submit = () => {
    if (!form || !library) return;
    const problem = snippetDraftError(form.draft);
    if (problem) {
      setForm({ ...form, error: problem, missing: false });
      return;
    }
    if (form.id !== null && !library.snippets.some((snippet) => snippet.snippet_id === form.id)) {
      setForm({ ...form, error: t("這個片段已被刪除（可能是在其他視窗）；可以改成另存新片段"), missing: true });
      return;
    }
    if (form.id === null && library.snippets.length >= SNIPPET_LIMITS.count) {
      setForm({ ...form, error: t("片段庫最多 {count} 筆", { count: SNIPPET_LIMITS.count }), missing: false });
      return;
    }
    const newId = newSnippetId();
    const next = upsertSnippet(library, form.draft, { id: form.id, now: new Date().toISOString(), newId: () => newId });
    const title = form.draft.title.trim();
    persist(next, (saved) => {
      setForm(null);
      setSelectedId(form.id ?? newId);
      setFeedback({ tone: "success", text: t("已保存「{title}」（片段庫 revision {revision}）", { title, revision: saved.revision }) });
    });
  };

  const remove = (snippetId: string) => {
    if (!library) return;
    const title = snippets.find((snippet) => snippet.snippet_id === snippetId)?.title ?? snippetId;
    persist(removeSnippet(library, snippetId), (saved) => {
      setConfirmDelete(null);
      setSelectedId(null);
      setFeedback({ tone: "success", text: t("已刪除「{title}」（片段庫 revision {revision}）", { title, revision: saved.revision }) });
    });
  };

  const fromSelection = () => {
    const text = readSelection();
    if (text.trim().length === 0) {
      setFeedback({ tone: "warning", text: t("先在中間的編輯區選取要保存的文字。") });
      return;
    }
    openForm({ id: null, draft: emptyDraft(text, excerpt(text, 24)), error: null });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-2 border-b border-line-subtle p-3">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] gap-1.5">
          <Input compact value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜尋名稱或內容")} aria-label={t("搜尋固定 Prompt")} />
          <Select compact value={category} onChange={(event) => setCategory(event.target.value)} aria-label={t("分類")}>
            <option value={ALL_CATEGORIES}>{t("全部分類")}</option>
            {categories.map((name) => (
              <option key={name} value={categoryFilterValue(name)}>
                {name}
              </option>
            ))}
            <option value={UNCATEGORIZED}>{t("未分類")}</option>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="secondary" className="min-h-7 px-2" icon={<Plus aria-hidden />} disabled={busy || !library} onClick={() => openForm({ id: null, draft: emptyDraft(), error: null })}>
            {t("新增")}
          </Button>
          <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<ClipboardPlus aria-hidden />} disabled={busy || !library} onClick={fromSelection}>
            {t("選取文字存成片段")}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            className="min-h-7 px-2"
            icon={<ListPlus aria-hidden />}
            disabled={busy || !library || !currentBlock}
            title={currentBlock ? undefined : t("先在左側選一個區塊")}
            onClick={() => currentBlock && openForm({ id: null, draft: emptyDraft(currentBlock.text, currentBlock.title), error: null })}
          >
            {t("目前區塊存成片段")}
          </Button>
        </div>
        {feedback ? (
          <p role="status" className={cn("flex items-start gap-1.5 text-caption", feedback.tone === "success" ? "text-success" : "text-warning")}>
            {feedback.tone === "warning" ? <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
            {feedback.text}
          </p>
        ) : null}
        {save.isError && !conflict ? <ErrorCallout error={save.error} write title={t("片段庫沒有保存")} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      </div>

      {form ? (
        <form
          className="grid gap-2 border-b border-line-subtle bg-canvas p-3 animate-reveal"
          data-escape-local="true"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setForm(null);
            }
          }}
          aria-label={form.id ? t("編輯固定 Prompt") : t("新增固定 Prompt")}
        >
          <p className="text-data font-semibold text-fg">{form.id ? t("編輯固定 Prompt") : t("新增固定 Prompt")}</p>
          <label className="grid gap-1 text-caption text-fg-secondary" htmlFor={`${id}-title`}>
            {t("名稱")}
            <Input
              id={`${id}-title`}
              compact
              autoFocus
              value={form.draft.title}
              maxLength={SNIPPET_LIMITS.title}
              onChange={(event) => setForm({ ...form, draft: { ...form.draft, title: event.target.value }, error: null, missing: false })}
            />
          </label>
          <label className="grid gap-1 text-caption text-fg-secondary" htmlFor={`${id}-category`}>
            <T source={"分類（可留空）<0/>{datalist}"} values={{ datalist: <datalist id={`${id}-categories`}>
              {categories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist> }} slots={[<Input
              id={`${id}-category`}
              compact
              list={`${id}-categories`}
              value={form.draft.category}
              maxLength={SNIPPET_LIMITS.category}
              onChange={(event) => setForm({ ...form, draft: { ...form.draft, category: event.target.value }, error: null, missing: false })}
            />]} />
          </label>
          <label className="grid gap-1 text-caption text-fg-secondary" htmlFor={`${id}-text`}>
            {t("內容")}
            <Textarea
              id={`${id}-text`}
              compact
              value={form.draft.text}
              maxLength={SNIPPET_LIMITS.text}
              rows={6}
              onChange={(event) => setForm({ ...form, draft: { ...form.draft, text: event.target.value }, error: null, missing: false })}
              className="leading-6"
            />
          </label>
          {form.error ? (
            <p role="alert" className="text-caption text-danger">
              {form.error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-1.5">
            {form.id !== null && form.missing && form.error !== null ? (
              <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, id: null, error: null, missing: false })}>
                {t("改成另存新片段")}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setForm(null)} disabled={save.isPending}>
              {t("取消")}
            </Button>
            <Button size="sm" variant="primary" type="submit" icon={<Save aria-hidden />} pending={save.isPending}>
              {t("儲存")}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query.isPending ? (
          <p className="flex items-center gap-2 p-2 text-caption text-fg-tertiary">
            <LoaderCircle aria-hidden className="size-3.5 text-brand-cyan animate-spin" />
            {t("讀取固定 Prompt…")}
          </p>
        ) : query.isError ? (
          <ErrorCallout error={query.error} title={t("讀不到固定 Prompt 片段庫")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : snippets.length === 0 ? (
          <EmptyState size="compact" icon={<BookMarked />} title={t("還沒有固定 Prompt")} description={t("把常用的風格、角色描述或聲音設定存起來，之後在任何鏡頭一鍵插入。")} />
        ) : items.length === 0 ? (
          <p className="p-2 text-caption text-fg-tertiary">{t("沒有符合的固定 Prompt。")}</p>
        ) : (
          <ul className="grid gap-0.5" aria-label={t("固定 Prompt（{itemsCount}）", { itemsCount: items.length })}>
            {items.map((snippet, index) => {
              const open = snippet.snippet_id === selectedId;
              return (
                <li
                  key={snippet.snippet_id}
                  ref={reveal(index)}
                  className={cn("min-w-0 rounded-lg border transition-colors duration-(--duration-fast)", open ? "border-line bg-raised/50" : "border-transparent")}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      setSelectedId(open ? null : snippet.snippet_id);
                      setConfirmDelete(null);
                    }}
                    className="grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-raised/70 active:bg-sunken"
                  >
                    <BookMarked aria-hidden className={cn("mt-0.5 size-3.5", open ? "text-brand-cyan" : "text-fg-tertiary")} />
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-data text-fg">{snippet.title}</span>
                        {snippet.category ? (
                          <span className="max-w-[45%] shrink-0 truncate rounded-full border border-line-subtle px-1.5 text-[11px] leading-4 text-fg-tertiary" title={snippet.category}>
                            {snippet.category}
                          </span>
                        ) : null}
                      </span>
                      {open ? null : <span className="truncate text-caption text-fg-tertiary">{excerpt(snippet.text, 60)}</span>}
                    </span>
                  </button>
                  {open && selected ? (
                    <div className="grid gap-2 px-2 pb-2 animate-reveal">
                      <p className="max-h-40 overflow-y-auto rounded-md bg-sunken px-2 py-1.5 text-caption leading-5 whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{selected.text}</p>
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="secondary" className="min-h-7 px-2" icon={<CornerDownLeft aria-hidden />} disabled={disabled} onClick={() => onInsertAtCursor(selected.text)}>
                          {t("插入到游標")}
                        </Button>
                        <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<ListPlus aria-hidden />} disabled={disabled} onClick={() => onAppendBlock(selected.text, selected.title)}>
                          {t("附加為新區塊")}
                        </Button>
                        <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<Pencil aria-hidden />} disabled={busy} onClick={() => openForm({ id: selected.snippet_id, draft: draftOf(selected), error: null })}>
                          {t("編輯")}
                        </Button>
                        <Button ref={deleteButton} size="sm" variant="danger" className="min-h-7 px-2" icon={<Trash2 aria-hidden />} disabled={busy} onClick={() => setConfirmDelete(selected.snippet_id)}>
                          {t("刪除")}
                        </Button>
                      </div>
                      {confirmDelete === selected.snippet_id ? (
                        <Callout tone="danger" title={t("刪除「{title}」？", { title: selected.title })}>
                          <p>{t("會從所有專案共用的固定 Prompt 片段庫移除；已經插入到鏡頭 prompt 的文字不受影響。")}</p>
                          <div className="flex gap-1.5 pt-1">
                            <Button size="sm" variant="danger-confirm" pending={save.isPending} onClick={() => remove(selected.snippet_id)}>
                              {t("確定刪除")}
                            </Button>
                            {/* 確認框連同按鈕一起消失：焦點回到「刪除」，不掉到頁面 */}
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setConfirmDelete(null);
                                deleteButton.current?.focus();
                              }}
                              disabled={save.isPending}
                            >
                              {t("取消")}
                            </Button>
                          </div>
                        </Callout>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {library ? (
        <p className="border-t border-line-subtle px-3 py-1 text-caption text-fg-tertiary">
          <T source={"<0>{snippetsCount}</0> 筆 · 片段庫 revision <1>{revision}</1>"} values={{ snippetsCount: snippets.length, revision: library.revision }} slots={[<span className="machine" />, <span className="machine" />]} />
        </p>
      ) : null}
    </div>
  );
}
