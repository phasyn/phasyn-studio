// 紀錄表：mono 四欄（時間｜等級｜來源｜訊息），本元件是唯一的 scroll owner。
// 最新在最下面；捲在底部時自動跟隨新紀錄，往上捲就暫停並顯示「跳到最新」。一次只渲染最新的 renderCap 筆。
// 「自動換行」固定在捲動區右上角（表頭那一列的右端）：表格比面板寬而橫向捲動、或往下捲時都看得到——它正是讓長訊息
// 不用橫向捲動的開關，不能跟著表頭被捲出畫面。
import { ArrowDownToLine, ChevronsUp, WrapText } from "lucide-react";
import { memo, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CHIP_TONE, DOT_TONE, TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { formatLogTime, LEVEL_LABEL, localDateKey, type LogLevel, type LogLine, type LogSource } from "./model";
import { LEVEL_TONE, sourceSpec } from "./presentation";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

export interface LogTableProps {
  /** 已排序（由舊到新）、已篩選的紀錄。 */
  lines: readonly LogLine[];
  /** 表格的無障礙名稱（例如「活動紀錄」）。 */
  label: string;
  /** 換行模式：訊息完整換行並顯示細節；否則單行截斷（完整內容在 title）。 */
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  /** lines 為空時顯示在表頭下方的內容（讀取中、空、錯誤）。 */
  empty?: ReactNode;
  /** 一次最多渲染的最新筆數（預設 500）。 */
  renderCap?: number;
}

const DEFAULT_RENDER_CAP = 500;
/** 距離底部多少 px 內視為「在底部」（自動跟隨）。 */
const FOLLOW_SLACK_PX = 8;

const TH = "sticky top-0 z-10 h-7 border-b border-line-subtle bg-surface px-2 text-left align-middle text-caption font-medium whitespace-nowrap text-fg-tertiary first:pl-3";
const TD = "px-2 py-[3px] align-top first:pl-3";

const MESSAGE_TONE: Record<LogLevel, string> = {
  debug: "text-fg-tertiary",
  info: "text-fg-secondary",
  success: "text-fg-secondary",
  warning: "text-warning",
  error: "text-danger",
};

function SourceCell({ source }: { source: LogSource }) {
  const spec = sourceSpec(source);
  const className = cn("flex h-[18px] min-w-0 items-center gap-1.5", TEXT_TONE[spec.tone]);
  const content = (
    <>
      <spec.icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{source.label}</span>
    </>
  );
  if (source.to) {
    return (
      <Link to={source.to} title={spec.title} className={cn(className, "no-underline hover:underline")}>
        {content}
      </Link>
    );
  }
  return (
    <span title={spec.title} className={className}>
      {content}
    </span>
  );
}

const LogRow = memo(function LogRow({ line, wrap }: { line: LogLine; wrap: boolean }) {
  const tone = LEVEL_TONE[line.level];
  const time = formatLogTime(line.at);
  return (
    <tr className="transition-colors duration-(--duration-fast) hover:bg-raised/60">
      <td className={TD}>
        <span className="flex h-[18px] items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone])} />
          <time dateTime={line.at} title={line.at} className="machine whitespace-nowrap text-fg-tertiary">
            {time ?? "—"}
          </time>
        </span>
      </td>
      <td className={TD}>
        <span
          className={cn(
            "inline-flex h-[18px] min-w-11 items-center justify-center rounded-full border px-1.5 font-mono text-[10px] leading-none font-semibold tracking-wide",
            CHIP_TONE[tone],
          )}
        >
          {LEVEL_LABEL[line.level]}
        </span>
      </td>
      <td className={TD}>
        <SourceCell source={line.source} />
      </td>
      <td className={cn(TD, "machine", MESSAGE_TONE[line.level])}>
        {wrap ? (
          <>
            <p className="m-0 whitespace-pre-wrap">{line.message}</p>
            {line.detail ? <p className="m-0 whitespace-pre-wrap text-fg-tertiary">{line.detail}</p> : null}
          </>
        ) : (
          <p className="m-0 truncate" title={line.detail ? `${line.message}\n${line.detail}` : line.message}>
            {line.message}
          </p>
        )}
      </td>
    </tr>
  );
});

function DateRow({ date }: { date: string }) {
  return (
    <tr>
      <td colSpan={4} className="px-3 pt-1.5 pb-0.5">
        <span className="flex items-center gap-2">
          <span className="machine text-[11px] text-fg-tertiary">{date}</span>
          <span aria-hidden className="h-px flex-1 bg-line-subtle" />
        </span>
      </td>
    </tr>
  );
}

export function LogTable({ lines, label, wrap, onWrapChange, empty, renderCap = DEFAULT_RENDER_CAP }: LogTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 「顯示更早的」之前的捲動位置：插入較早的列後把畫面維持在原本那幾列。 */
  const expandAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [following, setFollowing] = useState(true);
  /** 暫停跟隨時最新一筆的 id（計算之後新增了幾筆）。 */
  const [pausedAfterId, setPausedAfterId] = useState<string | null>(null);
  const [limit, setLimit] = useState(renderCap);
  /** The scroll box's height at the last scroll or resize: a scroll event that comes with a new height is layout, not the user. */
  const boxHeightRef = useRef<number | null>(null);

  const start = Math.max(0, lines.length - limit);
  const shown = useMemo(() => (start > 0 ? lines.slice(start) : lines), [lines, start]);
  const unseen = useMemo(() => {
    if (following || pausedAfterId === null) return 0;
    const index = lines.findIndex((line) => line.id === pausedAfterId);
    return index === -1 ? 0 : lines.length - 1 - index;
  }, [following, pausedAfterId, lines]);

  // 內容變動後（新紀錄、換行切換、展開較早的列）：跟隨中就貼齊底部；展開較早的列時維持原本的畫面位置。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = expandAnchorRef.current;
    if (anchor) {
      expandAnchorRef.current = null;
      // 瀏覽器的 scroll anchoring 已經調整過就不再重複調整。
      if (Math.abs(element.scrollTop - anchor.top) < 1) element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
      return;
    }
    if (following) {
      element.scrollTop = element.scrollHeight;
      // The height it was pinned at: a scroll event with another height (the box shrank) is layout, not the user
      boxHeightRef.current = element.clientHeight;
    }
  }, [shown, following, wrap]);

  // dock 改變高度時（拖曳、收合後展開、上方的篩選列收合成兩列）仍貼齊底部。
  const keepPinned = useEffectEvent(() => {
    const element = scrollRef.current;
    if (!element) return;
    boxHeightRef.current = element.clientHeight;
    if (following) element.scrollTop = element.scrollHeight;
  });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => keepPinned());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const resized = boxHeightRef.current !== null && boxHeightRef.current !== element.clientHeight;
    boxHeightRef.current = element.clientHeight;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
    // The box got shorter under a followed table (the scroll event can arrive before the ResizeObserver): stay pinned
    if (!atBottom && following && resized) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (atBottom === following) return;
    setFollowing(atBottom);
    setPausedAfterId(atBottom ? null : (lines.at(-1)?.id ?? null));
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setPausedAfterId(null);
  };

  const showEarlier = () => {
    const element = scrollRef.current;
    expandAnchorRef.current = element ? { height: element.scrollHeight, top: element.scrollTop } : null;
    setLimit((value) => value + renderCap);
  };

  const rows: ReactNode[] = [];
  let previousDate: string | null = null;
  for (const line of shown) {
    const date = localDateKey(line.at);
    if (date !== null && date !== previousDate) rows.push(<DateRow key={`date:${date}:${line.id}`} date={date} />);
    if (date !== null) previousDate = date;
    rows.push(<LogRow key={line.id} line={line} wrap={wrap} />);
  }

  return (
    // @container/log: the source column narrows in tables narrower than 40rem (see the colgroup)
    <div className="@container/log relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label={t("{label}（捲動區）", { label })}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-offset-[-2px]"
      >
        {/* 高度 0、寬度＝捲動區可視寬度，黏在左上角：右端永遠是可視範圍的右緣，表格沒有捲動時就是「訊息」欄表頭的右端 */}
        <div className="sticky top-0 left-0 z-20 flex h-0 justify-end">
          <button
            type="button"
            aria-pressed={wrap}
            aria-label={t("自動換行")}
            title={wrap ? t("改回單行（超出部分截斷，完整內容在提示中）") : t("自動換行並顯示細節")}
            onClick={() => onWrapChange(!wrap)}
            className="pressable mt-0.5 mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-surface text-fg-tertiary transition-colors duration-(--duration-fast) hover:bg-raised hover:text-fg active:bg-sunken active:duration-0 aria-pressed:bg-brand-soft aria-pressed:text-fg"
          >
            <WrapText aria-hidden className="size-3.5" />
          </button>
        </div>
        <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-caption">
          <colgroup>
            <col className="w-[7.5rem]" />
            <col className="w-16" />
            {/* 來源欄：寬的表格 11rem；比 40rem 窄時（輸出面板）改用表格寬的 24%，訊息欄才有空間。col 的寬度只接受長度或百分比
                （clamp()／min() 會被當成 auto），所以用容器查詢切換 */}
            <col className="w-44 @max-[40rem]/log:w-[24%]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {t("時間")}
              </th>
              <th scope="col" className={TH}>
                {t("等級")}
              </th>
              <th scope="col" className={TH}>
                {t("來源")}
              </th>
              {/* 右側留給上面固定的「自動換行」 */}
              <th scope="col" className={cn(TH, "pr-9")}>
                {t("訊息")}
              </th>
            </tr>
          </thead>
          <tbody>
            {start > 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-1">
                  <button
                    type="button"
                    onClick={showEarlier}
                    title={t("尚有 {start} 筆較早的紀錄未顯示", { start })}
                    className="pressable inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-caption text-action-fg transition-colors duration-(--duration-fast) hover:bg-raised active:bg-sunken active:duration-0"
                  >
                    <ChevronsUp aria-hidden className="size-3.5" />
                    {t("顯示更早的 {min} 筆", { min: Math.min(start, renderCap) })}
                  </button>
                </td>
              </tr>
            ) : null}
            {rows}
          </tbody>
        </table>
        {lines.length === 0 ? empty : null}
      </div>
      {!following && lines.length > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="pressable absolute right-4 bottom-3 z-20 inline-flex h-7 items-center gap-1.5 rounded-full border border-line-control bg-raised px-3 text-caption text-fg shadow-raised transition-colors duration-(--duration-fast) hover:bg-overlay active:bg-sunken active:duration-0 animate-rise-in"
        >
          <ArrowDownToLine aria-hidden className="size-3.5" />
          <T source={"跳到最新{value}"} values={{ value: unseen > 0 ? <span className="text-fg-tertiary">{t("（{unseen} 筆新紀錄）", { unseen })}</span> : null }} />
        </button>
      ) : null}
    </div>
  );
}
