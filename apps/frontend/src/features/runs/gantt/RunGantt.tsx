// run 甘特圖（Bridge「Pipeline Stages」的對應）：左側泳道標籤（Node · 資源群組），右側實測步驟條（可水平捲動）。
// 只畫有 started_at 的步驟；沒有的列在下方「未開始／未量測」。條是可聚焦按鈕：←/→ 依時間前後、↑/↓ 換泳道、
// Home/End、Enter 選取、Esc 取消。顏色依元件類型（provider kind），狀態另有圖示與文字（失敗＝紅框＋「失敗」）。
import { Ban, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { StatusBadge } from "@/components/common/StatusBadge";
import { StatusChip } from "@/components/workbench/StatusChip";
import { BORDER_TONE, TILE_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { useMeasuredElement } from "@/lib/useElementSize";
import { buildGanttModel, describeBar, formatDurationShort, type GanttBar, type RunGanttProps } from "./ganttModel";
import { t, tServer } from "@/i18n";
import { T } from "@/i18n/T";

const AXIS_H = 28;
const ROW_H = 30;
const BAR_H = 22;
const LANE_PAD = 4;
const PAD_X = 12;
/** 每秒至少幾 px：長 run 超出寬度時改為水平捲動，而不是把短步驟壓成看不見。 */
const MIN_PX_PER_S = 6;
const MIN_PLOT_W = 240;
const MIN_BAR_W = 3;
/** 11 px mono 的字寬估計（判斷標籤放不放得下）。 */
const CHAR_W = 6.8;

function px(value: number): number {
  return Math.round(value * 10) / 10;
}

function hasStateIcon(bar: GanttBar): boolean {
  return bar.running || bar.state === "failed" || bar.state === "cancelled" || bar.state === "interrupted" || bar.remoteOutcomeUnknown;
}

function StateIcon({ bar }: { bar: GanttBar }) {
  if (bar.running) return <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin" />;
  if (bar.state === "failed") return <CircleX aria-hidden className="size-3 shrink-0 text-danger" />;
  if (bar.state === "cancelled") return <Ban aria-hidden className="size-3 shrink-0" />;
  if (bar.state === "interrupted" || bar.remoteOutcomeUnknown) return <TriangleAlert aria-hidden className="size-3 shrink-0 text-warning" />;
  return null;
}

function barTitle(bar: GanttBar, description: string): string {
  const lines = [description, t("開始 {startedAt}", { startedAt: formatTimestamp(bar.startedAt) }), bar.running ? t("結束 —（進行中）") : t("結束 {finishedAt}", { finishedAt: formatTimestamp(bar.finishedAt) })];
  if (bar.componentId != null && bar.componentId !== "") lines.push(t("元件 {componentId}（{kindLabel}）", { componentId: bar.componentId, kindLabel: bar.kindLabel }));
  if (bar.errorMessage != null && bar.errorMessage !== "") lines.push(tServer(bar.errorMessage));
  return lines.join("\n");
}

/**
 * 加上品牌 utility（漸層光邊、淡漸層底）：放在 cn() 之外，因為 tailwind-merge 會把 border-brand-gradient／bg-brand-gradient-soft
 * 誤當成邊框色／底色而互相合併掉（類型框色、類型底色都要保留）。
 */
function withBrand(base: string, ...extra: (string | false)[]): string {
  return [base, ...extra.filter(Boolean)].join(" ");
}

export function RunGantt({ run, lookup, selectedStepId, onSelectStep, now, nodeLabel, className }: RunGanttProps) {
  const captionId = useId();
  const model = useMemo(() => buildGanttModel(run, lookup, now, { ...(nodeLabel === undefined ? {} : { nodeLabel }) }), [run, lookup, now, nodeLabel]);
  const [setScroller, , size] = useMeasuredElement<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const barRefsRef = useRef(new Map<string, HTMLButtonElement>());
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [tabKey, setTabKey] = useState<string | null>(null);

  // 選取改變（例如在 DAG 點選）時，把該條捲進可見範圍（只捲這個元件的水平捲動；輪詢更新不會把畫面拉回）。
  useEffect(() => {
    const scroller = scrollRef.current;
    const bar = selectedStepId !== null ? barRefsRef.current.get(selectedStepId) : undefined;
    if (!scroller || !bar) return;
    const left = bar.offsetLeft;
    const right = left + bar.offsetWidth;
    if (left < scroller.scrollLeft + 8) scroller.scrollLeft = Math.max(0, left - 24);
    else if (right > scroller.scrollLeft + scroller.clientWidth - 8) scroller.scrollLeft = right - scroller.clientWidth + 24;
  }, [selectedStepId]);

  const laneTops: number[] = [];
  let height = AXIS_H;
  for (const lane of model.lanes) {
    laneTops.push(height);
    height += lane.rows * ROW_H + LANE_PAD * 2;
  }
  const laneIndex = new Map(model.lanes.map((lane, index) => [lane.key, index]));
  const width = Math.max(size.width, Math.ceil((model.axisEndMs / 1000) * MIN_PX_PER_S) + PAD_X * 2, MIN_PLOT_W);
  const plotW = width - PAD_X * 2;
  const xOf = (ms: number) => PAD_X + (Math.min(Math.max(ms, 0), model.axisEndMs) / model.axisEndMs) * plotW;
  const order = model.bars;
  const position = new Map(order.map((bar, index) => [bar.stepId, index]));
  const tabStop = (tabKey !== null && position.has(tabKey) ? tabKey : null) ?? (selectedStepId !== null && position.has(selectedStepId) ? selectedStepId : null) ?? order[0]?.stepId ?? null;

  const kinds = [...new Map(order.map((bar) => [`${bar.tone}␟${bar.kindLabel}`, bar])).values()];
  const anyFailed = order.some((bar) => bar.state === "failed");
  const anyRunning = order.some((bar) => bar.running);

  const focusBar = (bar: GanttBar | undefined) => {
    if (bar) barRefsRef.current.get(bar.stepId)?.focus();
  };
  const nearestInLane = (bar: GanttBar, direction: 1 | -1): GanttBar | undefined => {
    const from = laneIndex.get(bar.laneKey) ?? 0;
    for (let index = from + direction; index >= 0 && index < model.lanes.length; index += direction) {
      const bars = model.lanes[index]?.bars ?? [];
      if (bars.length === 0) continue;
      return bars.reduce((best, candidate) => (Math.abs(candidate.startMs - bar.startMs) < Math.abs(best.startMs - bar.startMs) ? candidate : best));
    }
    return undefined;
  };
  const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, bar: GanttBar) => {
    const index = position.get(bar.stepId) ?? 0;
    switch (event.key) {
      case "ArrowRight":
        focusBar(order[index + 1]);
        break;
      case "ArrowLeft":
        focusBar(order[index - 1]);
        break;
      case "ArrowDown":
        focusBar(nearestInLane(bar, 1));
        break;
      case "ArrowUp":
        focusBar(nearestInLane(bar, -1));
        break;
      case "Home":
        focusBar(order[0]);
        break;
      case "End":
        focusBar(order.at(-1));
        break;
      case "Escape":
        if (selectedStepId === null) return;
        onSelectStep(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const activeId = hovered ?? focused ?? selectedStepId;
  const activeBar = activeId !== null ? order.find((bar) => bar.stepId === activeId) : undefined;
  const activeMissing = activeId !== null && !activeBar ? model.unmeasured.find((item) => item.stepId === activeId) : undefined;

  if (order.length === 0 && model.unmeasured.length === 0) {
    return <p className={cn("text-data text-fg-tertiary", className)}>{t("此 run 沒有步驟。")}</p>;
  }

  return (
    <figure className={cn("m-0 grid min-w-0 gap-2", className)}>
      {order.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label={t("圖例")}>
          {kinds.map((bar) => (
            <li key={`${bar.tone}-${bar.kindLabel}`} className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <span aria-hidden className={cn("h-2.5 w-3.5 shrink-0 rounded-[2px] border", TILE_TONE[bar.tone], BORDER_TONE[bar.tone])} />
              {bar.kindLabel}
            </li>
          ))}
          {anyFailed ? (
            <li className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <CircleX aria-hidden className="size-3.5 text-danger" />
              {t("失敗（紅框）")}
            </li>
          ) : null}
          {anyRunning ? (
            <li className="flex items-center gap-1.5 text-caption text-fg-secondary">
              <span aria-hidden className="h-2.5 w-3.5 shrink-0 rounded-[2px] border border-dashed border-line-control bg-brand-gradient-soft" />
              {t("進行中（虛線框，延伸到現在）")}
            </li>
          ) : null}
        </ul>
      ) : null}

      {order.length > 0 ? (
        <div className="flex min-w-0 overflow-hidden rounded-lg border border-line-subtle bg-sunken">
          <div className="w-40 shrink-0 border-r border-line-subtle bg-surface">
            <div className="flex items-end px-2 pb-1 text-[11px] text-fg-tertiary" style={{ height: AXIS_H }}>
              {t("Node · 資源群組")}
            </div>
            {model.lanes.map((lane) => (
              <div
                key={lane.key}
                className="flex flex-col justify-center border-t border-line-subtle px-2"
                style={{ height: lane.rows * ROW_H + LANE_PAD * 2 }}
                title={`${lane.label}${lane.groupSource === "catalog" ? t("\nresource_group 取自目前目錄（run 沒有記錄當時的 device）") : lane.groupSource === null ? t("\n無法得知 resource_group") : ""}`}
              >
                <span className={cn("machine truncate text-data", (lane.resourceGroup != null && lane.resourceGroup !== "") ? "text-fg" : "text-fg-tertiary")}>{lane.resourceGroup ?? t("資源群組未知")}</span>
                <span className="truncate text-caption text-fg-tertiary">{lane.nodeLabel}</span>
              </div>
            ))}
          </div>
          <div
            ref={(element) => {
              scrollRef.current = element;
              setScroller(element);
            }}
            className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          >
            <div className="relative" style={{ width, height }} role="group" aria-label={t("步驟時間軸")} aria-describedby={captionId}>
              <svg aria-hidden width={width} height={height} className="absolute inset-0">
                {model.ticks.map((tick) => {
                  const x = Math.round(xOf(tick.ms)) + 0.5;
                  const anchor = x < 24 ? "start" : x > width - 24 ? "end" : "middle";
                  return (
                    <g key={tick.ms}>
                      <line x1={x} x2={x} y1={AXIS_H - 6} y2={height} className="stroke-line-subtle" />
                      <text x={x} y={AXIS_H - 10} textAnchor={anchor} className="machine fill-fg-tertiary text-[11px]">
                        {tick.label}
                      </text>
                    </g>
                  );
                })}
                {laneTops.map((top) => (
                  <line key={top} x1={0} x2={width} y1={top + 0.5} y2={top + 0.5} className="stroke-line-subtle" />
                ))}
                {model.nowMs !== null ? (
                  <line x1={px(xOf(model.nowMs))} x2={px(xOf(model.nowMs))} y1={AXIS_H - 6} y2={height} strokeDasharray="3 3" className="stroke-brand-cyan" />
                ) : null}
              </svg>
              {order.map((bar) => {
                const lane = model.lanes[laneIndex.get(bar.laneKey) ?? 0];
                const top = (laneTops[laneIndex.get(bar.laneKey) ?? 0] ?? AXIS_H) + LANE_PAD + bar.row * ROW_H + (ROW_H - BAR_H) / 2;
                const x0 = xOf(bar.startMs);
                const w = Math.max(MIN_BAR_W, xOf(bar.endMs) - x0);
                const duration = bar.elapsedUnknown ? "" : formatDurationShort(bar.durationMs);
                const iconW = hasStateIcon(bar) ? 16 : 0;
                const fitsFull = (bar.stepId.length + duration.length + 1) * CHAR_W + 12 + iconW <= w;
                const fitsId = bar.stepId.length * CHAR_W + 12 + iconW <= w;
                const description = describeBar(bar, lane);
                const selected = bar.stepId === selectedStepId;
                return (
                  <button
                    key={bar.stepId}
                    ref={(element) => {
                      if (element) barRefsRef.current.set(bar.stepId, element);
                      else barRefsRef.current.delete(bar.stepId);
                    }}
                    type="button"
                    tabIndex={bar.stepId === tabStop ? 0 : -1}
                    aria-pressed={selected}
                    aria-label={description}
                    title={barTitle(bar, description)}
                    onClick={() => { onSelectStep(bar.stepId); }}
                    onKeyDown={(event) => { onBarKeyDown(event, bar); }}
                    onFocus={() => {
                      setTabKey(bar.stepId);
                      setFocused(bar.stepId);
                    }}
                    onBlur={() => { setFocused((current) => (current === bar.stepId ? null : current)); }}
                    onPointerEnter={() => { setHovered(bar.stepId); }}
                    onPointerLeave={() => { setHovered((current) => (current === bar.stepId ? null : current)); }}
                    className={withBrand(
                      cn(
                        "absolute flex cursor-pointer items-center gap-1 overflow-hidden rounded-sm border px-1.5 text-left text-[11px] leading-none whitespace-nowrap transition-[background-color,border-color,box-shadow] duration-(--duration-fast)",
                        TILE_TONE[bar.tone],
                        BORDER_TONE[bar.tone],
                        bar.running && "border-dashed",
                        bar.state === "interrupted" && "border-warning",
                        bar.state === "failed" && "border-danger",
                        selected ? "shadow-glow-sm" : "hover:ring-1 hover:ring-line-control",
                      ),
                      // 進行中：類型色底上疊品牌淡漸層並掃過 shimmer（生成中）；選取：1 px 品牌漸層光邊（保留類型／失敗框色）。
                      bar.running && "bg-brand-gradient-soft animate-shimmer",
                      selected && "border-brand-gradient absolute!",
                    )}
                    style={{ left: px(x0), top, width: px(w), height: BAR_H }}
                  >
                    {w >= 14 ? <StateIcon bar={bar} /> : null}
                    {fitsId ? <span className="machine truncate font-medium text-fg">{bar.stepId}</span> : null}
                    {fitsFull && duration ? <span className="machine shrink-0 text-fg-secondary">{duration}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong bg-sunken px-3 py-4 text-data text-fg-tertiary">{t("沒有可畫的實測時間：還沒有步驟開始執行。")}</p>
      )}

      <p className="min-h-[18px] text-caption text-fg-secondary">
        {activeBar ? (
          <>
            <span className="machine text-fg">{activeBar.stepId}</span>
            {" · "}
            {describeBar(activeBar, model.lanes[laneIndex.get(activeBar.laneKey) ?? 0], { withStep: false })}
            {t(" · 開始 ")}
            <span className="machine">{formatTimestamp(activeBar.startedAt)}</span>
          </>
        ) : activeMissing ? (
          <>
            <span className="machine text-fg">{activeMissing.stepId}</span>
            {` · ${activeMissing.reason}`}
          </>
        ) : order.length > 0 ? (
          <span className="text-fg-tertiary">{t("指向或聚焦步驟條以檢視起訖時間；Enter 或點選以選取。")}</span>
        ) : null}
      </p>

      {model.unmeasured.length > 0 ? (
        <div className="grid gap-1.5">
          <p className="text-caption font-semibold text-fg-secondary">
            <T source={"未開始／未量測（{unmeasuredCount}）<0>：沒有實測起訖時間，不畫在時間軸上</0>"} values={{ unmeasuredCount: model.unmeasured.length }} slots={[<span key="slot-0" className="font-normal text-fg-tertiary" />]} />
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {model.unmeasured.map((item) => {
              const selected = item.stepId === selectedStepId;
              return (
                <li key={item.stepId}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => { onSelectStep(item.stepId); }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && selectedStepId !== null) {
                        event.preventDefault();
                        onSelectStep(null);
                      }
                    }}
                    className={cn(
                      "pressable inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-dashed border-line-strong bg-surface px-2 text-left text-caption text-fg-secondary transition-[background-color,border-color] duration-(--duration-fast) hover:bg-raised active:bg-sunken active:duration-0",
                      selected && "border-brand-blue/60 bg-brand-gradient-soft text-fg",
                    )}
                  >
                    <span className="machine text-fg">{item.stepId}</span>
                    {item.state === "unknown" ? <StatusChip tone="neutral" label={t("狀態未知")} /> : <StatusBadge kind="step" value={item.state} />}
                    <span className="truncate text-fg-tertiary">{item.reason}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <figcaption id={captionId} className="text-caption text-fg-tertiary">
        {t("0＝run 建立時刻（created_at{value}{value2}）；條＝步驟 started_at → finished_at（主控記錄的時戳），泳道依 Node 與 resource_group 分組。{value3}方向鍵在步驟間移動，Enter 選取，Esc 取消選取。", { value: (model.originIso != null && model.originIso !== "") ? ` ${formatTimestamp(model.originIso)}` : "", value2: model.originSource === "first_start" ? t("；created_at 無法解析，改用最早的 started_at") : "", value3: anyRunning ? t("進行中的條延伸到現在（瀏覽器時鐘，與主控時鐘可能有偏差）。") : "" })}
      </figcaption>
    </figure>
  );
}
