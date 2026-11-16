// 有 @ 參考自動完成的 textarea：輸入 @ 會在游標下方列出這個鏡頭的參考（縮圖、alias、檔名、H3 標籤），
// ↑／↓ 選擇、Enter 或 Tab 插入、Esc 關閉（輸入法組字中不攔截按鍵）；Ctrl＋Enter 照常往外傳（渲染快捷鍵）。
// 文字裡的 @ 名稱看得見（MentionLayer）：對得到參考的畫成青色膠囊，對不到的畫紅色虛線底線；滑鼠停在名稱上或游標在
// 名稱裡時，旁邊出現參考的縮圖與檔名（MentionCard）。textarea 本身完全是原生的（打字、選取、輸入法、捲動）。
// 對外提供插入文字／參考、讀取選取範圍的 handle（固定 Prompt 與參考清單用）。候選清單的外觀在 MentionMenu。
import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from "react";
import { cn } from "@/lib/cn";
import { caretPoint } from "./caret";
import { MentionCard } from "./MentionCard";
import { MentionLayer } from "./MentionLayer";
import { MENU_WIDTH, MentionMenu } from "./MentionMenu";
import { mentionMarks } from "./mentionMarks";
import { applyMention, filterMentions, insertAtSign, insertMentionAt, insertSnippetAt, mentionQueryAt, type MentionOption } from "./mentions";
import { useMentionCard } from "./useMentionCard";
import { t } from "@/i18n";

export interface MentionTextareaHandle {
  focus: () => void;
  /** 在游標（或選取範圍之後）插入文字；超過字數上限時不插入並回傳 false。 */
  insertText: (text: string) => boolean;
  /** 在游標插入 @alias。 */
  insertMention: (alias: string) => boolean;
  /** 在游標插入 @ 並打開候選清單。 */
  startMention: () => boolean;
  /** 目前的選取範圍與文字。 */
  selection: () => { start: number; end: number; text: string };
  /** 選取 [start, end) 並捲動到看得見的位置（修正與建議「跳到這段」）。 */
  selectRange: (start: number, end: number) => void;
}

export interface MentionTextareaProps {
  value: string;
  onChange: (next: string) => void;
  options: readonly MentionOption[];
  ref?: Ref<MentionTextareaHandle>;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  /** 外層容器（定位候選清單用）的 class，例如要填滿高度時。 */
  containerClassName?: string;
  /** 沒有外部 <label> 時的無障礙名稱。 */
  ariaLabel?: string;
  describedBy?: string;
  onFocus?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
}

interface MenuState {
  start: number;
  end: number;
  query: string;
  active: number;
  top: number;
  left: number;
}

const OPTION_HEIGHT = 50;

