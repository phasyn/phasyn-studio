// 手寫 SVG 泳道圖：一個 clock domain（或 trace 時鐘）一張圖，時間以該組第一個事件為 0。
// 項目是 roving-tabindex 的按鈕：←/→ 同泳道前後、↑/↓ 換泳道（取時間最近者）、Home/End、Enter 選取、Esc 關閉提示。
// hover 與鍵盤焦點顯示同一份提示；沒有動畫。
import { memo, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { formatMs } from "@/lib/format";
import { useElementWidth } from "../hooks";
import { msTicks, type ChartCategory, type ChartGroup, type ChartItem, type ChartLane } from "../model/timeline";
import { t } from "@/i18n";

/** 類別外觀：series tokens（固定順序，CVD 已驗證）；狀態色只用於警告／錯誤記錄。 */
const PAINT: Record<ChartCategory, { fill: string; swatch: string; label: string }> = {
  phase: { fill: "fill-series-1", swatch: "bg-series-1", label: t("phase／part span") },
  step: { fill: "fill-series-2", swatch: "bg-series-2", label: "step span" },
  copy: { fill: "fill-series-3", swatch: "bg-series-3", label: "copy span" },
  step_event: { fill: "fill-series-2", swatch: "bg-series-2", label: t("step 事件（刻度）") },
  transfer_event: { fill: "fill-series-3", swatch: "bg-series-3", label: t("transfer 事件（刻度）") },
  log_warning: { fill: "fill-warning", swatch: "bg-warning", label: t("警告記錄") },
  log_error: { fill: "fill-danger", swatch: "bg-danger", label: t("錯誤記錄") },
  kernel: { fill: "fill-series-1", swatch: "bg-series-1", label: "kernel" },
  memcpy: { fill: "fill-series-3", swatch: "bg-series-3", label: "memcpy" },
  memset: { fill: "fill-series-neutral", swatch: "bg-series-neutral", label: "memset" },
};

const MARKER = new Set<ChartCategory>(["step_event", "transfer_event", "log_warning", "log_error"]);
const ROW_H = 18;
const BAR_H = 12;
const LANE_PAD = 6;
const AXIS_H = 26;
const PAD_X = 10;
const MIN_BAR_PX = 2;
const MAX_ROWS = 12;
const TOOLTIP_W = 320;

function px(value: number): number {
  return Math.round(value * 10) / 10;
}

interface Windowed {
  lanes: ChartLane[];
  endMs: number;
  drawn: number;
  total: number;
  windowed: boolean;
}

/** 項目過多時只畫最早的一段時間窗（軸也縮到該窗），而不是任意抽樣或留下看似空白的尾段。 */
function windowLanes(group: ChartGroup, maxItems: number): Windowed {
  const total = group.lanes.reduce((sum, lane) => sum + lane.items.length, 0);
  if (total <= maxItems) return { lanes: group.lanes, endMs: group.endMs, drawn: total, total, windowed: false };
  const starts = group.lanes.flatMap((lane) => lane.items.map((item) => item.startMs)).sort((a, b) => a - b);
  const cut = starts[maxItems] ?? group.endMs;
  const lanes = group.lanes.map((lane) => ({ ...lane, items: lane.items.filter((item) => item.startMs < cut || cut === 0) }));
  const drawn = lanes.reduce((sum, lane) => sum + lane.items.length, 0);
  return { lanes, endMs: cut > 0 ? cut : group.endMs, drawn, total, windowed: true };
}

function itemLabel(item: ChartItem): string {
  const time = item.endMs === null ? t("記錄時刻 {startMs}", { startMs: formatMs(item.startMs) }) : t("開始 {startMs}，長度 {endMs}", { startMs: formatMs(item.startMs), endMs: formatMs(item.endMs - item.startMs) });
  return t("{label}：{label2}；{time}", { label: PAINT[item.category].label, label2: item.label, time });
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

export const TimelineChart = memo(function TimelineChart({
  group,
  label,
  selectedKey,
  onSelect,
  maxItems = 4000,
}: {
  group: ChartGroup;
  label: string;
  selectedKey: string | null;
  onSelect?: (item: ChartItem) => void;
  maxItems?: number;
}) {
  const tooltipId = useId();
  const [plotRef, width] = useElementWidth();
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [tabKey, setTabKey] = useState<string | null>(null);
  const itemRefsRef = useRef(new Map<string, SVGGElement>());

  const view = useMemo(() => windowLanes(group, maxItems), [group, maxItems]);
  const layout = useMemo(() => {
    let y = AXIS_H;
    return view.lanes.map((lane) => {
      const rows = Math.min(MAX_ROWS, Math.max(1, lane.rows));
      const height = rows * ROW_H + LANE_PAD * 2;
      const entry = { lane, y, height, rows };
      y += height;
      return entry;
    });
  }, [view]);
  const positions = useMemo(() => {
    const map = new Map<string, { lane: number; index: number }>();
    view.lanes.forEach((lane, laneIndex) => { lane.items.forEach((item, index) => void map.set(item.key, { lane: laneIndex, index })); });
    return map;
  }, [view]);
  const categories = useMemo(() => {
    const present = new Set(view.lanes.flatMap((lane) => lane.items.map((item) => item.category)));
    return Object.keys(PAINT).filter((category): category is ChartCategory => Object.hasOwn(PAINT, category)).filter((category) => present.has(category));
  }, [view]);

  const height = (layout.at(-1)?.y ?? AXIS_H) + (layout.at(-1)?.height ?? 0);
  const endMs = view.endMs > 0 ? view.endMs : 1;
  const plotW = Math.max(1, width - PAD_X * 2);
  const xOf = (ms: number) => PAD_X + (Math.min(ms, endMs) / endMs) * plotW;
  const ticks = msTicks(endMs, width >= 720 ? 8 : width >= 420 ? 5 : 3);
  const firstKey = view.lanes.find((lane) => lane.items.length > 0)?.items[0]?.key ?? null;
  const tabStop = (tabKey !== null && positions.has(tabKey) ? tabKey : null) ?? (selectedKey !== null && positions.has(selectedKey) ? selectedKey : null) ?? firstKey;
  const active = hovered ?? focused;
  const tipKey = active !== null && active !== dismissed ? active : null;

  const yOf = (laneIndex: number, row: number) => {
    const entry = layout[laneIndex];
    if (!entry) return 0;
    return entry.y + LANE_PAD + Math.min(row, entry.rows - 1) * ROW_H + (ROW_H - BAR_H) / 2;
  };

  const moveTo = (laneIndex: number, index: number) => {
    const lane = view.lanes[laneIndex];
    const item = lane?.items[Math.min(lane.items.length - 1, Math.max(0, index))];
    if (!item) return;
    setTabKey(item.key);
    itemRefsRef.current.get(item.key)?.focus();
  };

  const moveLane = (fromLane: number, direction: 1 | -1, atMs: number) => {
    for (let laneIndex = fromLane + direction; laneIndex >= 0 && laneIndex < view.lanes.length; laneIndex += direction) {
      const items = view.lanes[laneIndex]?.items ?? [];
      if (items.length === 0) continue;
      let best = 0;
      items.forEach((item, index) => {
        const current = items[best];
        if (current && Math.abs(item.startMs - atMs) < Math.abs(current.startMs - atMs)) best = index;
      });
      moveTo(laneIndex, best);
      return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<SVGGElement>, item: ChartItem) => {
    const position = positions.get(item.key);
    if (!position) return;
    const laneItems = view.lanes[position.lane]?.items ?? [];
    switch (event.key) {
      case "ArrowRight":
        moveTo(position.lane, position.index + 1);
        break;
      case "ArrowLeft":
        moveTo(position.lane, position.index - 1);
        break;
      case "ArrowDown":
        moveLane(position.lane, 1, item.startMs);
        break;
      case "ArrowUp":
        moveLane(position.lane, -1, item.startMs);
        break;
      case "Home":
        moveTo(position.lane, 0);
        break;
      case "End":
        moveTo(position.lane, laneItems.length - 1);
        break;
      case "Enter":
      case " ":
        onSelect?.(item);
        break;
      case "Escape":
        setDismissed(item.key);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onFocus = (event: FocusEvent<SVGGElement>, item: ChartItem) => {
    setTabKey(item.key);
    setDismissed(null);
    if (focusVisible(event.currentTarget)) setFocused(item.key);
  };

  const tipPosition = tipKey !== null ? positions.get(tipKey) : undefined;
  const tipItem = tipPosition ? view.lanes[tipPosition.lane]?.items[tipPosition.index] : undefined;

  return (
    <figure className="m-0 grid min-w-0 gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t("圖例")}>
        {categories.map((category) => (
          <li key={category} className="flex items-center gap-1.5 text-caption text-fg-secondary">
            <span
              aria-hidden
              className={cn("shrink-0", PAINT[category].swatch, MARKER.has(category) ? "size-2.5 rotate-45 rounded-[1px]" : "h-2.5 w-3.5 rounded-[2px]")}
            />
            {PAINT[category].label}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] md:grid-cols-[11rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <div style={{ height: AXIS_H }} className="flex items-end pb-1 text-caption text-fg-tertiary">
            {t("泳道")}
          </div>
          {layout.map(({ lane, height: laneHeight }) => (
            <div key={lane.key} style={{ height: laneHeight }} className="flex min-w-0 flex-col justify-center border-t border-line-subtle pr-2">
              <span className="truncate text-data text-fg" title={lane.label}>
                {lane.label}
              </span>
              {(lane.caption != null && lane.caption !== "") ? <span className="truncate text-caption text-fg-tertiary">{lane.caption}</span> : null}
            </div>
          ))}
        </div>
        <div ref={plotRef} className="relative min-w-0" style={{ height }}>
          {width > 0 ? (
            <svg width={width} height={height} role="group" aria-label={label} className="block">
              <g aria-hidden="true">
                {ticks.map((tick) => {
                  const x = Math.round(xOf(tick)) + 0.5;
                  const anchor = x < 36 ? "start" : x > width - 36 ? "end" : "middle";
                  return (
                    <g key={tick}>
                      <line x1={x} x2={x} y1={AXIS_H - 6} y2={height} className="stroke-line-subtle" />
                      <text x={x} y={AXIS_H - 10} textAnchor={anchor} className="fill-fg-tertiary text-caption tabular-nums">
                        {formatMs(tick)}
                      </text>
                    </g>
                  );
                })}
                {layout.map(({ lane, y }) => (
                  <line key={lane.key} x1={0} x2={width} y1={y + 0.5} y2={y + 0.5} className="stroke-line-subtle" />
                ))}
                <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-line-subtle" />
              </g>
              {view.lanes.map((lane, laneIndex) =>
                lane.items.map((item) => {
                  const y = yOf(laneIndex, item.row);
                  const x0 = xOf(item.startMs);
                  const marker = item.endMs === null;
                  const x1 = marker ? x0 : Math.max(xOf(item.endMs ?? item.startMs), x0 + MIN_BAR_PX);
                  const selected = item.key === selectedKey;
                  const highlighted = item.key === hovered || item.key === focused;
                  const paint = PAINT[item.category];
                  const cy = y + BAR_H / 2;
                  return (
                    <g
                      key={item.key}
                      ref={(node) => {
                        if (node) itemRefsRef.current.set(item.key, node);
                        else itemRefsRef.current.delete(item.key);
                      }}
                      role="button"
                      tabIndex={item.key === tabStop ? 0 : -1}
                      aria-label={itemLabel(item)}
                      aria-pressed={selected}
                      aria-describedby={tipKey === item.key ? tooltipId : undefined}
                      className="cursor-pointer outline-none"
                      onClick={() => onSelect?.(item)}
                      onKeyDown={(event) => { onKeyDown(event, item); }}
                      onFocus={(event) => { onFocus(event, item); }}
                      onBlur={() => { setFocused((current) => (current === item.key ? null : current)); }}
                      onPointerEnter={() => {
                        setHovered(item.key);
                        setDismissed(null);
                      }}
                      onPointerLeave={() => { setHovered((current) => (current === item.key ? null : current)); }}
                    >
                      <rect x={px(x0 - 5)} y={y - 3} width={px(Math.max(x1 - x0 + 10, 12))} height={BAR_H + 6} fill="transparent" />
                      {marker ? (
                        <path
                          d={`M ${String(px(x0))} ${String(px(cy - 5))} L ${String(px(x0 + 5))} ${String(px(cy))} L ${String(px(x0))} ${String(px(cy + 5))} L ${String(px(x0 - 5))} ${String(px(cy))} Z`}
                          className={paint.fill}
                        />
                      ) : (
                        <rect x={px(x0)} y={y} width={px(x1 - x0)} height={BAR_H} rx={2} className={paint.fill} />
                      )}
                      {selected || highlighted ? (
                        // 選取＝品牌青框＋淡底帶（目前項目）；指向／鍵盤焦點＝焦點色粗框。都不是資料系列色。
                        marker ? (
                          <circle
                            cx={px(x0)}
                            cy={px(cy)}
                            r={8}
                            strokeWidth={highlighted ? 2 : 1.5}
                            className={cn(selected ? "fill-brand-cyan/15" : "fill-none", highlighted ? "stroke-focus" : "stroke-brand-cyan")}
                          />
                        ) : (
                          <rect
                            x={px(x0 - 2.5)}
                            y={y - 2.5}
                            width={px(x1 - x0 + 5)}
                            height={BAR_H + 5}
                            rx={3}
                            strokeWidth={highlighted ? 2 : 1.5}
                            className={cn(selected ? "fill-brand-cyan/15" : "fill-none", highlighted ? "stroke-focus" : "stroke-brand-cyan")}
                          />
                        )
                      ) : null}
                    </g>
                  );
                }),
              )}
            </svg>
          ) : null}
          {tipItem && tipPosition && width > 0 ? (
            <div
              id={tooltipId}
              role="tooltip"
              className="overlay-surface material-popover pointer-events-none absolute z-10 px-3 py-2 text-caption animate-pop-in"
              style={{
                width: Math.min(TOOLTIP_W, width),
                left: px(Math.min(Math.max(0, xOf(tipItem.startMs) - 12), Math.max(0, width - TOOLTIP_W))),
                top: yOf(tipPosition.lane, tipItem.row) + BAR_H + 8,
              }}
            >
              <p className="text-data font-semibold break-words text-fg">{tipItem.label}</p>
              <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                {tipItem.details.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-fg-tertiary">{key}</dt>
                    <dd className="m-0 machine break-words text-fg-secondary">{value}</dd>
                  </div>
                ))}
              </dl>
              {onSelect ? <p className="mt-1.5 text-fg-tertiary">{t("按 Enter 或點選：在右側檢視器檢視")}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
      <figcaption className="grid gap-1 text-caption text-fg-tertiary">
        <p>
          {t("時間 0 是此時鐘域內第一個已繪製事件，全長 {endMs}。實心條＝有起訖 monotonic ns 的 span；菱形＝事件記錄時刻（沒有起點欄位，不推算區間）。 方向鍵在項目間移動，Enter 選取。", { endMs: formatMs(view.endMs) })}
        </p>
        {view.windowed ? (
          <p className="text-warning">
            {t("項目共 {total} 個，只繪製最早的 {drawn} 個（0–{endMs}）；完整清單請用表格檢視。", { total: view.total.toLocaleString("en-US"), drawn: view.drawn.toLocaleString("en-US"), endMs: formatMs(view.endMs) })}
          </p>
        ) : null}
        {layout.some((entry) => entry.lane.rows > MAX_ROWS) ? <p>{t("重疊超過 {maxRows} 層的區間疊畫在最後一列，細節見提示與表格。", { maxRows: MAX_ROWS })}</p> : null}
      </figcaption>
    </figure>
  );
});
