// 手寫 SVG 折線（記憶體取樣）：每個連續段一條 polyline，缺值／取樣間隔過大處斷線，絕不畫 0。
// 單點段以 8px 圓點標出；游標可用滑鼠或方向鍵在取樣時刻間移動，數值同時以 aria-live 告知。
import { memo, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { formatBytes, formatMs } from "@/lib/format";
import { useElementWidth } from "../hooks";
import type { MemoryPoint } from "../model/memory";
import { byteTicks } from "../model/scale";
import { msTicks } from "../model/timeline";
import { t as tr } from "@/i18n";
import { formatList } from "@/i18n/format";

export type SeriesTone = "1" | "2" | "3";

const TONE: Record<SeriesTone, { stroke: string; fill: string; swatch: string }> = {
  "1": { stroke: "stroke-series-1", fill: "fill-series-1", swatch: "bg-series-1" },
  "2": { stroke: "stroke-series-2", fill: "fill-series-2", swatch: "bg-series-2" },
  "3": { stroke: "stroke-series-3", fill: "fill-series-3", swatch: "bg-series-3" },
};

export interface LineSeries {
  key: string;
  label: string;
  tone: SeriesTone;
  segments: MemoryPoint[][];
  samples: ReadonlyArray<{ t: number; v: number | null }>;
}

const MARGIN = { top: 10, right: 16, bottom: 26, left: 72 };

function px(value: number): number {
  return Math.round(value * 10) / 10;
}

function nearestIndex(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo - 1;
  if (prev >= 0 && Math.abs((times[prev] ?? 0) - t) <= Math.abs((times[lo] ?? 0) - t)) return prev;
  return lo;
}

export const LineChart = memo(function LineChart({
  label,
  series,
  times,
  xMax,
  reference,
  height = 168,
}: {
  label: string;
  series: readonly LineSeries[];
  /** 全部取樣時刻（遞增），游標只停在這些時刻。 */
  times: readonly number[];
  xMax: number;
  reference?: { value: number; label: string } | null;
  height?: number;
}) {
  const liveId = useId();
  const [plotRef, width] = useElementWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);

  const maxValue = useMemo(() => {
    let max = reference?.value ?? 0;
    for (const s of series) for (const segment of s.segments) for (const point of segment) max = Math.max(max, point.v);
    return max;
  }, [series, reference]);
  const yAxis = useMemo(() => byteTicks(maxValue), [maxValue]);
  const valueMaps = useMemo(() => series.map((s) => new Map(s.samples.map((sample) => [sample.t, sample.v]))), [series]);

  const innerW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const xEnd = xMax > 0 ? xMax : 1;
  const xOf = (t: number) => MARGIN.left + (t / xEnd) * innerW;
  const yOf = (v: number) => MARGIN.top + innerH - (v / yAxis.max) * innerH;
  const xTicks = msTicks(xEnd, width >= 640 ? 6 : 3);
  const cursorTime = cursor !== null ? times[cursor] : undefined;

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (times.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = ((event.clientX - rect.left - MARGIN.left) / innerW) * xEnd;
    setCursor(nearestIndex(times, t));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (times.length === 0) return;
    const last = times.length - 1;
    const current = cursor ?? -1;
    let next: number | null;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(last, current + 1);
        break;
      case "ArrowLeft":
        next = Math.max(0, current === -1 ? last : current - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Escape":
        next = null;
        break;
      default:
        return;
    }
    event.preventDefault();
    setCursor(next);
  };

  const readout =
    cursorTime !== undefined
      ? series.map((s, index) => {
          const value = valueMaps[index]?.get(cursorTime);
          return { key: s.key, label: s.label, tone: s.tone, text: value === undefined ? tr("此時刻無取樣") : value === null ? tr("缺值") : formatBytes(value) };
        })
      : [];

  return (
    <figure className="m-0 grid min-w-0 gap-1.5">
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={tr("圖例")}>
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <span aria-hidden className={cn("h-0.5 w-4 shrink-0 rounded-full", TONE[s.tone].swatch)} />
              {s.label}
            </li>
          ))}
          {reference ? (
            <li className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <span aria-hidden className="h-0 w-4 shrink-0 border-t border-dashed border-fg-tertiary" />
              {reference.label}
            </li>
          ) : null}
        </ul>
      ) : null}
      <div
        ref={plotRef}
        tabIndex={0}
        role="group"
        aria-label={tr("{label}。方向鍵在取樣時刻間移動游標，Esc 清除", { label })}
        aria-describedby={liveId}
        onKeyDown={onKeyDown}
        onBlur={() => setCursor(null)}
        className="relative min-w-0 rounded-md"
        style={{ height }}
      >
        {width > 0 ? (
          <svg width={width} height={height} aria-hidden="true" className="block" onPointerMove={onPointerMove} onPointerLeave={() => setCursor(null)}>
            {yAxis.ticks.map((tick) => (
              <g key={tick}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={px(yOf(tick)) + 0.5} y2={px(yOf(tick)) + 0.5} className="stroke-line-subtle" />
                <text x={MARGIN.left - 6} y={yOf(tick) + 4} textAnchor="end" className="fill-fg-tertiary text-caption tabular-nums">
                  {yAxis.format(tick)}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <text
                key={tick}
                x={xOf(tick)}
                y={height - 8}
                textAnchor={xOf(tick) < MARGIN.left + 24 ? "start" : xOf(tick) > width - 40 ? "end" : "middle"}
                className="fill-fg-tertiary text-caption tabular-nums"
              >
                {formatMs(tick)}
              </text>
            ))}
            {reference ? (
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={px(yOf(reference.value))}
                y2={px(yOf(reference.value))}
                strokeDasharray="4 4"
                className="stroke-fg-tertiary"
              />
            ) : null}
            {series.map((s) =>
              s.segments.map((segment, index) =>
                segment.length === 1 && segment[0] ? (
                  <circle key={`${s.key}-${index}`} cx={px(xOf(segment[0].t))} cy={px(yOf(segment[0].v))} r={4} className={TONE[s.tone].fill} />
                ) : (
                  <polyline
                    key={`${s.key}-${index}`}
                    points={segment.map((point) => `${px(xOf(point.t))},${px(yOf(point.v))}`).join(" ")}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className={TONE[s.tone].stroke}
                  />
                ),
              ),
            )}
            {cursorTime !== undefined ? (
              <g>
                <line x1={px(xOf(cursorTime))} x2={px(xOf(cursorTime))} y1={MARGIN.top} y2={MARGIN.top + innerH} strokeDasharray="3 3" className="stroke-focus" />
                {series.map((s, index) => {
                  const value = valueMaps[index]?.get(cursorTime);
                  return typeof value === "number" ? (
                    <circle key={s.key} cx={px(xOf(cursorTime))} cy={px(yOf(value))} r={4.5} strokeWidth={2} className={cn(TONE[s.tone].fill, "stroke-sunken")} />
                  ) : null;
                })}
              </g>
            ) : null}
          </svg>
        ) : null}
        {cursorTime !== undefined && width > 0 ? (
          <div
            className="overlay-surface material-popover pointer-events-none absolute top-1 z-10 px-3 py-2 text-caption animate-pop-in"
            style={{ left: px(Math.min(Math.max(0, xOf(cursorTime) + 12), Math.max(0, width - 220))), width: 208 }}
          >
            <p className="machine text-fg-secondary">t = {formatMs(cursorTime)}</p>
            <ul className="mt-1 grid gap-0.5">
              {readout.map((row) => (
                <li key={row.key} className="flex items-baseline gap-2">
                  <span aria-hidden className={cn("h-0.5 w-3 shrink-0 self-center rounded-full", TONE[row.tone].swatch)} />
                  <span className="text-fg-tertiary">{row.label}</span>
                  <span className="machine ml-auto text-fg">{row.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p id={liveId} className="sr-only" aria-live="polite">
          {cursorTime !== undefined ? tr("t {cursorTime}：{map}", { cursorTime: formatMs(cursorTime), map: formatList(readout.map((row) => `${row.label} ${row.text}`), { separator: "，" }) }) : ""}
        </p>
      </div>
    </figure>
  );
});
