// 屬性面板內的固定 Prompt 挑選器（工具列「固定 Prompt ▾」的浮層內容）：搜尋、分類、點一下插入。管理（新增／編輯／刪除）
// 在專業編輯器。外觀：群組卡（放進浮層時由 className 去掉邊框與底色），展開時 reveal；清單逐項進場；分類是膠囊小籤。
import { focusOpenedControl } from "@/lib/dom";
import { BookMarked, LoaderCircle, Settings2 } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { StudioPromptSnippet } from "@/api/generated/contracts";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { CARD } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { usePromptLibrary } from "./libraryApi";
import { ALL_CATEGORIES, categoryFilterValue, excerpt, filterSnippets, snippetCategories, UNCATEGORIZED } from "./snippets";
import { t } from "@/i18n";

export function SnippetPicker({
  id,
  onPick,
  onManage,
  onClose,
  hint,
  className,
}: {
  id: string;
  onPick: (snippet: StudioPromptSnippet) => void;
  onManage: () => void;
  /** Esc：關閉並把焦點還給觸發按鈕（呼叫端負責）。 */
  onClose: () => void;
  /** 點選後會發生什麼（例如「插入到游標位置」）。 */
  hint: string;
  className?: string;
}) {
  const query = usePromptLibrary();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const snippets = query.data?.snippets ?? [];
  const categories = snippetCategories(snippets);
  const items = filterSnippets(snippets, search, category);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The input method's Escape cancels its composition in the search field, not the picker
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <div /* eslint-disable-line jsx-a11y-x/no-noninteractive-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  id={id} role="region" aria-label={t("插入固定 Prompt")} onKeyDown={onKeyDown} className={cn(CARD, "grid min-w-0 gap-2 p-2 animate-reveal", className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-1.5">
        <Input compact ref={focusOpenedControl} value={search} onChange={(event) => { setSearch(event.target.value); }} placeholder={t("搜尋名稱或內容")} aria-label={t("搜尋固定 Prompt")} />
        <Select compact value={category} onChange={(event) => { setCategory(event.target.value); }} aria-label={t("分類")}>
          <option value={ALL_CATEGORIES}>{t("全部分類")}</option>
          {categories.map((name) => (
            <option key={name} value={categoryFilterValue(name)}>
              {name}
            </option>
          ))}
          <option value={UNCATEGORIZED}>{t("未分類")}</option>
        </Select>
      </div>
      {query.isPending ? (
        <p className="flex items-center gap-2 px-1 text-caption text-fg-tertiary">
          <LoaderCircle aria-hidden className="size-3.5 text-brand-cyan animate-spin" />
          {t("讀取固定 Prompt…")}
        </p>
      ) : query.isError ? (
        <ErrorCallout error={query.error} title={t("讀不到固定 Prompt 片段庫")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : snippets.length === 0 ? (
        <p className="px-1 text-caption leading-5 text-fg-tertiary">{t("還沒有固定 Prompt。到專業編輯器右側「固定 Prompt」新增，或把選取的文字存成片段。")}</p>
      ) : items.length === 0 ? (
        <p className="px-1 text-caption text-fg-tertiary">{t("沒有符合的固定 Prompt。")}</p>
      ) : (
        <ul className="grid max-h-60 min-w-0 gap-0.5 overflow-y-auto" aria-label={t("固定 Prompt（{itemsCount}）", { itemsCount: items.length })}>
          {items.map((snippet, index) => (
            <li key={snippet.snippet_id} className={"min-w-0"} ref={reveal(index)}>
              <button
                type="button"
                onClick={() => { onPick(snippet); }}
                className="grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-raised/70 active:bg-sunken"
              >
                <BookMarked aria-hidden className="mt-0.5 size-3.5 text-fg-tertiary" />
                <span className="grid min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-data text-fg">{snippet.title}</span>
                    {(snippet.category != null && snippet.category !== "") ? (
                      <span className="max-w-[45%] shrink-0 truncate rounded-full border border-line-subtle px-1.5 text-[11px] leading-4 text-fg-tertiary" title={snippet.category}>
                        {snippet.category}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-caption text-fg-tertiary">{excerpt(snippet.text, 60)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle pt-1.5">
        <span className="text-caption text-fg-tertiary">{hint}</span>
        <Button size="sm" variant="quiet" className="min-h-7 px-2" icon={<Settings2 aria-hidden />} onClick={onManage}>
          {t("管理片段")}
        </Button>
      </div>
    </div>
  );
}