export function MentionTextarea({
  value,
  onChange,
  options,
  ref,
  id,
  disabled,
  placeholder,
  maxLength,
  className,
  containerClassName,
  ariaLabel,
  describedBy,
  onFocus,
  onBlur,
}: MentionTextareaProps) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<{ text: string; caret: number } | null>(null);
  // 使用者從沒把游標放進來時，「插入到游標」改成插在文末（textarea 預設游標在開頭）
  const everFocused = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const filtered = menu ? filterMentions(options, menu.query) : [];
  const active = menu ? Math.min(menu.active, Math.max(0, filtered.length - 1)) : 0;
  const activeOption = filtered[active];
  const menuRef = useRef<HTMLDivElement>(null);
  const byAlias = useMemo(() => new Map(options.map((option) => [option.alias, option])), [options]);
  const aliases = useMemo(() => new Set(byAlias.keys()), [byAlias]);
  const missing = useMemo(() => new Set(options.filter((option) => option.item === null).map((option) => option.alias)), [options]);
  const marks = useMemo(() => mentionMarks(value, aliases), [value, aliases]);
  const card = useMentionCard(layerRef, aliases);
  const cardMark = card.target && !menu ? marks.find((mark) => mark.start === card.target?.start && mark.resolved) : undefined;
  const cardOption = cardMark ? byAlias.get(cardMark.alias) : undefined;

  // 程式插入後把游標放到插入點後面（等新的 value 已經寫進 textarea）
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    const node = textareaRef.current;
    if (!pending || !node) return;
    pendingCaret.current = null;
    if (node.value !== pending.text) return;
    node.focus();
    node.setSelectionRange(pending.caret, pending.caret);
  }, [value]);

  // 上下鍵移到清單外的選項時捲到看得見（清單最多顯示約 6 個）
  const activeAlias = menu ? activeOption?.alias : undefined;
  useLayoutEffect(() => {
    if (activeAlias === undefined) return;
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeAlias]);

  const commit = (result: { text: string; caret: number }): boolean => {
    if (maxLength !== undefined && result.text.length > maxLength) return false;
    pendingCaret.current = result;
    onChange(result.text);
    return true;
  };

  const refresh = (node: HTMLTextAreaElement) => {
    card.onCaret(node);
    if (node.selectionStart !== node.selectionEnd) {
      setMenu(null);
      return;
    }
    const query = mentionQueryAt(node.value, node.selectionStart);
    if (!query) {
      setMenu(null);
      if (dismissedAt !== null) setDismissedAt(null);
      return;
    }
    if (query.start === dismissedAt) {
      setMenu(null);
      return;
    }
    const point = caretPoint(node, query.start);
    const visibleTop = point.top - node.scrollTop;
    const listHeight = Math.min(Math.max(filterMentions(options, query.query).length, 1), 6) * OPTION_HEIGHT + 12;
    const above = visibleTop + point.height + listHeight > node.clientHeight + 16 && visibleTop > listHeight;
    const top = node.offsetTop + (above ? visibleTop - listHeight - 4 : visibleTop + point.height + 4);
    const left = Math.max(0, node.offsetLeft + Math.min(point.left - node.scrollLeft, Math.max(0, node.clientWidth - MENU_WIDTH)));
    setMenu((current) => ({ ...query, active: current && current.start === query.start ? current.active : 0, top, left }));
  };

  const choose = (option: MentionOption) => {
    const node = textareaRef.current;
    if (!node || !menu) return;
    setMenu(null);
    // 游標停在剛插入的名稱後面時不要再打開候選清單（移開後自動恢復）
    setDismissedAt(menu.start);
    commit(applyMention(node.value, menu, option.alias));
  };

  // 每次 render 重建 handle：插入時一定用到最新的 onChange 與 maxLength；位置與文字直接讀 textarea
  useImperativeHandle(ref, () => {
    const current = () => {
      const node = textareaRef.current;
      const text = node?.value ?? value;
      if (!node || !everFocused.current) return { text, start: text.length, end: text.length };
      return { text, start: node.selectionStart, end: node.selectionEnd };
    };
    return {
      focus: () => {
        const node = textareaRef.current;
        if (!node) return;
        if (!everFocused.current) node.setSelectionRange(node.value.length, node.value.length);
        node.focus();
      },
      insertText: (text) => {
        const { text: before, end } = current();
        return commit(insertSnippetAt(before, end, text));
      },
      insertMention: (alias) => {
        const { text: before, end } = current();
        const result = insertMentionAt(before, end, alias);
        setDismissedAt(result.at);
        return commit(result);
      },
      startMention: () => {
        const { text: before, end } = current();
        setDismissedAt(null);
        return commit(insertAtSign(before, end));
      },
      selection: () => {
        const { text, start, end } = current();
        return { start, end, text: text.slice(start, end) };
      },
      selectRange: (start, end) => {
        const node = textareaRef.current;
        if (!node) return;
        const from = Math.max(0, Math.min(start, node.value.length));
        const to = Math.max(from, Math.min(end, node.value.length));
        node.focus();
        node.setSelectionRange(from, to);
        node.scrollTop = Math.max(0, caretPoint(node, from).top - node.clientHeight / 3);
      },
    };
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menu || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(menu.start);
      setMenu(null);
      return;
    }
    if (filtered.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setMenu({ ...menu, active: (active + step + filtered.length) % filtered.length });
    } else if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      if (activeOption) choose(activeOption);
    }
  };

  const optionId = (alias: string) => `${listId}-${alias}`;
  const announcement = menu
    ? filtered.length > 0
      ? t("{filteredCount} 個參考可插入，上下鍵選擇、Enter 插入、Esc 關閉", { filteredCount: filtered.length })
      : t("沒有符合的參考")
    : cardOption && card.target?.fromCaret
      ? t("@{alias}：{name}", { alias: cardOption.alias, name: cardOption.name ?? t("檔案已不在素材庫") })
      : "";
  return (
    // The field's fill sits on this box, under the highlight layer; the textarea above it is transparent
    <div ref={containerRef} className={cn("relative min-w-0 rounded-md bg-sunken", containerClassName)}>
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-controls={menu ? listId : undefined}
        aria-activedescendant={menu && activeOption ? optionId(activeOption.alias) : undefined}
        data-escape-local={menu ? "true" : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          refresh(event.target);
        }}
        onSelect={(event) => refresh(event.currentTarget)}
        onKeyDown={onKeyDown}
        onScroll={() => {
          setMenu(null);
          card.hide();
        }}
        onPointerMove={card.onPointerMove}
        onPointerLeave={card.onPointerLeave}
        onFocus={(event) => {
          everFocused.current = true;
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setMenu(null);
          card.hide();
          onBlur?.(event);
        }}
        className={cn(
          "relative z-[1] block w-full min-w-0 rounded-md border border-line-control bg-transparent px-2.5 py-2 text-data leading-6 text-fg transition-colors duration-150 [scrollbar-gutter:stable] placeholder:text-fg-tertiary hover:border-fg-tertiary disabled:cursor-not-allowed disabled:border-line-strong disabled:text-fg-disabled",
          className,
        )}
      />
      {/* After the textarea: its ref is attached before this layer's first layout effect reads it; z-[1] keeps the
          textarea's glyphs above the marks */}
      {marks.length > 0 ? <MentionLayer textarea={textareaRef} contentRef={layerRef} text={value} marks={marks} missing={missing} /> : null}
      {cardMark && cardOption ? <MentionCard key={cardMark.start} option={cardOption} start={cardMark.start} container={containerRef} layer={layerRef} field={textareaRef} /> : null}
      {menu ? (
        <MentionMenu
          menuRef={menuRef}
          listId={listId}
          optionId={optionId}
          top={menu.top}
          left={menu.left}
          query={menu.query}
          filtered={filtered}
          active={active}
          hasOptions={options.length > 0}
          onChoose={choose}
          onHover={(index) => setMenu({ ...menu, active: index })}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
