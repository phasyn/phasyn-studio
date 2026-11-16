// 命令面板：只用鍵盤開啟（Ctrl＋K，Apple 平台 ⌘K；Video Studio 剪輯頁為 Ctrl／⌘＋Shift＋K）；app bar 不再放搜尋鈕。
// Radix Dialog 內是 APG combobox／listbox。資料只在面板開啟時讀取（PaletteBody 隨 DialogContent 掛載、關閉即卸載），沿用既有 hooks 的快取。
// 選取後：記入最近開啟 → 關閉 → 導覽；換頁時焦點交給新頁標題（routeFocus），同頁只改 query 時移到主要內容。
// 沒有導覽就關閉時，焦點回到開啟前的位置。
import {
  Boxes,
  Clapperboard,
  Compass,
  FolderKanban,
  FolderPlus,
  Gauge,
  GitCompareArrows,
  Images,
  Languages,
  ListVideo,
  LoaderCircle,
  type LucideIcon,
  Play,
  RefreshCw,
  ScanSearch,
  ScanText,
  Scissors,
  ScrollText,
  Search,
  SearchX,
  TriangleAlert,
  Wand2,
  Workflow,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { PATHS } from "@/app/paths";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { reveal } from "@/components/ui/motion";
import { providerKind } from "@/components/workbench/kinds";
import { ToolButton } from "@/components/workbench/ToolStrip";
import { TEXT_TONE, type Tone } from "@/components/workbench/tones";
import { changeLocale, getLocale, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { detectApplePlatform } from "@/lib/keyboard";
import type { CommandItem, CommandMeta } from "./model/items";
import { isNavKey, isPaletteShortcut, moveActive, pageOwnsPlainShortcut, shortcutLabel } from "./model/keyboard";
import { formatRelativeTime, formatShortTime, pathnameOf, sameTarget } from "./model/navigation";
import { buildCommandIndex, searchCommands, type CommandSection, type RankedOption, type SearchResult, type TextSegment } from "./model/search";
import { rememberRecent, useCommandSources, type SourceIssue } from "./useCommandSources";
import { T } from "@/i18n/T";

const APPLE = detectApplePlatform();
const PLACEHOLDER = t("搜尋元件、元件組合、run、專案…");

/** 目前選項：品牌淡漸層底＋左側直向漸層標記（與各頁清單的目前項目一致）。 */
const ACTIVE_OPTION =
  "bg-brand-gradient-soft before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet";

/** 鍵盤提示的小 chip。 */
const KBD = "machine mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-line bg-raised px-1.5 text-[11px] leading-none text-fg-secondary";

const PAGE_ICONS: Record<string, LucideIcon> = {
  [PATHS.image]: Images,
  [PATHS.studioGenerate]: Wand2,
  [PATHS.studioEdit]: Scissors,
  [PATHS.studioRender]: Clapperboard,
  [PATHS.studioNewProject]: FolderPlus,
  [PATHS.semantics]: ScanText,
  [PATHS.promptStudies]: ScanSearch,
  [PATHS.inferenceRun]: Play,
  [PATHS.components]: Boxes,
  [PATHS.pipelines]: Workflow,
  [PATHS.runs]: ListVideo,
  [PATHS.recordings]: ScrollText,
  [PATHS.comparisons]: GitCompareArrows,
  [PATHS.tracking]: Gauge,
};

/** 圖示與類型色：元件依 provider（與資源樹、節點圖一致），其他依種類。 */
function itemVisual(item: CommandItem): { icon: LucideIcon; tone: Tone } {
  switch (item.kind) {
    case "component": {
      const spec = providerKind(item.meta?.providerId);
      return { icon: spec.icon, tone: spec.tone };
    }
    case "pipeline":
      return { icon: Workflow, tone: "neutral" };
    case "run":
      return { icon: ListVideo, tone: "neutral" };
    case "project":
      return { icon: FolderKanban, tone: "entity" };
    case "page":
      // The whole target first: "new project" shares its pathname with the Shots workspace
      return { icon: PAGE_ICONS[item.to] ?? PAGE_ICONS[pathnameOf(item.to)] ?? Compass, tone: "neutral" };
    case "action":
      return { icon: Languages, tone: "neutral" };
  }
}

/** 目前是否有其他對話框（Radix Dialog、原生 dialog）開著；有的話快捷鍵不搶。 */
function anotherDialogOpen(own: HTMLElement | null): boolean {
  for (const node of document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    if (node === own || node.dataset.state === "closed") continue;
    return true;
  }
  return false;
}

function optionDomId(baseId: string, uid: number): string {
  return `${baseId}-option-${uid}`;
}

/** 相符文字：粗體＋前景色（不只靠顏色）；其餘文字退一階。 */
function Marked({ segments }: { segments: TextSegment[] }) {
  const searching = segments.some((segment) => segment.match);
  return segments.map((segment, index) =>
    segment.match ? (
      <span key={index} className="font-semibold text-fg">
        {segment.text}
      </span>
    ) : (
      <span key={index} className={searching ? "text-fg-secondary" : undefined}>
        {segment.text}
      </span>
    ),
  );
}

function RowTime({ time, now }: { time: NonNullable<CommandMeta["time"]>; now: number | null }) {
  const relative = now === null ? null : formatRelativeTime(time.iso, now);
  return (
    <time dateTime={time.iso} title={t("{label}：{iso}", { label: time.label, iso: formatTimestamp(time.iso) })} className="machine text-caption whitespace-nowrap text-fg-tertiary">
      <span className="sr-only">{time.label}</span>
      {relative ?? formatShortTime(time.iso)}
    </time>
  );
}

function RowMeta({ meta, now }: { meta: CommandMeta | undefined; now: number | null }) {
  if (!meta || (!meta.status && !meta.time && !meta.nodeState)) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {meta.time ? <RowTime time={meta.time} now={now} /> : null}
      {meta.nodeState ? <StatusBadge kind="directory" value={meta.nodeState} /> : null}
      {meta.status ? <StatusBadge kind={meta.status.kind} value={meta.status.value} /> : null}
    </span>
  );
}

function OptionRow({
  option,
  domId,
  active,
  first,
  order,
  now,
  onHover,
  onChoose,
}: {
  option: RankedOption;
  domId: string;
  active: boolean;
  /** 群組第一項：捲動時保留群組標題的空間。 */
  first: boolean;
  /** 在整份結果中的位置（進場錯開用）。 */
  order: number;
  now: number | null;
  onHover: () => void;
  onChoose: () => void;
}) {
  const visual = itemVisual(option.item);
  const Icon = visual.icon;
  return (
    <div
      id={domId}
      role="option"
      aria-selected={active}
      onPointerMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      ref={reveal(order)}
      className={cn("relative mx-1.5 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg py-1 pr-3 pl-2.5 transition-[background-color] duration-(--duration-fast) animate-rise-in", first && "scroll-mt-9", active && ACTIVE_OPTION)}
    >
      <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-md border border-line-subtle bg-sunken/70 [&_svg]:size-4", TEXT_TONE[visual.tone])}>
        <Icon />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-data text-fg">
          <Marked segments={option.title} />
        </span>
        {option.subtitle ? (
          <span className="machine truncate text-caption text-fg-tertiary">
            <Marked segments={option.subtitle} />
          </span>
        ) : null}
      </span>
      <RowMeta meta={option.item.meta} now={now} />
    </div>
  );
}

function sectionCount(section: CommandSection): string {
  return section.total > section.options.length ? t("{optionsCount}／{total}", { optionsCount: section.options.length, total: section.total }) : String(section.options.length);
}

function issueText(issue: SourceIssue): string {
  if (issue.state === "loading") return t("{label} 讀取中…", { label: issue.label });
  if (issue.state === "error") return t("無法讀取 {label}（已略過）", { label: issue.label });
  return t("{label} 可能過時（最近一次讀取失敗）", { label: issue.label });
}

/** 各資料來源的讀取中／失敗列：放在 listbox 之外（listbox 只容納 option），不阻擋其他群組。 */
function SourceIssues({ issues }: { issues: SourceIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul aria-label={t("資料來源狀態")} className="grid shrink-0 gap-0.5 border-t border-line-subtle px-4 py-1">
      {issues.map((issue) => (
        <li key={issue.kind} className="flex min-h-7 items-center gap-2 text-caption text-fg-secondary">
          {issue.state === "loading" ? (
            <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-info animate-spin" />
          ) : (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
          )}
          <span className="shrink-0">{issueText(issue)}</span>
          {issue.message ? (
            <span className="machine min-w-0 flex-1 truncate text-fg-tertiary" title={issue.message}>
              {issue.message}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {issue.state === "loading" ? null : (
            <ToolButton
              label={t("重試讀取 {label}", { label: issue.label })}
              aria-label={t("重試讀取 {label}", { label: issue.label })}
              icon={<RefreshCw aria-hidden />}
              text={t("重試")}
              onClick={issue.retry}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function resultStatus(result: SearchResult): string {
  if (!result.query) return "";
  if (result.matched === 0) return t("沒有結果");
  if (result.options.length < result.matched) return t("顯示 {optionsCount}／{matched} 項", { optionsCount: result.options.length, matched: result.matched });
  return t("{matched} 項結果", { matched: result.matched });
}

interface ActiveState {
  id: string;
  via: "keyboard" | "pointer";
}

/** 面板內容：只在開啟時掛載（資料來源也只在這時訂閱）。 */
function PaletteBody({ now, onChoose }: { now: number | null; onChoose: (item: CommandItem) => void }) {
  const { items, recents, issues } = useCommandSources();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<ActiveState | null>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const index = useMemo(() => buildCommandIndex(items, recents), [items, recents]);
  const result = useMemo(() => searchCommands(index, search), [index, search]);
  const { options } = result;
  const found = active ? options.findIndex((option) => option.item.id === active.id) : -1;
  const activeIndex = found >= 0 ? found : options.length > 0 ? 0 : -1;
  const activeOption = activeIndex >= 0 ? options[activeIndex] : undefined;
  const activeDomId = activeOption ? optionDomId(baseId, activeOption.uid) : undefined;
  const keyboardMoved = found >= 0 && active?.via === "keyboard";

  useEffect(() => {
    if (!activeDomId || !keyboardMoved) return;
    document.getElementById(activeDomId)?.scrollIntoView({ block: "nearest" });
  }, [activeDomId, keyboardMoved]);

  const updateSearch = (value: string) => {
    setSearch(value);
    setActive(null);
    if (listboxRef.current) listboxRef.current.scrollTop = 0;
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    // 注音／拼音組字中的中間字不拿來搜尋，組字完成（compositionend）再更新結果。
    const native = event.nativeEvent;
    if (native instanceof InputEvent && native.isComposing) return;
    updateSearch(event.target.value);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return;
    if (isNavKey(event.key)) {
      // 帶修飾鍵（Shift＋Home 選字等）交給輸入框本身。
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || options.length === 0) return;
      event.preventDefault();
      const next = options[moveActive(activeIndex, options.length, event.key)];
      if (next) setActive({ id: next.item.id, via: "keyboard" });
      return;
    }
    if (event.key === "Enter" && activeOption) {
      event.preventDefault();
      onChoose(activeOption.item);
    }
  };

  const hasOptions = options.length > 0;
  const emptyQuery = search.trim();
  const status = resultStatus(result);
  /** 每個選項在整份結果中的位置（options 依群組順序攤平）：進場錯開用。 */
  const orderOf = new Map(options.map((option, index) => [option.uid, index]));

  return (
    <>
      <div className="group/search relative flex h-16 shrink-0 items-center gap-3 border-b border-line-subtle pr-14 pl-4">
        <Search aria-hidden className="size-5 shrink-0 text-fg-tertiary transition-colors duration-(--duration-fast) group-focus-within/search:text-brand-cyan" />
        <input
          type="text"
          role="combobox"
          aria-label={t("搜尋頁面、元件、元件組合、run 與專案")}
          aria-expanded={hasOptions}
          aria-controls={listboxId}
          aria-activedescendant={activeDomId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={PLACEHOLDER}
          value={query}
          onChange={onChange}
          onCompositionEnd={(event) => updateSearch(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-section text-fg outline-hidden placeholder:text-fg-tertiary"
        />
        {/* 輸入框聚焦時，底線換成 1 px 品牌漸層（淡入）。 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-brand-gradient opacity-0 transition-opacity duration-(--duration-base) group-focus-within/search:opacity-100"
        />
      </div>

      <div ref={listboxRef} id={listboxId} role="listbox" aria-label={t("搜尋結果")} hidden={!hasOptions} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1">
        {result.sections.map((section) => {
          const headingId = `${baseId}-group-${section.group}`;
          return (
            <div key={section.group} role="group" aria-labelledby={headingId}>
              <div role="presentation" id={headingId} className="flex items-center gap-2 px-4 pt-3 pb-1 text-caption font-semibold text-fg-tertiary">
                {section.label}
                <span aria-hidden className="machine rounded-full bg-raised px-1.5 text-[11px] leading-4 font-normal">
                  {sectionCount(section)}
                </span>
              </div>
              {section.options.map((option, position) => (
                <OptionRow
                  key={option.item.id}
                  option={option}
                  domId={optionDomId(baseId, option.uid)}
                  active={option === activeOption}
                  first={position === 0}
                  order={orderOf.get(option.uid) ?? 0}
                  now={now}
                  onHover={() => {
                    if (active?.id !== option.item.id) setActive({ id: option.item.id, via: "pointer" });
                  }}
                  onChoose={() => onChoose(option.item)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {!hasOptions ? (
        <div className="grid min-h-28 flex-1 content-center justify-items-center gap-2 px-6 py-6 text-center animate-rise-in">
          <span aria-hidden className="grid size-10 place-items-center rounded-2xl border border-line bg-sunken text-fg-tertiary shadow-edge [&_svg]:size-5">
            {emptyQuery ? <SearchX /> : <Search />}
          </span>
          <p className="text-data text-fg-secondary [overflow-wrap:anywhere]">
            {emptyQuery ? t("找不到符合「{emptyQuery}」的項目", { emptyQuery }) : t("目前沒有可開啟的項目")}
          </p>
          {issues.length > 0 ? <p className="text-caption text-fg-tertiary">{t("部分來源仍在讀取或無法讀取，結果可能不完整。")}</p> : null}
        </div>
      ) : null}

      <SourceIssues issues={issues} />

      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line-subtle px-3">
        <DialogDescription className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
          <T source={"<0>↑↓</0> 移動・<1>Enter</1> 開啟・<2>Esc</2> 關閉"} slots={[<kbd className={KBD} />, <kbd className={KBD} />, <kbd className={KBD} />]} />
        </DialogDescription>
        <span role="status" className="shrink-0 text-caption text-fg-tertiary">
          {status}
        </span>
      </div>
    </>
  );
}

/**
 * 命令面板（不需 props，掛在 router 內，例如 AppShell）：沒有可見的觸發鈕，只以快捷鍵開關。
 * Ctrl＋K（Apple ⌘K）開關；Ctrl＋Shift＋P 每一頁都能用（Video Studio「編輯」的 Ctrl＋K 是新增編輯點，只有它能開）；
 * 其他對話框開著時不攔截快捷鍵。
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const location = useLocation();
  const plain = !pageOwnsPlainShortcut(location.pathname);
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 開啟前的焦點；關閉且沒有導覽時還原。 */
  const restoreRef = useRef<HTMLElement | null>(null);
  /** 這次關閉是因為選了項目（焦點交給目的頁，不還原）。 */
  const closingForNavRef = useRef(false);
  /** 剛從面板導覽的目的地（to）：路由提交後確認焦點有落點。 */
  const navTargetRef = useRef<string | null>(null);

  const show = (returnTo: HTMLElement | null) => {
    restoreRef.current = returnTo;
    closingForNavRef.current = false;
    navTargetRef.current = null;
    setOpenedAt(Date.now());
    setOpen(true);
  };

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPaletteShortcut(event, APPLE, !pageOwnsPlainShortcut(window.location.pathname))) return;
    if (!open && anotherDialogOpen(contentRef.current)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (open) {
      setOpen(false);
      return;
    }
    const focused = document.activeElement;
    show(focused instanceof HTMLElement && focused !== document.body ? focused : null);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // 路由提交後：換頁時 AppShell 已標記「焦點移到新頁標題」（PageHeader 會接手）；
  // 同一頁只改 query、或新頁沒有標題時，焦點不能掉到 <body>，改移到主要內容。
  useEffect(() => {
    const target = navTargetRef.current;
    if (target === null || !sameTarget(location.pathname, location.search, target)) return;
    navTargetRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location]);

  const choose = (item: CommandItem) => {
    if (item.action?.type === "locale") {
      // 切換語言：存偏好後重新載入整頁（不是導覽，也不記進「最近開啟」）；瀏覽器不允許保存時面板保持開著
      if (changeLocale(item.action.locale, getLocale())) setOpen(false);
      return;
    }
    rememberRecent(item);
    restoreRef.current = null;
    closingForNavRef.current = true;
    navTargetRef.current = item.to;
    setOpen(false);
    void navigate(item.to);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? show(null) : setOpen(false))}>
      <DialogContent
        ref={contentRef}
        // 浮層材質（material-popover）＋較快的彈簧進場（dialog-in 關鍵影格，snappy 彈簧 token）。
        // 進場以 ! 蓋過 DialogContent 預設的 animate-dialog-in（同權重、後輸出）；只在 motion-safe＋開啟時生效，出場仍用預設。
        className="material-popover top-[12vh] max-h-[min(70vh,35rem)] max-w-160 translate-y-0 data-[state=open]:animate-[dialog-in_var(--duration-spring-snappy)_var(--ease-spring-snappy)_backwards]!"
        onEscapeKeyDown={(event) => {
          // Esc 在輸入法組字中是取消組字，不是關閉面板。
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // 沒有觸發鈕：一律自己決定焦點（Radix 預設會把焦點交給不存在的觸發鈕）。
          event.preventDefault();
          const previous = restoreRef.current;
          restoreRef.current = null;
          if (closingForNavRef.current) {
            closingForNavRef.current = false;
            return;
          }
          if (previous?.isConnected) previous.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="sr-only">{t("命令面板（{apple}）", { apple: shortcutLabel(APPLE, plain) })}</DialogTitle>
        <PaletteBody now={openedAt} onChoose={choose} />
      </DialogContent>
    </Dialog>
  );
}
